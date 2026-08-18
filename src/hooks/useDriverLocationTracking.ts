import { useEffect } from 'react';
import * as Location from 'expo-location';
import { supabase } from '../services/supabase';
import { useAuthStore } from '../store/authStore';
import {
  startBackgroundLocationTask,
  stopBackgroundLocationTask,
} from '../tasks/driverLocationTask';

/**
 * Manages background & foreground driver location tracking lifecycle.
 * Ensures the driver's location is actively broadcasted at 60s cadence without competing polling loops.
 */
export function useDriverLocationTracking(enabled: boolean): void {
  const userId = useAuthStore((s) => s.user?.id);
  const role = useAuthStore((s) => s.user?.role);

  useEffect(() => {
    if (!enabled || !userId || role !== 'delivery') {
      void stopBackgroundLocationTask();
      return;
    }

    let isMounted = true;

    const initializeTracking = async () => {
      // 1. Start background task for continuous tracking
      await startBackgroundLocationTask();

      if (!isMounted) return;

      // 2. Initial seed location ping (ensures immediate presence on map)
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') return;

        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });

        if (!isMounted) return;

        await supabase.from('driver_locations').upsert(
          {
            profile_id: userId,
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy_m: pos.coords.accuracy ?? null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'profile_id' },
        );
      } catch {
        /* Ignore transient initial GPS error */
      }
    };

    void initializeTracking();

    return () => {
      isMounted = false;
      // Do not abruptly stop background task on minor tab switches; only when unmounting root layout
    };
  }, [enabled, userId, role]);
}

