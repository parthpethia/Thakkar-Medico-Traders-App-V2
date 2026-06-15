/**
 * Wraps an async function with exponential backoff retry logic.
 * Only retries on network/timeout errors — never retries business logic errors.
 *
 * @param fn - The async function to execute
 * @param options.retries - Maximum number of retry attempts (default: 2)
 * @param options.delayMs - Base delay in milliseconds, doubled each attempt (default: 500)
 * @param options.onRetry - Optional callback invoked before each retry with the attempt number
 * @returns The result of fn() on success
 * @throws The last error if all retries are exhausted
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    retries?: number;
    delayMs?: number;
    onRetry?: (attempt: number) => void;
  } = {},
): Promise<T> {
  const { retries = 2, delayMs = 500, onRetry } = options;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      if (!isRetryableError(error)) {
        throw error;
      }

      if (attempt < retries) {
        const delay = delayMs * Math.pow(2, attempt);
        onRetry?.(attempt + 1);
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

/**
 * Determines if an error is retryable (network/timeout) vs a business logic error.
 * Business logic errors from Supabase RPCs include specific Postgres error codes
 * or known exception messages that should NOT be retried.
 */
function isRetryableError(error: any): boolean {
  const message = (error?.message || '').toLowerCase();
  const code = error?.code || '';

  const businessErrors = [
    'insufficient_stock',
    'credit_limit_exceeded',
    'not_approved',
    'not_authorized',
    'invalid_quantity',
    'product_not_found',
    'invalid_payment_mode',
    'insufficient_points',
    'redemption_limit_exceeded',
    'pickup_not_enabled',
    'access_denied',
    'stock_below_zero',
    'invalid_reason',
    'limit_below_used',
  ];

  for (const bizErr of businessErrors) {
    if (message.includes(bizErr)) return false;
  }

  // Postgres constraint/logic error codes (class 23 = integrity, P0001 = raise_exception)
  if (code === '23505' || code === '23503' || code === 'P0001' || code === '23514') {
    return false;
  }

  // Retryable: network errors, timeouts, fetch failures
  if (
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('fetch') ||
    message.includes('econnrefused') ||
    message.includes('econnreset') ||
    message.includes('socket') ||
    message.includes('aborted') ||
    message.includes('dns') ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND'
  ) {
    return true;
  }

  // HTTP 5xx or 0 status codes indicate server/network issues
  const status = error?.status || error?.statusCode;
  if (status && (status >= 500 || status === 0 || status === 408 || status === 429)) {
    return true;
  }

  // Default: don't retry unknown errors to be safe
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
