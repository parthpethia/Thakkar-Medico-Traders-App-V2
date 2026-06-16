import { coalesce, clearAll } from '../../src/lib/queryCoalescer';

describe('queryCoalescer', () => {
  beforeEach(() => {
    clearAll();
  });

  it('should coalesce concurrent calls for the same key to the same promise', async () => {
    let callCount = 0;
    const fetcher = jest.fn().mockImplementation(async () => {
      callCount++;
      return new Promise((resolve) => setTimeout(() => resolve(`result-${callCount}`), 50));
    });

    const promise1 = coalesce('test-key', fetcher);
    const promise2 = coalesce('test-key', fetcher);

    expect(promise1).toBe(promise2);

    const [res1, res2] = await Promise.all([promise1, promise2]);

    expect(res1).toBe('result-1');
    expect(res2).toBe('result-1');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('should clear the request cache once resolved, allowing subsequent calls to trigger a fresh request', async () => {
    let callCount = 0;
    const fetcher = jest.fn().mockImplementation(async () => {
      callCount++;
      return `result-${callCount}`;
    });

    const res1 = await coalesce('test-key', fetcher);
    expect(res1).toBe('result-1');

    const res2 = await coalesce('test-key', fetcher);
    expect(res2).toBe('result-2');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('should clear the request cache once rejected, allowing subsequent calls to trigger a fresh request', async () => {
    const errorFetcher = jest.fn().mockRejectedValue(new Error('Fetch failed'));
    const successFetcher = jest.fn().mockResolvedValue('success');

    await expect(coalesce('test-key', errorFetcher)).rejects.toThrow('Fetch failed');

    const res = await coalesce('test-key', successFetcher);
    expect(res).toBe('success');
  });

  it('should support clearAll to manually clear all entries', async () => {
    const fetcher = jest.fn().mockImplementation(async () => {
      return new Promise((resolve) => setTimeout(() => resolve('val'), 50));
    });

    const promise1 = coalesce('test-key', fetcher);
    clearAll();
    const promise2 = coalesce('test-key', fetcher);

    expect(promise1).not.toBe(promise2);
    await Promise.all([promise1, promise2]);
  });
});
