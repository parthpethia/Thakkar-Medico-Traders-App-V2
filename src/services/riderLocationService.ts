/**
 * Rider Location Broadcasting Service
 *
 * Manages per-order GPS tracking for active deliveries:
 * - Uses expo-location watchPositionAsync for high-accuracy updates
 * - Adaptive location update frequency based on battery level (expo-battery)
 * - Dual-writes to delivery_tracking (upsert latest) and delivery_location_history (append breadcrumb)
 * - Also updates driver_locations for fleet map compatibility
 * - Auto-stops after 30 minutes to conserve battery
 */
import * as Location from 'expo-location';
import * as Battery from 'expo-battery';
import { supabase } from './supabase';
import { THAKKAR_MEDICO } from './routesApiService';

export { THAKKAR_MEDICO };

export const THAKKAR_MEDICO_LOCATION = {
  lat: THAKKAR_MEDICO.lat,
  lng: THAKKAR_MEDICO.lng,
  name: THAKKAR_MEDICO.name,
  address: THAKKAR_MEDICO.address,
} as const;

// Internal tracking state
let watchSubscription: Location.LocationSubscription | null = null;
let batterySubscription: Battery.Subscription | null = null;
let currentOrderId: string | null = null;
let currentUserId: string | null = null;
let currentBatteryLevel: number | null = null;
let activityCheckInterval: ReturnType<typeof setInterval> | null = null;

// Motion-Aware Activity State
let lastKnownLat: number | null = null;
let lastKnownLng: number | null = null;
let lastMotionTimestamp: number = Date.now();
let isBroadcastingPaused = false;

/** Stationary timeout (30 minutes of zero movement before battery safety pause) */
const STATIONARY_PAUSE_MS = 30 * 60 * 1000;

/** Haversine distance in meters */
function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Adaptive location update frequency based on battery level:
 * - Battery < 15%: 10s / 20m (power saver)
 * - Normal: 4s / 10m
 */
export function getLocationConfig(batteryLevel: number | null): {
  timeInterval: number;
  distanceInterval: number;
} {
  if (batteryLevel !== null && batteryLevel < 15) {
    // Battery critical — reduce frequency to save power
    return { timeInterval: 10000, distanceInterval: 20 }; // 10s / 20m
  }
  return { timeInterval: 4000, distanceInterval: 10 }; // normal: 4s / 10m
}

/**
 * Request foreground + background location permissions.
 * Returns true if at least foreground permission was granted.
 */
export async function requestLocationPermissions(): Promise<boolean> {
  const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
  if (fgStatus !== 'granted') return false;

  try {
    await Location.requestBackgroundPermissionsAsync();
  } catch {
    // Background permission may be denied — foreground tracking still works
  }

  return true;
}

/**
 * Start broadcasting rider location for a specific order.
 * Outstation-safe: Renews continuously while in motion, regardless of total trip duration.
 *
 * @param orderId The order being delivered
 * @param userId The authenticated rider's user ID
 */
export async function startOrderTracking(
  orderId: string,
  userId: string,
): Promise<{ success: boolean; error?: string }> {
  // Stop any existing tracking first
  await stopOrderTracking();

  const hasPermission = await requestLocationPermissions();
  if (!hasPermission) {
    return { success: false, error: 'Location permission not granted' };
  }

  currentOrderId = orderId;
  currentUserId = userId;
  lastMotionTimestamp = Date.now();
  lastKnownLat = null;
  lastKnownLng = null;
  isBroadcastingPaused = false;

  // Initialize battery level tracking
  try {
    const rawBattery = await Battery.getBatteryLevelAsync();
    if (rawBattery >= 0) {
      currentBatteryLevel = Math.round(rawBattery * 100);
    }
  } catch {
    currentBatteryLevel = null;
  }

  try {
    batterySubscription = Battery.addBatteryLevelListener(({ batteryLevel }) => {
      if (batteryLevel >= 0) {
        currentBatteryLevel = Math.round(batteryLevel * 100);
      }
    });
  } catch {
    // Battery listener unsupported in some environments
  }

  const locConfig = getLocationConfig(currentBatteryLevel);

  try {
    watchSubscription = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.High,
        timeInterval: locConfig.timeInterval,
        distanceInterval: locConfig.distanceInterval,
      },
      (location) => {
        void handleLocationUpdate(location);
      },
    );

    // Periodic motion & activity heartbeat check (every 60 seconds)
    activityCheckInterval = setInterval(() => {
      void checkMotionHeartbeat();
    }, 60000);

    // Update order delivery_status to in_transit
    await supabase
      .from('orders')
      .update({
        delivery_status: 'in_transit',
        dispatched_at: new Date().toISOString(),
      })
      .eq('id', orderId);

    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to start location tracking';
    return { success: false, error: msg };
  }
}

