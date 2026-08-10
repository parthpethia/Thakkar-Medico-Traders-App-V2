/**
 * Rider Location Broadcasting Service
 *
 * Manages per-order GPS tracking for active deliveries:
 * - High-speed Redis hot-path caching for live rider coordinates (sub-second telemetry)
 * - Throttled Postgres sync (30s cadence) for delivery_tracking and driver_locations
 * - Adaptive location update frequency based on battery level (Option 1: 10s normal / 20s power saver)
 * - Append breadcrumb to delivery_location_history on 30s cadence when motion >25m is detected
 * - Fail-open: falls back seamlessly to direct Postgres writes if Redis is unavailable
 * - Auto-stops / pauses after 30 minutes of stationary status to conserve battery
 */
import * as Location from 'expo-location';
import * as Battery from 'expo-battery';
import { supabase } from './supabase';
import { THAKKAR_MEDICO } from './routesApiService';
import {
  setRiderPosition,
  getRiderPosition,
  deleteRiderPosition,
  isRedisConfigured,
  pingRedis,
  type RiderPosition,
} from './redisClient';

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

// Redis Hot-Path & Postgres Sync Timers
let lastPostgresSyncTimestamp = 0;
let lastTelemetryLogTimestamp = 0;
let redisConsecutiveFailureCount = 0;

/** Default Postgres sync interval: 30 seconds (reduces Postgres IOPS by 86.7%) */
const DEFAULT_POSTGRES_SYNC_INTERVAL_MS = 30000;

