/**
 * Tests for Rider Location Service with Redis Hot Path & Throttled Postgres Sync
 */
import * as Location from 'expo-location';
import { supabase } from '../../src/services/supabase';
import * as redisClient from '../../src/services/redisClient';
import {
  getLocationConfig,
  startOrderTracking,
  stopOrderTracking,
  isTrackingActive,
  getTrackingOrderId,
  getLiveRiderPosition,
} from '../../src/services/riderLocationService';

// Mock expo-location
jest.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  requestBackgroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  watchPositionAsync: jest.fn(),
  startLocationUpdatesAsync: jest.fn().mockResolvedValue(undefined),
  stopLocationUpdatesAsync: jest.fn().mockResolvedValue(undefined),
  hasStartedLocationUpdatesAsync: jest.fn().mockResolvedValue(false),
  Accuracy: { High: 6, Balanced: 3 },
  ActivityType: { AutomotiveNavigation: 2 },
}));

// Mock expo-task-manager
jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn(),
  isTaskRegisteredAsync: jest.fn().mockResolvedValue(true),
}));

// Mock driverLocationTask
jest.mock('../../src/tasks/driverLocationTask', () => ({
  DRIVER_LOCATION_TASK: 'DRIVER_LOCATION_TASK',
  startBackgroundLocationTask: jest.fn().mockResolvedValue(true),
  stopBackgroundLocationTask: jest.fn().mockResolvedValue(undefined),
}));

// Mock expo-notifications
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn().mockResolvedValue(undefined),
  scheduleNotificationAsync: jest.fn().mockResolvedValue('notif-id'),
  dismissAllNotificationsAsync: jest.fn().mockResolvedValue(undefined),
}));

// Mock expo-battery
jest.mock('expo-battery', () => ({
  getBatteryLevelAsync: jest.fn().mockResolvedValue(0.85),
  addBatteryLevelListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
}));

// Mock redisClient
jest.mock('../../src/services/redisClient', () => ({
  setRiderPosition: jest.fn(),
  getRiderPosition: jest.fn(),
  deleteRiderPosition: jest.fn(),
  isRedisConfigured: jest.fn().mockReturnValue(true),
  pingRedis: jest.fn().mockResolvedValue({ ok: true, latencyMs: 12 }),
}));

