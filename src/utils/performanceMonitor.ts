/**
 * Lightweight performance monitoring for RPC calls and screen mounts.
 * In development, logs timing to console. In production, could POST to a
 * metrics endpoint (stubbed as console.log for now).
 */

/**
 * Wraps a Supabase RPC call (or any async function), measures its duration,
 * and logs the result. Transparent pass-through — returns the same value.
 *
 * @param name - Human-readable RPC name for logging (e.g. 'place_order')
 * @param fn - The async function to measure
 * @returns The resolved value of fn()
 */
export async function trackRpc<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    const result = await fn();
    const duration = Math.round(performance.now() - start);
    logMetric('rpc', name, duration, 'success');
    return result;
  } catch (error) {
    const duration = Math.round(performance.now() - start);
    logMetric('rpc', name, duration, 'error');
    throw error;
  }
}

/**
 * Records when a screen mounts, for navigation performance tracking.
 * Call at the top of a screen's useEffect or componentDidMount.
 *
 * @param screenName - The screen identifier (e.g. 'admin/analytics')
 */
export function trackScreen(screenName: string): void {
  const timestamp = Date.now();
  logMetric('screen_mount', screenName, 0, 'mounted', timestamp);
}

function logMetric(
  type: string,
  name: string,
  durationMs: number,
  status: string,
  timestamp?: number,
) {
  const entry = {
    type,
    name,
    durationMs,
    status,
    timestamp: timestamp || Date.now(),
  };

  if (__DEV__) {
    const emoji = status === 'error' ? '❌' : '⚡';
    if (type === 'rpc') {
      console.log(`${emoji} [Perf] ${name}: ${durationMs}ms (${status})`);
    } else {
      console.log(`📱 [Perf] Screen mounted: ${name}`);
    }
  }

  // Stub: In production, POST to /api/metrics
  // fetch('/api/metrics', { method: 'POST', body: JSON.stringify(entry) }).catch(() => {});
}
