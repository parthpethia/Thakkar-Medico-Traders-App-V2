/**
 * Tests for Upstash Redis Client Module
 */
import {
  isRedisConfigured,
  getRiderPositionKey,
  setRiderPosition,
  getRiderPosition,
  deleteRiderPosition,
  pingRedis,
  DEFAULT_TTL_SECONDS,
  getRedisConfig,
  type RiderPosition,
} from '../../src/services/redisClient';

describe('redisClient', () => {
  const originalUrl = process.env.EXPO_PUBLIC_UPSTASH_REDIS_REST_URL;
  const originalToken = process.env.EXPO_PUBLIC_UPSTASH_REDIS_REST_TOKEN;
  const originalTtl = process.env.EXPO_PUBLIC_REDIS_POSITION_TTL_SECONDS;
  const originalSyncInterval = process.env.EXPO_PUBLIC_POSTGRES_SYNC_INTERVAL_MS;
  let mockFetch: jest.Mock;

  beforeEach(() => {
    process.env.EXPO_PUBLIC_UPSTASH_REDIS_REST_URL = 'https://test-upstash.upstash.io';
    process.env.EXPO_PUBLIC_UPSTASH_REDIS_REST_TOKEN = 'mock-redis-token';
    process.env.EXPO_PUBLIC_REDIS_POSITION_TTL_SECONDS = '90';
    process.env.EXPO_PUBLIC_POSTGRES_SYNC_INTERVAL_MS = '30000';
    mockFetch = jest.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    if (originalUrl !== undefined) {
      process.env.EXPO_PUBLIC_UPSTASH_REDIS_REST_URL = originalUrl;
    } else {
      delete process.env.EXPO_PUBLIC_UPSTASH_REDIS_REST_URL;
    }

    if (originalToken !== undefined) {
      process.env.EXPO_PUBLIC_UPSTASH_REDIS_REST_TOKEN = originalToken;
    } else {
      delete process.env.EXPO_PUBLIC_UPSTASH_REDIS_REST_TOKEN;
    }

    if (originalTtl !== undefined) {
      process.env.EXPO_PUBLIC_REDIS_POSITION_TTL_SECONDS = originalTtl;
    } else {
      delete process.env.EXPO_PUBLIC_REDIS_POSITION_TTL_SECONDS;
    }

    if (originalSyncInterval !== undefined) {
      process.env.EXPO_PUBLIC_POSTGRES_SYNC_INTERVAL_MS = originalSyncInterval;
    } else {
      delete process.env.EXPO_PUBLIC_POSTGRES_SYNC_INTERVAL_MS;
    }

    jest.restoreAllMocks();
  });

  describe('isRedisConfigured', () => {
    it('returns true when env vars are present', () => {
      expect(isRedisConfigured()).toBe(true);
    });

    it('returns false when URL is missing', () => {
      delete process.env.EXPO_PUBLIC_UPSTASH_REDIS_REST_URL;
      expect(isRedisConfigured()).toBe(false);
    });

    it('returns false when Token is missing', () => {
      delete process.env.EXPO_PUBLIC_UPSTASH_REDIS_REST_TOKEN;
      expect(isRedisConfigured()).toBe(false);
    });
  });

  describe('TTL / sync-interval ratio safety assertion', () => {
    it('ensures DEFAULT_TTL_SECONDS is at least 2x the 30s Postgres sync interval to eliminate expiration races', () => {
      const postgresSyncSeconds = 30;
      expect(DEFAULT_TTL_SECONDS).toBeGreaterThanOrEqual(postgresSyncSeconds * 2);
      expect(DEFAULT_TTL_SECONDS).toBe(90); // 3x ratio
    });

    it('falls back to DEFAULT_TTL_SECONDS when env var is omitted or invalid', () => {
      delete process.env.EXPO_PUBLIC_REDIS_POSITION_TTL_SECONDS;
      const config = getRedisConfig();
      expect(config?.ttl).toBe(90);
    });
  });

  describe('pingRedis', () => {
    it('returns ok: true and latency on PONG response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 'PONG' }),
      });

      const res = await pingRedis();
      expect(res.ok).toBe(true);
      expect(typeof res.latencyMs).toBe('number');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://test-upstash.upstash.io',
        expect.objectContaining({
          body: JSON.stringify(['PING']),
        }),
      );
    });

    it('returns ok: false when redis is unconfigured', async () => {
      delete process.env.EXPO_PUBLIC_UPSTASH_REDIS_REST_URL;
      const res = await pingRedis();
      expect(res.ok).toBe(false);
      expect(res.error).toBeDefined();
    });

    it('returns ok: false on network error without throwing', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
      const res = await pingRedis();
      expect(res.ok).toBe(false);
      expect(res.error).toContain('Connection refused');
    });
  });

  describe('getRiderPositionKey', () => {
    it('formats key with rider:pos: namespace', () => {
      expect(getRiderPositionKey('user-123')).toBe('rider:pos:user-123');
    });
  });

  describe('setRiderPosition', () => {
    const mockPos: RiderPosition = {
      riderId: 'rider-1',
      orderId: 'order-100',
      lat: 21.1501,
      lng: 79.0991,
      heading: 90,
      speed: 5.5,
      accuracy: 4,
      batteryLevel: 85,
      isStationary: false,
      signalLost: false,
      updatedAt: '2026-08-10T12:00:00.000Z',
    };

    it('sends SET command with configured 90s TTL and returns true on OK', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 'OK' }),
      });

      const success = await setRiderPosition('rider-1', mockPos);
      expect(success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://test-upstash.upstash.io');
      expect(options.method).toBe('POST');
      expect(options.headers).toEqual({
        Authorization: 'Bearer mock-redis-token',
        'Content-Type': 'application/json',
      });

      const body = JSON.parse(options.body);
      expect(body[0]).toBe('SET');
      expect(body[1]).toBe('rider:pos:rider-1');
      expect(JSON.parse(body[2])).toEqual(mockPos);
      expect(body[3]).toBe('EX');
      expect(body[4]).toBe(90);
    });

    it('allows custom TTL parameter', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 'OK' }),
      });

      const success = await setRiderPosition('rider-1', mockPos, 120);
      expect(success).toBe(true);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body[4]).toBe(120);
    });

    it('fail-open: returns false when fetch throws network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network connection timeout'));

      const success = await setRiderPosition('rider-1', mockPos);
      expect(success).toBe(false);
    });

    it('fail-open: returns false when HTTP status is not ok (e.g. 429 quota exhausted)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
      });

      const success = await setRiderPosition('rider-1', mockPos);
      expect(success).toBe(false);
    });

    it('returns false when redis is unconfigured', async () => {
      delete process.env.EXPO_PUBLIC_UPSTASH_REDIS_REST_URL;
      const success = await setRiderPosition('rider-1', mockPos);
      expect(success).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('getRiderPosition', () => {
    it('returns parsed RiderPosition when key exists', async () => {
      const mockPos: RiderPosition = {
        riderId: 'rider-1',
        orderId: 'order-100',
        lat: 21.1501,
        lng: 79.0991,
        heading: 90,
        speed: 5.5,
        updatedAt: '2026-08-10T12:00:00.000Z',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: JSON.stringify(mockPos) }),
      });

      const pos = await getRiderPosition('rider-1');
      expect(pos).toEqual(mockPos);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toEqual(['GET', 'rider:pos:rider-1']);
    });

    it('returns null when key does not exist or expired', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: null }),
      });

      const pos = await getRiderPosition('rider-1');
      expect(pos).toBeNull();
    });

    it('fail-open: returns null on fetch error or malformed payload', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection reset'));
      const pos = await getRiderPosition('rider-1');
      expect(pos).toBeNull();
    });
  });

  describe('deleteRiderPosition', () => {
    it('sends DEL command and returns true on success', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 1 }),
      });

      const success = await deleteRiderPosition('rider-1');
      expect(success).toBe(true);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toEqual(['DEL', 'rider:pos:rider-1']);
    });

    it('fail-open: returns false when network error occurs', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));
      const success = await deleteRiderPosition('rider-1');
      expect(success).toBe(false);
    });
  });
});
