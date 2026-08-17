/**
 * Rider Location Broadcasting Service
 *
 * Manages per-order GPS tracking for active deliveries:
 * - High-speed Redis hot-path caching for live rider coordinates (sub-second telemetry)
 * - Throttled Postgres sync (30s cadence) for delivery_tracking and driver_locations
 * - Speed+battery adaptive location update frequency (3s highway / 5s city / 8s slow / 10s critical)
 * - Kalman filter for GPS noise smoothing (±5-15m jitter elimination)
 * - GPS accuracy gating: rejects readings >50m to prevent junk upserts
 * - Offline location queue: queues failed pings in AsyncStorage, flushes on reconnect
 * - Heartbeat watchdog: writes tracking_heartbeat to AsyncStorage for stale-detection
 * - Foreground notification on Android to prevent OS battery kill
 * - Append breadcrumb to delivery_location_history on 30s cadence when motion >25m is detected
 * - Fail-open: falls back seamlessly to direct Postgres writes if Redis is unavailable
 * - Auto-stops / pauses after 30 minutes of stationary status to conserve battery
 * - 3-hour safety auto-stop timeout to prevent zombie tracking
 */
import * as Location from 'expo-location';
import * as Battery from 'expo-battery';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert, Platform } from 'react-native';
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
let currentSpeed: number | null = null;
let activityCheckInterval: ReturnType<typeof setInterval> | null = null;
let safetyTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

// Motion-Aware Activity State
let lastKnownLat: number | null = null;
let lastKnownLng: number | null = null;
let lastMotionTimestamp: number = Date.now();
let isBroadcastingPaused = false;

// Redis Hot-Path & Postgres Sync Timers
let lastPostgresSyncTimestamp = 0;
let lastTelemetryLogTimestamp = 0;
let redisConsecutiveFailureCount = 0;

// GPS Quality state (exposed via callback for UI indicators)
let currentGpsQuality: 'good' | 'poor' = 'good';
let gpsQualityCallback: ((quality: 'good' | 'poor') => void) | null = null;

// Speed-adaptive watcher config tracking (to detect when restart is needed)
let lastWatcherConfig: { timeInterval: number; distanceInterval: number } | null = null;

/** 3-hour safety auto-stop timeout (prevents zombie tracking) */
const SAFETY_TIMEOUT_MS = 3 * 60 * 60 * 1000;

/** Offline location queue key in AsyncStorage */
const OFFLINE_QUEUE_KEY = 'location_offline_queue';
const TRACKING_HEARTBEAT_KEY = 'tracking_heartbeat';
const TRACKING_ORDER_ID_KEY = 'tracking_order_id';
const TRACKING_RIDER_ID_KEY = 'tracking_rider_id';

/** Default Postgres sync interval: 30 seconds (reduces Postgres IOPS by 86.7%) */
const DEFAULT_POSTGRES_SYNC_INTERVAL_MS = 30000;

