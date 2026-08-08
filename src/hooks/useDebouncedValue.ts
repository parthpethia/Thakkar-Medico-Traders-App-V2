import { useState, useEffect } from 'react';

/**
 * Returns a debounced version of the given value.
 * The returned value only updates after `delayMs` of inactivity.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
