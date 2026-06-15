import { useState, useEffect, useRef } from 'react';
import NetInfo, { NetInfoState } from '@react-native-community/netinfo';

/**
 * Monitors device network connectivity with debouncing to prevent flicker.
 * @returns {{ isOnline: boolean, isInternetReachable: boolean }}
 *   - isOnline: true if the device has a network interface active
 *   - isInternetReachable: true if actual internet connectivity is confirmed
 */
export function useNetworkStatus() {
  const [isOnline, setIsOnline] = useState(true);
  const [isInternetReachable, setIsInternetReachable] = useState(true);
  const debounceTimer = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state: NetInfoState) => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }

      debounceTimer.current = setTimeout(() => {
        setIsOnline(state.isConnected ?? false);
        setIsInternetReachable(state.isInternetReachable ?? false);
      }, 1000);
    });

    return () => {
      unsubscribe();
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, []);

  return { isOnline, isInternetReachable };
}
