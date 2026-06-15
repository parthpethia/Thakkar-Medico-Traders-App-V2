import { withRetry } from '../../src/utils/retryable';

describe('withRetry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns result on first success without retrying', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on network error and succeeds on second attempt', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('Network request failed'))
      .mockResolvedValueOnce('recovered');

    const promise = withRetry(fn, { retries: 2, delayMs: 100 });

    // Advance past the first delay (100ms * 2^0 = 100ms)
    await jest.advanceTimersByTimeAsync(100);

    const result = await promise;
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry business errors (insufficient_stock)', async () => {
    const bizError = new Error('insufficient_stock');
    const fn = jest.fn().mockRejectedValue(bizError);

    await expect(withRetry(fn, { retries: 3 })).rejects.toThrow('insufficient_stock');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry business errors (not_approved)', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('not_approved'));
    await expect(withRetry(fn)).rejects.toThrow('not_approved');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry business errors (credit_limit_exceeded)', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('credit_limit_exceeded'));
    await expect(withRetry(fn)).rejects.toThrow('credit_limit_exceeded');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry Postgres error code P0001 (raise_exception)', async () => {
    const pgError: any = new Error('custom pg exception');
    pgError.code = 'P0001';
    const fn = jest.fn().mockRejectedValue(pgError);

    await expect(withRetry(fn)).rejects.toThrow('custom pg exception');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses exponential backoff: 500, 1000, 2000...', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce('finally');

    const promise = withRetry(fn, { retries: 3, delayMs: 500 });

    // First retry after 500ms (500 * 2^0)
    await jest.advanceTimersByTimeAsync(500);
    // Second retry after 1000ms (500 * 2^1)
    await jest.advanceTimersByTimeAsync(1000);

    const result = await promise;
    expect(result).toBe('finally');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('calls onRetry callback with attempt number', async () => {
    const onRetry = jest.fn();
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce('ok');

    const promise = withRetry(fn, { retries: 2, delayMs: 100, onRetry });
    await jest.advanceTimersByTimeAsync(100);
    await promise;

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1);
  });

  it('throws last error after all retries exhausted', async () => {
    // Use real timers with minimal delay to avoid fake timer + rejection interaction
    jest.useRealTimers();

    const fn = jest.fn().mockImplementation(() => {
      return Promise.reject(Object.assign(new Error('server down'), { status: 500 }));
    });

    await expect(
      withRetry(fn, { retries: 2, delayMs: 1 })
    ).rejects.toThrow('server down');

    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries

    // Restore fake timers for remaining tests
    jest.useFakeTimers();
  });

  it('retries on HTTP 500 status errors', async () => {
    const serverErr: any = new Error('Internal server error');
    serverErr.status = 500;
    const fn = jest.fn()
      .mockRejectedValueOnce(serverErr)
      .mockResolvedValueOnce('ok');

    const promise = withRetry(fn, { retries: 1, delayMs: 50 });
    await jest.advanceTimersByTimeAsync(50);
    const result = await promise;
    expect(result).toBe('ok');
  });
});