/**
 * Checks motion heartbeat: if stationary for >30m, safely pauses broadcast.
 */
async function checkMotionHeartbeat(): Promise<void> {
  if (!currentOrderId || !currentUserId) return;

  const now = Date.now();
  const stationaryDuration = now - lastMotionTimestamp;

  if (stationaryDuration > STATIONARY_PAUSE_MS && !isBroadcastingPaused) {
    console.log('[RiderLocationService] Rider stationary for >30m — pausing GPS broadcast to preserve battery');
    isBroadcastingPaused = true;

    try {
      await supabase
        .from('delivery_tracking')
        .update({
          is_stationary: true,
          signal_lost: true,
          updated_at: new Date().toISOString(),
        })
        .eq('order_id', currentOrderId);
    } catch (e) {
      console.warn('[RiderLocationService] Failed to mark stationary status:', e);
    }
  }
}

/**
 * Stop broadcasting rider location and clean up subscriptions.
 */
export async function stopOrderTracking(): Promise<void> {
  if (watchSubscription) {
    watchSubscription.remove();
    watchSubscription = null;
  }

  if (batterySubscription) {
    batterySubscription.remove();
    batterySubscription = null;
  }

  if (activityCheckInterval) {
    clearInterval(activityCheckInterval);
    activityCheckInterval = null;
  }

  currentOrderId = null;
  currentUserId = null;
  currentBatteryLevel = null;
  lastKnownLat = null;
  lastKnownLng = null;
  isBroadcastingPaused = false;
}

/**
 * Check if tracking is currently active.
 */
export function isTrackingActive(): boolean {
  return watchSubscription !== null && currentOrderId !== null;
}

/**
 * Get the current order being tracked.
 */
export function getTrackingOrderId(): string | null {
  return currentOrderId;
}

/**
 * Get current rider battery level percentage.
 */
export function getTrackingBatteryLevel(): number | null {
  return currentBatteryLevel;
}

/**
 * Check if tracking is in stationary battery-preservation pause.
 */
export function isTrackingStationaryPaused(): boolean {
  return isBroadcastingPaused;
}

/**
 * Handle each location update from watchPositionAsync.
 * Writes to delivery_tracking, delivery_location_history, and driver_locations.
 */
async function handleLocationUpdate(location: Location.LocationObject): Promise<void> {
  if (!currentOrderId || !currentUserId) return;

  const { latitude, longitude, heading, speed, accuracy } = location.coords;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  // Detect physical movement: speed > 0.5 m/s (~1.8 km/h) or displacement > 25m
  let moved = false;
  if (speed != null && speed > 0.5) {
    moved = true;
  } else if (lastKnownLat != null && lastKnownLng != null) {
    const dist = haversineMeters(lastKnownLat, lastKnownLng, latitude, longitude);
    if (dist > 25) {
      moved = true;
    }
  } else {
    moved = true;
  }

  if (moved) {
    lastMotionTimestamp = now;
    if (isBroadcastingPaused) {
      console.log('[RiderLocationService] Movement detected (>25m / moving) — resuming active GPS broadcast');
      isBroadcastingPaused = false;
    }
  }

  lastKnownLat = latitude;
  lastKnownLng = longitude;

  // If paused due to stationary state, skip excessive DB ping writes
  if (isBroadcastingPaused) {
    return;
  }

  try {
    const dbWrites: PromiseLike<any>[] = [
      // 1. Upsert latest location into delivery_tracking
      supabase.from('delivery_tracking').upsert(
        {
          order_id: currentOrderId,
          rider_id: currentUserId,
          lat: latitude,
          lng: longitude,
          heading: heading ?? null,
          speed: speed ?? null,
          accuracy: accuracy ?? null,
          battery_level: currentBatteryLevel,
          is_stationary: false,
          signal_lost: false,
          updated_at: nowIso,
        },
        { onConflict: 'order_id' },
      ),
      // 2. Append GPS breadcrumb into delivery_location_history
      supabase.from('delivery_location_history').insert({
        order_id: currentOrderId,
        rider_id: currentUserId,
        lat: latitude,
        lng: longitude,
        heading: heading ?? null,
        speed: speed ?? null,
        recorded_at: nowIso,
      }),
      // 3. Update driver_locations for fleet map compatibility
      supabase.from('driver_locations').upsert({
        profile_id: currentUserId,
        lat: latitude,
        lng: longitude,
        speed: speed ?? null,
        heading: heading ?? null,
        accuracy_m: accuracy ?? null,
        updated_at: nowIso,
      }),
    ];

    await Promise.allSettled(dbWrites);
  } catch (err) {
    console.warn('[RiderLocationService] Location update error:', err);
  }
}
