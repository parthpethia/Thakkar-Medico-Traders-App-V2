const inFlightRequests = new Map<string, Promise<any>>();

/**
 * Coalesces concurrent in-flight requests for the same key.
 * If a request for the key is already in-flight, returns the same promise.
 * Once the promise resolves or rejects, the key is removed from the in-flight map.
 */
export function coalesce<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  if (inFlightRequests.has(key)) {
    return inFlightRequests.get(key) as Promise<T>;
  }

  const promise = fetcher()
    .then((result) => {
      inFlightRequests.delete(key);
      return result;
    })
    .catch((error) => {
      inFlightRequests.delete(key);
      throw error;
    });

  inFlightRequests.set(key, promise);
  return promise;
}

/**
 * Clears all in-flight requests.
 * Used in tests and logout flows.
 */
export function clearAll(): void {
  inFlightRequests.clear();
}
