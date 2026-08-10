/**
 * Redis Client Module (Upstash REST API)
 *
 * Lightweight, zero-dependency REST wrapper for Upstash Redis:
 * - High-speed hot-path caching for live rider GPS coordinates
 * - Fail-open: returns false/null on any network or quota failure without throwing
 * - Configurable TTL per key (default: 90s — 3x the 30s Postgres sync interval to eliminate expiration races)
 */

export interface RiderPosition {
  riderId: string;
  orderId?: string | null;
  lat: number;
  lng: number;
  heading?: number | null;
  speed?: number | null;
  accuracy?: number | null;
  batteryLevel?: number | null;
  isStationary?: boolean;
  signalLost?: boolean;
  updatedAt: string;
}

export const REQUEST_TIMEOUT_MS = 2000;
export const DEFAULT_TTL_SECONDS = 90;

export function getRedisConfig(): { url: string; token: string; ttl: number } | null {
  const url = process.env.EXPO_PUBLIC_UPSTASH_REDIS_REST_URL?.replace(/\/+$/, '');
  const token = process.env.EXPO_PUBLIC_UPSTASH_REDIS_REST_TOKEN;
  const rawTtl = parseInt(process.env.EXPO_PUBLIC_REDIS_POSITION_TTL_SECONDS || '', 10);
  const ttl = Number.isFinite(rawTtl) && rawTtl > 0 ? rawTtl : DEFAULT_TTL_SECONDS;

  if (!url || !token) {
    return null;
  }

  return { url, token, ttl };
}

/**
 * Checks whether Upstash Redis connection environment variables are present.
 */
export function isRedisConfigured(): boolean {
  return getRedisConfig() !== null;
}

/**
 * Tests connectivity to Upstash Redis (PING).
 * Useful for startup diagnostics.
 */
export async function pingRedis(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const config = getRedisConfig();
  if (!config) {
    return { ok: false, error: 'Redis environment variables not configured' };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startT = Date.now();

  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(['PING']),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startT;

    if (!response.ok) {
      const err = `HTTP ${response.status}: ${response.statusText}`;
      if (__DEV__) console.warn('[RedisClient] Upstash Redis ping failed:', err);
      return { ok: false, latencyMs, error: err };
    }

    const data = await response.json();
    const isOk = data?.result === 'PONG';
    if (isOk && __DEV__) {
      console.log(`[RedisClient] Upstash Redis connected successfully (Ping: ${latencyMs}ms)`);
    }
    return { ok: isOk, latencyMs };
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (__DEV__) console.warn('[RedisClient] Upstash Redis connectivity error:', errorMsg);
    return { ok: false, error: errorMsg };
  }
}

/**
 * Builds Redis key for a given rider.
 */
export function getRiderPositionKey(riderId: string): string {
  return `rider:pos:${riderId}`;
}

/**
 * Stores the latest rider GPS position in Redis with explicit TTL.
 *
 * @param riderId The unique rider/profile ID
 * @param position Current position telematics payload
 * @param customTtlSeconds Optional TTL in seconds (defaults to env or 90s)
 * @returns boolean true if successfully written to Redis, false if failed/unconfigured
 */
export async function setRiderPosition(
  riderId: string,
  position: RiderPosition,
  customTtlSeconds?: number,
): Promise<boolean> {
  const config = getRedisConfig();
  if (!config || !riderId) {
    return false;
  }

  const ttl = customTtlSeconds ?? config.ttl;
  const key = getRiderPositionKey(riderId);
  const value = JSON.stringify(position);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(['SET', key, value, 'EX', ttl]),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return false;
    }

    const result = await response.json();
    return result?.result === 'OK';
  } catch (err) {
    clearTimeout(timeoutId);
    return false;
  }
}

/**
 * Retrieves the current rider position from Redis.
 *
 * @param riderId The unique rider/profile ID
 * @returns RiderPosition if found and fresh, null if expired, missing, or error
 */
export async function getRiderPosition(riderId: string): Promise<RiderPosition | null> {
  const config = getRedisConfig();
  if (!config || !riderId) {
    return null;
  }

  const key = getRiderPositionKey(riderId);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(['GET', key]),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    if (!data || typeof data.result !== 'string') {
      return null;
    }

    const parsed = JSON.parse(data.result) as RiderPosition;
    if (!parsed || typeof parsed.lat !== 'number' || typeof parsed.lng !== 'number') {
      return null;
    }

    return parsed;
  } catch (err) {
    clearTimeout(timeoutId);
    return null;
  }
}

/**
 * Deletes rider position key from Redis (e.g. when delivery completes or stops).
 *
 * @param riderId The unique rider/profile ID
 */
export async function deleteRiderPosition(riderId: string): Promise<boolean> {
  const config = getRedisConfig();
  if (!config || !riderId) {
    return false;
  }

  const key = getRiderPositionKey(riderId);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(['DEL', key]),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return false;
    }

    const data = await response.json();
    return typeof data?.result === 'number' && data.result >= 0;
  } catch (err) {
    clearTimeout(timeoutId);
    return false;
  }
}
