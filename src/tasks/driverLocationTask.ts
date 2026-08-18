import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import { supabase } from '../services/supabase';
import { haversineDistanceKm } from '../utils/etaCalculator';
import { flushOfflineQueue } from '../services/riderLocationService';

export const DRIVER_LOCATION_TASK = 'DRIVER_LOCATION_TASK';

let lastCoords: { lat: number; lng: number; time: number } | null = null;
let lastHistoryInsertTime = 0;
let lastHistoryLat: number | null = null;
let lastHistoryLng: number | null = null;

// Independent Kalman filter for background task (separate JS context from foreground)
class BgKalmanFilter {
  private R = 0.01;
  private Q = 3;
  private P = 1;
  private X = 0;
  private K = 0;
  private initialized = false;

  filter(measurement: number): number {
    if (!this.initialized) {
      this.X = measurement;
      this.initialized = true;
      return measurement;
    }
    this.P = this.P + this.Q;
    this.K = this.P / (this.P + this.R);
    this.X = this.X + this.K * (measurement - this.X);
    this.P = (1 - this.K) * this.P;
    return this.X;
  }

  reset(): void {
    this.P = 1;
    this.X = 0;
    this.K = 0;
    this.initialized = false;
  }
}

const bgLatFilter = new BgKalmanFilter();
const bgLngFilter = new BgKalmanFilter();

/**
 * Start true OS-level background location tracking.
 * Safe for Android Foreground Service & iOS Background Location.
 */
export async function startBackgroundLocationTask(): Promise<boolean> {
  try {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(DRIVER_LOCATION_TASK);
    const hasStarted = await Location.hasStartedLocationUpdatesAsync(DRIVER_LOCATION_TASK).catch(() => false);

    if (hasStarted) {
      return true;
    }

    const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync().catch(() => ({ status: 'denied' }));
    if (bgStatus !== 'granted') {
      console.warn('[DriverLocationTask] Background location permission not granted');
      return false;
    }

    await Location.startLocationUpdatesAsync(DRIVER_LOCATION_TASK, {
      accuracy: Location.Accuracy.Balanced,
      timeInterval: 60000, // 60 seconds (Free Supabase optimized)
      distanceInterval: 25, // 25 meters minimum movement
      deferredUpdatesInterval: 60000,
      deferredUpdatesDistance: 25,
      activityType: Location.ActivityType.AutomotiveNavigation,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: '📍 Thakkar Medico Delivery',
        notificationBody: 'Live delivery location tracking is active in background',
        notificationColor: '#1565C0',
      },
      pausesLocationUpdatesAutomatically: false,
    });

    return true;
  } catch (err) {
    console.warn('[DriverLocationTask] Error starting background location updates:', err);
    return false;
  }
}

/**
 * Stop background location updates.
 */
export async function stopBackgroundLocationTask(): Promise<void> {
  try {
    const hasStarted = await Location.hasStartedLocationUpdatesAsync(DRIVER_LOCATION_TASK).catch(() => false);
    if (hasStarted) {
      await Location.stopLocationUpdatesAsync(DRIVER_LOCATION_TASK);
    }
  } catch (err) {
    console.warn('[DriverLocationTask] Error stopping background location updates:', err);
  }
}

TaskManager.defineTask(DRIVER_LOCATION_TASK, async ({ data, error }: any) => {
  if (error) {
    console.error('DRIVER_LOCATION_TASK failed:', error.message);
    return;
  }
  if (!data) return;

  const { locations } = data as { locations: Location.LocationObject[] };
  if (!locations || locations.length === 0) return;

  const latestLocation = locations[locations.length - 1];
  const { latitude: rawLat, longitude: rawLng, speed, heading, altitude, accuracy } = latestLocation.coords;

  // GPS Accuracy Gating: skip readings >50m (filters out low-accuracy jitter)
  if (accuracy != null && accuracy > 50) {
    return;
  }

  // Kalman filter: smooth GPS noise in background
  const latitude = bgLatFilter.filter(rawLat);
  const longitude = bgLngFilter.filter(rawLng);

  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const userId = sessionData.session?.user?.id;
    if (!userId) return;

    // Free Supabase rate limit & battery optimization:
    // Update live coordinates every 60s if moved > 25m, or max every 3 minutes if stationary
    const now = Date.now();
    if (lastCoords) {
      const distMeters = haversineDistanceKm(lastCoords.lat, lastCoords.lng, latitude, longitude) * 1000;
      const timeDiff = now - lastCoords.time;
      if (distMeters < 25 && timeDiff < 180000) {
        return;
      }
    }

    lastCoords = { lat: latitude, lng: longitude, time: now };
    const nowIso = new Date(latestLocation.timestamp || now).toISOString();

    // Parallel DB updates for live driver status (UPSERT single row)
    const dbWrites: PromiseLike<any>[] = [
      supabase.from('driver_locations').upsert({
        profile_id: userId,
        lat: latitude,
        lng: longitude,
        speed: speed ?? null,
        heading: heading ?? null,
        altitude: altitude ?? null,
        accuracy_m: accuracy ?? null,
        updated_at: nowIso,
      }),
    ];

    // Throttle history insertion: only insert into history if moved > 100m AND at least 60s elapsed
    let shouldInsertHistory = false;
    if (lastHistoryLat === null || lastHistoryLng === null) {
      shouldInsertHistory = true;
    } else {
      const historyDistMeters = haversineDistanceKm(lastHistoryLat, lastHistoryLng, latitude, longitude) * 1000;
      if (historyDistMeters > 100 && now - lastHistoryInsertTime >= 60000) {
        shouldInsertHistory = true;
      }
    }

    if (shouldInsertHistory) {
      lastHistoryInsertTime = now;
      lastHistoryLat = latitude;
      lastHistoryLng = longitude;
      dbWrites.push(
        supabase.from('driver_location_history').insert({
          profile_id: userId,
          lat: latitude,
          lng: longitude,
          speed: speed ?? null,
          heading: heading ?? null,
          altitude: altitude ?? null,
          accuracy_m: accuracy ?? null,
          recorded_at: nowIso,
        }),
      );
    }

    // Dual-write: also update delivery_tracking for any active order
    const { data: activeOrder } = await supabase
      .from('orders')
      .select('id')
      .eq('assigned_to', userId)
      .in('status', ['accepted', 'picked_up', 'dispatched', 'in_transit', 'out_for_delivery', 'arriving_soon'])
      .order('priority', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (activeOrder) {
      dbWrites.push(
        supabase.from('delivery_tracking').upsert(
          {
            order_id: activeOrder.id,
            rider_id: userId,
            lat: latitude,
            lng: longitude,
            heading: heading ?? null,
            speed: speed ?? null,
            accuracy: accuracy ?? null,
            is_stationary: false,
            signal_lost: false,
            updated_at: nowIso,
          },
          { onConflict: 'order_id' },
        ),
      );

      if (shouldInsertHistory) {
        dbWrites.push(
          supabase.from('delivery_location_history').insert({
            order_id: activeOrder.id,
            rider_id: userId,
            lat: latitude,
            lng: longitude,
            heading: heading ?? null,
            speed: speed ?? null,
            recorded_at: nowIso,
          }),
        );
      }
    }

    await Promise.allSettled(dbWrites);

    // Flush any queued offline pings from the foreground service
    try {
      await flushOfflineQueue();
    } catch {
      // Non-fatal — will retry next cycle
    }
  } catch (err) {
    console.error('[DriverLocationTask] Error writing location in background:', err);
  }
});