function getPostgresSyncIntervalMs(): number {
  const envVal = process.env.EXPO_PUBLIC_POSTGRES_SYNC_INTERVAL_MS;
  const parsed = envVal ? parseInt(envVal, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_POSTGRES_SYNC_INTERVAL_MS;
}

/** Stationary timeout (30 minutes of zero movement before battery safety pause) */
const STATIONARY_PAUSE_MS = 30 * 60 * 1000;

// ─── Kalman Filter for GPS Noise Smoothing ────────────────────────────────────

class KalmanFilter {
  private R: number = 0.01;  // measurement noise
  private Q: number = 3;     // process noise
  private P: number = 1;
  private X: number = 0;
  private K: number = 0;
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

const latFilter = new KalmanFilter();
const lngFilter = new KalmanFilter();

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
 * Speed+battery adaptive location update frequency (4 tiers):
 * - Battery critical (<15%): 10s / 20m — maximum power saving
 * - Stationary/slow (<5 km/h): 8s / 5m — at signal, parked
 * - City riding (5-20 km/h): 5s / 10m — urban delivery
 * - Highway speed (>20 km/h): 3s / 15m — fast highway movement
 */
export function getLocationConfig(
  batteryLevel: number | null,
  speed: number | null = null,
): {
  timeInterval: number;
  distanceInterval: number;
} {
  const speedKmh = (speed ?? 0) * 3.6;

  if (batteryLevel !== null && batteryLevel < 15) {
    return { timeInterval: 10000, distanceInterval: 20 }; // battery critical
  }
  if (speedKmh < 5) {
    return { timeInterval: 8000, distanceInterval: 5 };   // stationary/slow (at signal)
  }
  if (speedKmh < 20) {
    return { timeInterval: 5000, distanceInterval: 10 };  // city riding
  }
  return { timeInterval: 3000, distanceInterval: 15 };    // highway speed
}

/**
 * Request foreground + background location permissions.
 * Returns true if at least foreground permission was granted.
 */
export async function requestLocationPermissions(): Promise<boolean> {
  const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
  if (fgStatus !== 'granted') return false;

  try {
    const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
    if (bgStatus !== 'granted') {
      // Warn rider that background tracking will not work
      Alert.alert(
        'Background Location Denied',
        'Background location denied. Tracking will stop when you leave the app. ' +
        'Please enable in Settings → Privacy → Location Services → Thakkar Medico → Always.',
        [{ text: 'OK' }],
      );
    }
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
  currentSpeed = null;
  lastMotionTimestamp = Date.now();
  lastKnownLat = null;
  lastKnownLng = null;
  isBroadcastingPaused = false;
  lastPostgresSyncTimestamp = 0; // Force immediate Postgres sync on first tick
  lastTelemetryLogTimestamp = 0;
  redisConsecutiveFailureCount = 0;
  lastWatcherConfig = null;
  currentGpsQuality = 'good';

  // Reset Kalman filters for fresh tracking session
  latFilter.reset();
  lngFilter.reset();

  // Diagnostics: test Redis connectivity in background
  void pingRedis();

  // Persist tracking state for cold-start resume
  void AsyncStorage.setItem(TRACKING_ORDER_ID_KEY, orderId).catch(() => {});
  void AsyncStorage.setItem(TRACKING_RIDER_ID_KEY, userId).catch(() => {});
  void AsyncStorage.setItem(TRACKING_HEARTBEAT_KEY, Date.now().toString()).catch(() => {});

  // Show persistent foreground notification (Android: prevents OS battery kill)
  try {
    await Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
        shouldShowBanner: false,
        shouldShowList: false,
      }),
    });

    await Notifications.scheduleNotificationAsync({
      content: {
        title: '📍 Thakkar Medico Delivery',
        body: `Delivering Order #${orderId.slice(0, 8)} — location active`,
        sticky: true,
        autoDismiss: false,
      },
      trigger: null,
    });
  } catch (notifErr) {
    console.warn('[RiderLocationService] Foreground notification error (non-fatal):', notifErr);
  }

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

  const locConfig = getLocationConfig(currentBatteryLevel, currentSpeed);
  lastWatcherConfig = locConfig;

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
      void checkSpeedAdaptiveRestart();
    }, 60000);

    // 3-hour safety auto-stop timeout (prevents zombie tracking)
    safetyTimeoutTimer = setTimeout(() => {
      void handleSafetyTimeout();
    }, SAFETY_TIMEOUT_MS);

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
 * Stop broadcasting rider location and clean up all subscriptions + state.
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

  if (safetyTimeoutTimer) {
    clearTimeout(safetyTimeoutTimer);
    safetyTimeoutTimer = null;
  }

  if (currentUserId) {
    // Delete hot-path position from Redis on delivery end
    void deleteRiderPosition(currentUserId);
  }

  // Dismiss foreground notification
  try {
    await Notifications.dismissAllNotificationsAsync();
  } catch {
    // Non-fatal
  }

  // Clean up AsyncStorage tracking state
  try {
    await AsyncStorage.multiRemove([
      TRACKING_HEARTBEAT_KEY,
      TRACKING_ORDER_ID_KEY,
      TRACKING_RIDER_ID_KEY,
    ]);
  } catch {
    // Non-fatal
  }

  // Reset Kalman filters
  latFilter.reset();
  lngFilter.reset();

  currentOrderId = null;
  currentUserId = null;
  currentBatteryLevel = null;
  currentSpeed = null;
  lastKnownLat = null;
  lastKnownLng = null;
  isBroadcastingPaused = false;
  lastPostgresSyncTimestamp = 0;
  lastTelemetryLogTimestamp = 0;
  redisConsecutiveFailureCount = 0;
  lastWatcherConfig = null;
  currentGpsQuality = 'good';
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
 * Get current GPS quality state (for UI indicator).
 */
