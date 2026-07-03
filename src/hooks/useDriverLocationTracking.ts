import { useEffect, useRef } from 'react';
import * as Location from 'expo-location';
import { supabase } from '../services/supabase';
import { useAuthStore } from '../store/authStore';

const TICK_MS = 60_000;

/**
 * Upserts driver position every 60s while the driver has at least one dispatched order.
 */
export function useDriverLocationTracking(enabled: boolean): void {
  const userId = useAuthStore((s) => s.user?.id);
  const role = useAuthStore((s) => s.user?.role);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasDispatchedRef = useRef(false);

  useEffect(() => {
    if (!enabled || !userId || role !== 'delivery') return;

    let cancelled = false;

    const checkDispatched = async (): Promise<boolean> => {
      const { count, error } = await supabase
        .from('orders')
        .select('id', { head: true, count: 'exact' })
        .eq('assigned_to', userId)
        .eq('status', 'dispatched');

      if (error) return false;
      return (count ?? 0) > 0;
    };

    const publishLocation = async () => {
      if (cancelled) return;
      const active = await checkDispatched();
      hasDispatchedRef.current = active;
      if (!active) return;

      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;

      try {
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        await supabase.from('driver_locations').upsert({
          profile_id: userId,
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy_m: pos.coords.accuracy ?? null,
          recorded_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      } catch {
        /* ignore transient GPS errors */
      }
    };

    void publishLocation();
    timerRef.current = setInterval(() => void publishLocation(), TICK_MS);

    return () => {
      cancelled = true;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [enabled, userId, role]);
}