function getPostgresSyncIntervalMs(): number {
  const envVal = process.env.EXPO_PUBLIC_POSTGRES_SYNC_INTERVAL_MS;
  const parsed = envVal ? parseInt(envVal, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_POSTGRES_SYNC_INTERVAL_MS;
}

/** Stationary timeout (30 minutes of zero movement before battery safety pause) */
const STATIONARY_PAUSE_MS = 30 * 60 * 1000;

/**
 * Asynchronously record Redis telemetry event (dampened to max 1 log per 60s per error wave).
 */
function recordRedisTelemetry(eventType: string, metadata: Record<string, unknown>): void {
  const now = Date.now();
  if (now - lastTelemetryLogTimestamp < 60000) {
    return;
  }
  lastTelemetryLogTimestamp = now;

  try {
    void supabase.from('delivery_telemetry_events').insert({
      event_type: eventType,
      order_id: currentOrderId,
      actor_id: currentUserId,
      metadata: {
        ...metadata,
        redis_configured: isRedisConfigured(),
        timestamp: new Date(now).toISOString(),
      },
    });
  } catch {
    // Non-blocking telemetry
  }
}

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
 * Adaptive location update frequency based on battery level (Option 1: 10s normal / 20s power saver):
 * - Normal (>= 15%): 10s / 15m (supports 5-6 concurrent riders on Upstash 500K quota with 25% safety margin)
 * - Low Battery (< 15%): 20s / 25m (power saver)
 */
export function getLocationConfig(batteryLevel: number | null): {
  timeInterval: number;
  distanceInterval: number;
} {
  const customInterval = parseInt(process.env.EXPO_PUBLIC_GPS_UPDATE_INTERVAL_MS || '', 10);
  const normalInterval = Number.isFinite(customInterval) && customInterval > 0 ? customInterval : 10000;

  if (batteryLevel !== null && batteryLevel < 15) {
    // Battery critical — reduce frequency to save power
    return { timeInterval: Math.max(normalInterval * 2, 20000), distanceInterval: 25 }; // 20s / 25m
  }
  return { timeInterval: normalInterval, distanceInterval: 15 }; // normal: 10s / 15m
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
  lastPostgresSyncTimestamp = 0; // Force immediate Postgres sync on first tick
  lastTelemetryLogTimestamp = 0;
  redisConsecutiveFailureCount = 0;

  // Diagnostics: test Redis connectivity in background
  void pingRedis();

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

    // Update order delivery_status to in_transit if not already dispatched
    await supabase
      .from('orders')
      .update({
        delivery_status: 'in_transit',
        dispatched_at: new Date().toISOString(),
      })
      .eq('id', orderId)
      .is('dispatched_at', null);

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
      // 1. Update Postgres
      await supabase
        .from('delivery_tracking')
        .update({
          is_stationary: true,
          signal_lost: true,
          updated_at: new Date().toISOString(),
        })
        .eq('order_id', currentOrderId);

      // 2. Update Redis key state if available
      if (lastKnownLat !== null && lastKnownLng !== null) {
        void setRiderPosition(currentUserId, {
          riderId: currentUserId,
          orderId: currentOrderId,
          lat: lastKnownLat,
          lng: lastKnownLng,
          batteryLevel: currentBatteryLevel,
          isStationary: true,
          signalLost: true,
          updatedAt: new Date().toISOString(),
        });
      }
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

  if (currentUserId) {
    // Delete hot-path position from Redis on delivery end
    void deleteRiderPosition(currentUserId);
  }

  currentOrderId = null;
  currentUserId = null;
  currentBatteryLevel = null;
  lastKnownLat = null;
  lastKnownLng = null;
  isBroadcastingPaused = false;
  lastPostgresSyncTimestamp = 0;
  lastTelemetryLogTimestamp = 0;
  redisConsecutiveFailureCount = 0;
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
 * Synchronizes the latest position snapshot to PostgreSQL:
 * 1. Upserts delivery_tracking (triggers Realtime broadcast to track.html & admin)
 * 2. Upserts driver_locations (for fleet map compatibility)
 * 3. Inserts into delivery_location_history if moved >25m
 */
async function syncToPostgres(
  position: RiderPosition,
  moved: boolean,
  isFallback: boolean,
): Promise<void> {
  if (!position.orderId || !position.riderId) return;

  const nowIso = position.updatedAt;

  try {
    const dbWrites: PromiseLike<any>[] = [
      // 1. Upsert latest location into delivery_tracking
      supabase.from('delivery_tracking').upsert(
        {
          order_id: position.orderId,
          rider_id: position.riderId,
          lat: position.lat,
          lng: position.lng,
          heading: position.heading ?? null,
          speed: position.speed ?? null,
          accuracy: position.accuracy ?? null,
          battery_level: position.batteryLevel ?? null,
          is_stationary: Boolean(position.isStationary),
          signal_lost: Boolean(position.signalLost),
          updated_at: nowIso,
        },
        { onConflict: 'order_id' },
      ),
      // 2. Update driver_locations for fleet map compatibility
      supabase.from('driver_locations').upsert({
        profile_id: position.riderId,
        lat: position.lat,
        lng: position.lng,
        speed: position.speed ?? null,
        heading: position.heading ?? null,
        accuracy_m: position.accuracy ?? null,
        updated_at: nowIso,
      }),
    ];

    // 3. Append GPS breadcrumb into delivery_location_history if physical movement detected or first sync
    if (moved || lastPostgresSyncTimestamp === 0) {
      dbWrites.push(
        supabase.from('delivery_location_history').insert({
          order_id: position.orderId,
          rider_id: position.riderId,
          lat: position.lat,
          lng: position.lng,
          heading: position.heading ?? null,
          speed: position.speed ?? null,
          recorded_at: nowIso,
        }),
      );
    }

    await Promise.allSettled(dbWrites);
  } catch (err) {
    console.warn(`[RiderLocationService] Postgres sync error (fallback=${isFallback}):`, err);
  }
}

/**
 * Handle each location update from watchPositionAsync.
 *
 * Hot-path: Writes to Upstash Redis every GPS tick (~10s default).
 * Durable-path: Syncs to Postgres every 30s (or immediately on Redis failure / first tick).
 */
export async function handleLocationUpdate(location: Location.LocationObject): Promise<void> {
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

  // If paused due to stationary state, skip excessive writes
  if (isBroadcastingPaused) {
    return;
  }

  const positionPayload: RiderPosition = {
    riderId: currentUserId,
    orderId: currentOrderId,
    lat: latitude,
    lng: longitude,
    heading: heading ?? null,
    speed: speed ?? null,
    accuracy: accuracy ?? null,
    batteryLevel: currentBatteryLevel,
    isStationary: false,
    signalLost: false,
    updatedAt: nowIso,
  };

  // 1. Hot Path: Write to Redis immediately
  let redisSuccess = false;
  try {
    redisSuccess = await setRiderPosition(currentUserId, positionPayload);
  } catch {
    redisSuccess = false;
  }

  const syncInterval = getPostgresSyncIntervalMs();
  const shouldSyncPostgres =
    lastPostgresSyncTimestamp === 0 || now - lastPostgresSyncTimestamp >= syncInterval;

  if (redisSuccess) {
    redisConsecutiveFailureCount = 0;

    // Periodic durable sync to Postgres every 30s
    if (shouldSyncPostgres) {
      lastPostgresSyncTimestamp = now;
      await syncToPostgres(positionPayload, moved, false);
    }
  } else {
    // Fail-open: Redis is down, unreachable, or unconfigured.
    // Degrade gracefully to writing directly to Postgres for this tick.
    redisConsecutiveFailureCount += 1;
    recordRedisTelemetry('redis_write_failure', {
      failure_count: redisConsecutiveFailureCount,
      action: 'fallback_to_postgres',
    });

    lastPostgresSyncTimestamp = now;
    await syncToPostgres(positionPayload, moved, true);
  }
}

/**
 * Reads live rider position, checking Redis first and falling back to Postgres.
 *
 * @param riderId Unique rider profile ID
 * @param orderId Optional active order ID to assist fallback query
 */
export async function getLiveRiderPosition(
  riderId: string,
  orderId?: string,
): Promise<RiderPosition | null> {
  if (!riderId) return null;

  // 1. Try Redis Hot-Path first
  try {
    const redisPos = await getRiderPosition(riderId);
    if (redisPos && Number.isFinite(redisPos.lat) && Number.isFinite(redisPos.lng)) {
      return redisPos;
    }
  } catch {
    // Fall back to Postgres on Redis read failure
  }

  // 2. Fallback: Query Postgres delivery_tracking or driver_locations
  try {
    if (orderId) {
      const { data: dtRow } = await supabase
        .from('delivery_tracking')
        .select('*')
        .eq('order_id', orderId)
        .maybeSingle();

      if (dtRow && dtRow.lat != null && dtRow.lng != null) {
        return {
          riderId: dtRow.rider_id || riderId,
          orderId: dtRow.order_id,
          lat: Number(dtRow.lat),
          lng: Number(dtRow.lng),
          heading: dtRow.heading ?? null,
          speed: dtRow.speed ?? null,
          accuracy: dtRow.accuracy ?? null,
          batteryLevel: dtRow.battery_level ?? null,
          isStationary: Boolean(dtRow.is_stationary),
          signalLost: Boolean(dtRow.signal_lost),
          updatedAt: dtRow.updated_at || new Date().toISOString(),
        };
      }
    }

    const { data: dlRow } = await supabase
      .from('driver_locations')
      .select('*')
      .eq('profile_id', riderId)
      .maybeSingle();

    if (dlRow && dlRow.lat != null && dlRow.lng != null) {
      return {
        riderId: dlRow.profile_id,
        lat: Number(dlRow.lat),
        lng: Number(dlRow.lng),
        heading: dlRow.heading ?? null,
        speed: dlRow.speed ?? null,
        accuracy: dlRow.accuracy_m ?? null,
        updatedAt: dlRow.updated_at || new Date().toISOString(),
      };
    }
  } catch (err) {
    console.warn('[RiderLocationService] Fallback read error:', err);
  }

  return null;
}