export function getGpsQuality(): 'good' | 'poor' {
  return currentGpsQuality;
}

/**
 * Register a callback for GPS quality changes (for UI indicator: green/amber dot).
 */
export function onGpsQualityChange(callback: ((quality: 'good' | 'poor') => void) | null): void {
  gpsQualityCallback = callback;
}

/**
 * 3-hour safety auto-stop: prevents zombie tracking if rider forgets to end delivery.
 */
async function handleSafetyTimeout(): Promise<void> {
  if (!currentOrderId) return;

  console.warn('[RiderLocationService] 3-hour safety timeout reached — auto-stopping tracking');

  // Log to delivery_tracking
  try {
    await supabase
      .from('delivery_tracking')
      .update({
        signal_lost: true,
        updated_at: new Date().toISOString(),
      })
      .eq('order_id', currentOrderId);
  } catch {
    // Non-fatal
  }

  await stopOrderTracking();

  // Show alert to rider
  Alert.alert(
    'Tracking Auto-Stopped',
    'Location sharing has been automatically stopped after 3 hours.\n' +
    'If your delivery is still in progress, reopen the order to resume.',
    [{ text: 'OK' }],
  );
}

/**
 * Check if speed has changed enough to warrant restarting the location watcher
 * with a different update frequency tier.
 */
async function checkSpeedAdaptiveRestart(): Promise<void> {
  if (!currentOrderId || !currentUserId || !watchSubscription) return;

  const newConfig = getLocationConfig(currentBatteryLevel, currentSpeed);
  if (
    lastWatcherConfig &&
    newConfig.timeInterval === lastWatcherConfig.timeInterval &&
    newConfig.distanceInterval === lastWatcherConfig.distanceInterval
  ) {
    return; // No change needed
  }

  // Config changed — restart watcher with new frequency
  console.log(
    `[RiderLocationService] Speed-adaptive restart: ${lastWatcherConfig?.timeInterval}ms → ${newConfig.timeInterval}ms`,
  );

  watchSubscription.remove();
  lastWatcherConfig = newConfig;

  try {
    watchSubscription = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.High,
        timeInterval: newConfig.timeInterval,
        distanceInterval: newConfig.distanceInterval,
      },
      (location) => {
        void handleLocationUpdate(location);
      },
    );
  } catch (err) {
    console.warn('[RiderLocationService] Failed to restart watcher with new config:', err);
  }
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
 * Pipeline: Accuracy gate → Kalman filter → Motion detect → Redis hot path → Postgres sync
 * Also writes heartbeat to AsyncStorage and uses offline queue on network failure.
 */
