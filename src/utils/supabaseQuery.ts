import { isTransientNetworkError } from './networkErrors';

const RETRY_DELAY_MS = 1000;
const MAX_ATTEMPTS = 3;

type QueryResult<T> = {
  data: T | null;
  error: { message?: string; code?: string } | null;
};

function isRetryableError(error: unknown): boolean {
  if (isTransientNetworkError(error)) return true;
  if (error && typeof error === 'object' && 'message' in error) {
    return isTransientNetworkError((error as { message?: string }).message);
  }
  return false;
}

/**
 * Runs a Supabase query with short retries on transient network failures.
 * PostgREST business errors (RLS, validation) are not retried.
 */
export async function executeSupabaseQuery<T>(
  fn: () => PromiseLike<QueryResult<T>>,
): Promise<QueryResult<T>> {
  let last: QueryResult<T> = { data: null, error: null };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      last = await fn();
      if (!last.error) {
        return last;
      }
      if (!isRetryableError(last.error) || attempt === MAX_ATTEMPTS) {
        return last;
      }
    } catch (err) {
      if (!isRetryableError(err) || attempt === MAX_ATTEMPTS) {
        throw err;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
  }

  return last;
}

/** Message suitable for inline UI (not a blocking alert). */
export function getUserFetchMessage(err: unknown, fallback = 'Could not load data'): string {
  if (!err) return fallback;
  const message = String((err as { message?: string }).message || err);
  if (isTransientNetworkError(err) || isTransientNetworkError(message)) {
    return 'Connection is slow or unavailable. Pull to refresh to try again.';
  }
  if (message.includes('JWT') || message.includes('permission denied') || message.includes('42501')) {
    return 'Session expired. Please sign in again.';
  }
  return message || fallback;
}

/** Show modal only for non-transient failures. */
export function shouldAlertFetchError(err: unknown): boolean {
  return !isTransientNetworkError(err);
}
