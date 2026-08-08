import { useEffect, useRef } from 'react';
import * as Location from 'expo-location';
import { supabase } from '../services/supabase';
import { useAuthStore } from '../store/authStore';

const TICK_MS = 30_000;
/** OPT-7: Only re-check active orders every 5 min instead of every tick. */
const ACTIVE_ORDER_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Upserts driver position every 30s while the driver has at least one active order (accepted, picked_up, or dispatched).
 */
export function useDriverLocationTracking(enabled: boolean): void {
  const userId = useAuthStore((s) => s.user?.id);
  const role = useAuthStore((s) => s.user?.role);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasActiveRef = useRef(false);
  const lastActiveCheckRef = useRef(0);

  useEffect(() => {
    if (!enabled || !userId || role !== 'delivery') return;

    let cancelled = false;

    const checkActiveOrders = async (): Promise<boolean> => {
      const now = Date.now();
      // OPT-7: Use cached result if checked recently
      if (now - lastActiveCheckRef.current < ACTIVE_ORDER_CHECK_INTERVAL_MS) {
        return hasActiveRef.current;
      }
      const { count, error } = await supabase
        .from('orders')
        .select('id', { head: true, count: 'exact' })
        .eq('assigned_to', userId)
        .in('status', ['accepted', 'picked_up', 'dispatched']);

      if (error) return hasActiveRef.current; // keep last known state
      const active = (count ?? 0) > 0;
      hasActiveRef.current = active;
      lastActiveCheckRef.current = now;
      return active;
    };

    const publishLocation = async () => {
      if (cancelled) return;
      const active = await checkActiveOrders();
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