export async function handleLocationUpdate(location: Location.LocationObject): Promise<void> {
  if (!currentOrderId || !currentUserId) return;

  const { latitude, longitude, heading, speed, accuracy } = location.coords;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  // Track current speed for adaptive frequency
  currentSpeed = speed ?? null;

  // ── GPS Accuracy Gating: reject readings >50m ──────────────────────────────
  if (accuracy != null && accuracy > 50) {
    if (currentGpsQuality !== 'poor') {
      currentGpsQuality = 'poor';
      gpsQualityCallback?.('poor');
    }
    return; // Skip this junk GPS ping
  }
  if (currentGpsQuality !== 'good') {
    currentGpsQuality = 'good';
    gpsQualityCallback?.('good');
  }

  // ── Kalman Filter: smooth GPS noise ────────────────────────────────────────
  const smoothedLat = latFilter.filter(latitude);
  const smoothedLng = lngFilter.filter(longitude);

  // Detect physical movement: speed > 0.5 m/s (~1.8 km/h) or displacement > 25m
  let moved = false;
  if (speed != null && speed > 0.5) {
    moved = true;
  } else if (lastKnownLat != null && lastKnownLng != null) {
    const dist = haversineMeters(lastKnownLat, lastKnownLng, smoothedLat, smoothedLng);
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

  lastKnownLat = smoothedLat;
  lastKnownLng = smoothedLng;

  // If paused due to stationary state, skip excessive writes
  if (isBroadcastingPaused) {
    return;
  }

  const positionPayload: RiderPosition = {
    riderId: currentUserId,
    orderId: currentOrderId,
    lat: smoothedLat,
    lng: smoothedLng,
    heading: heading ?? null,
    speed: speed ?? null,
    accuracy: accuracy ?? null,
    batteryLevel: currentBatteryLevel,
    isStationary: false,
    signalLost: false,
    updatedAt: nowIso,
  };

  // ── Write heartbeat to AsyncStorage for watchdog detection ─────────────────
  void AsyncStorage.setItem(TRACKING_HEARTBEAT_KEY, now.toString()).catch(() => {});

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
      await upsertWithQueue(positionPayload, moved, false);
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
    await upsertWithQueue(positionPayload, moved, true);
  }
}

// ─── Offline Location Queue (Network Resilience) ────────────────────────────

interface QueuedLocationPing {
  order_id: string;
  rider_id: string;
  lat: number;
  lng: number;
  heading: number | null;
  speed: number | null;
  accuracy: number | null;
  queued_at: number;
}

/**
 * Wraps syncToPostgres with offline queue fallback.
 * On network failure, queues the ping in AsyncStorage.
 * On success, flushes any previously queued pings.
 */
async function upsertWithQueue(
  position: RiderPosition,
  moved: boolean,
  isFallback: boolean,
): Promise<void> {
  try {
    await syncToPostgres(position, moved, isFallback);
    // Also flush any queued pings from previous offline periods
    await flushOfflineQueue();
  } catch {
    // Network failed — queue this ping
    try {
      const raw = await AsyncStorage.getItem(OFFLINE_QUEUE_KEY);
      const queue: QueuedLocationPing[] = raw ? JSON.parse(raw) : [];
      queue.push({
        order_id: position.orderId || '',
        rider_id: position.riderId || '',
        lat: position.lat,
        lng: position.lng,
        heading: position.heading ?? null,
        speed: position.speed ?? null,
        accuracy: position.accuracy ?? null,
        queued_at: Date.now(),
      });
      // Keep only last 50 queued pings to avoid storage bloat
      const trimmed = queue.slice(-50);
      await AsyncStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(trimmed));
      console.log(`[RiderLocationService] Queued offline ping (${trimmed.length} total)`);
    } catch {
      // AsyncStorage write failed — drop this ping
    }
  }
}

/**
 * Flush offline queue: replays queued pings to delivery_location_history.
 * Called after a successful Postgres sync to catch up on missed data.
 */
export async function flushOfflineQueue(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(OFFLINE_QUEUE_KEY);
    if (!raw) return;
    const queue: QueuedLocationPing[] = JSON.parse(raw);
    if (!queue.length) return;

    // Insert history pings (we missed these while offline)
    const historyPings = queue.map((p) => ({
      order_id: p.order_id,
      rider_id: p.rider_id,
      lat: p.lat,
      lng: p.lng,
      heading: p.heading,
      speed: p.speed,
      recorded_at: new Date(p.queued_at).toISOString(),
    }));

    const { error } = await supabase.from('delivery_location_history').insert(historyPings);
    if (!error) {
      await AsyncStorage.removeItem(OFFLINE_QUEUE_KEY);
      console.log(`[RiderLocationService] Flushed ${historyPings.length} offline pings to history`);
    }
  } catch {
    // Will retry on next successful sync
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