describe('riderLocationService', () => {
  let locationCallback: ((loc: Location.LocationObject) => Promise<void>) | null = null;
  const mockWatchRemove = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (Location.watchPositionAsync as jest.Mock).mockImplementation(
      async (_options, callback) => {
        locationCallback = callback;
        return { remove: mockWatchRemove };
      },
    );
  });

  afterEach(async () => {
    await stopOrderTracking();
  });

  describe('getLocationConfig', () => {
    it('returns speed-adaptive tiers for normal battery (>= 15%)', () => {
      // Speed 0 m/s (0 km/h) -> stationary/slow (120s / 30m)
      expect(getLocationConfig(80, 0)).toEqual({ timeInterval: 120000, distanceInterval: 30 });
      // Speed 3 m/s (10.8 km/h) -> city riding (60s / 25m)
      expect(getLocationConfig(80, 3)).toEqual({ timeInterval: 60000, distanceInterval: 25 });
      // Speed 10 m/s (36 km/h) -> highway speed (45s / 30m)
      expect(getLocationConfig(80, 10)).toEqual({ timeInterval: 45000, distanceInterval: 30 });
    });

    it('returns 90s / 50m for low battery (< 15%)', () => {
      expect(getLocationConfig(14)).toEqual({ timeInterval: 90000, distanceInterval: 50 });
      expect(getLocationConfig(5)).toEqual({ timeInterval: 90000, distanceInterval: 50 });
    });

    it('returns default stationary tier when battery level is null', () => {
      expect(getLocationConfig(null)).toEqual({ timeInterval: 120000, distanceInterval: 30 });
    });
  });

  describe('startOrderTracking & stopOrderTracking', () => {
    it('starts location tracking subscription and updates order status', async () => {
      const result = await startOrderTracking('order-123', 'rider-456');
      expect(result.success).toBe(true);
      expect(isTrackingActive()).toBe(true);
      expect(getTrackingOrderId()).toBe('order-123');

      expect(supabase.from).toHaveBeenCalledWith('orders');
      expect(Location.watchPositionAsync).toHaveBeenCalledTimes(1);
    });

    it('cleans up subscription and deletes Redis key on stopOrderTracking', async () => {
      await startOrderTracking('order-123', 'rider-456');
      await stopOrderTracking();

      expect(isTrackingActive()).toBe(false);
      expect(getTrackingOrderId()).toBeNull();
      expect(mockWatchRemove).toHaveBeenCalledTimes(1);
      expect(redisClient.deleteRiderPosition).toHaveBeenCalledWith('rider-456');
    });
  });

  describe('handleLocationUpdate write path', () => {
    const mockLocation: Location.LocationObject = {
      coords: {
        latitude: 21.1501,
        longitude: 79.0991,
        altitude: null,
        accuracy: 5,
        altitudeAccuracy: null,
        heading: 180,
        speed: 8.5,
      },
      timestamp: Date.now(),
    };

    it('writes to Redis on GPS tick and syncs first tick to Postgres', async () => {
      (redisClient.setRiderPosition as jest.Mock).mockResolvedValueOnce(true);

      await startOrderTracking('order-123', 'rider-456');
      expect(locationCallback).toBeTruthy();

      if (locationCallback) {
        await locationCallback(mockLocation);
      }

      // 1. Hot Path: Redis written immediately
      expect(redisClient.setRiderPosition).toHaveBeenCalledWith(
        'rider-456',
        expect.objectContaining({
          riderId: 'rider-456',
          orderId: 'order-123',
          lat: 21.1501,
          lng: 79.0991,
          speed: 8.5,
        }),
      );

      // 2. Initial Postgres sync executed on first tick
      expect(supabase.from).toHaveBeenCalledWith('delivery_tracking');
      expect(supabase.from).toHaveBeenCalledWith('driver_locations');
    });

    it('throttles subsequent Postgres syncs if 60s has not elapsed', async () => {
      (redisClient.setRiderPosition as jest.Mock).mockResolvedValue(true);

      await startOrderTracking('order-123', 'rider-456');

      if (locationCallback) {
        // First tick -> syncs to Postgres
        await locationCallback(mockLocation);
      }

      jest.clearAllMocks();
      (redisClient.setRiderPosition as jest.Mock).mockResolvedValue(true);

      if (locationCallback) {
        // Second tick right away (4s later, < 30s) -> writes to Redis only
        await locationCallback({
          ...mockLocation,
          coords: { ...mockLocation.coords, latitude: 21.1505, longitude: 79.0995 },
        });
      }

      // Hot path Redis called
      expect(redisClient.setRiderPosition).toHaveBeenCalledTimes(1);

      // Postgres delivery_tracking upsert NOT called (throttled)
      expect(supabase.from).not.toHaveBeenCalledWith('delivery_tracking');
    });

    it('fail-open: falls back to direct Postgres writes and logs telemetry when Redis fails', async () => {
      (redisClient.setRiderPosition as jest.Mock).mockResolvedValue(false);

      await startOrderTracking('order-123', 'rider-456');

      if (locationCallback) {
        await locationCallback(mockLocation);
      }

      // 1. Redis write attempted
      expect(redisClient.setRiderPosition).toHaveBeenCalledWith(
        'rider-456',
        expect.objectContaining({
          riderId: 'rider-456',
          orderId: 'order-123',
        }),
      );

      // 2. Direct Postgres fallback writes executed immediately
      expect(supabase.from).toHaveBeenCalledWith('delivery_tracking');
      expect(supabase.from).toHaveBeenCalledWith('driver_locations');

      // 3. Telemetry logged for Redis failure
      expect(supabase.from).toHaveBeenCalledWith('delivery_telemetry_events');
    });
  });

  describe('getLiveRiderPosition', () => {
    it('returns position from Redis when available', async () => {
      const mockRedisData = {
        riderId: 'rider-456',
        lat: 21.1501,
        lng: 79.0991,
        speed: 5,
        updatedAt: '2026-08-10T12:00:00Z',
      };
      (redisClient.getRiderPosition as jest.Mock).mockResolvedValueOnce(mockRedisData);

      const result = await getLiveRiderPosition('rider-456');
      expect(result).toEqual(mockRedisData);
      expect(redisClient.getRiderPosition).toHaveBeenCalledWith('rider-456');
      expect(supabase.from).not.toHaveBeenCalledWith('delivery_tracking');
    });

    it('falls back to Postgres delivery_tracking when Redis returns null', async () => {
      (redisClient.getRiderPosition as jest.Mock).mockResolvedValueOnce(null);

      const mockDbRow = {
        rider_id: 'rider-456',
        order_id: 'order-123',
        lat: 21.1502,
        lng: 79.0992,
        heading: 90,
        speed: 6,
        accuracy: 5,
        battery_level: 80,
        is_stationary: false,
        signal_lost: false,
        updated_at: '2026-08-10T12:00:00Z',
      };

      (supabase.from as jest.Mock).mockImplementation((table: string) => {
        if (table === 'delivery_tracking') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({ data: mockDbRow, error: null }),
          };
        }
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
        };
      });

      const result = await getLiveRiderPosition('rider-456', 'order-123');
      expect(result).toEqual({
        riderId: 'rider-456',
        orderId: 'order-123',
        lat: 21.1502,
        lng: 79.0992,
        heading: 90,
        speed: 6,
        accuracy: 5,
        batteryLevel: 80,
        isStationary: false,
        signalLost: false,
        updatedAt: '2026-08-10T12:00:00Z',
      });
    });
  });
});
