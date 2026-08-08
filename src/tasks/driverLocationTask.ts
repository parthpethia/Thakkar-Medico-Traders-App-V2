import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import { supabase } from '../services/supabase';
import { haversineDistanceKm } from '../utils/etaCalculator';

export const DRIVER_LOCATION_TASK = 'DRIVER_LOCATION_TASK';

let lastCoords: { lat: number; lng: number; time: number } | null = null;

TaskManager.defineTask(DRIVER_LOCATION_TASK, async ({ data, error }: any) => {
  if (error) {
    console.error('DRIVER_LOCATION_TASK failed:', error.message);
    return;
  }
  if (!data) return;

  const { locations } = data as { locations: Location.LocationObject[] };
  if (!locations || locations.length === 0) return;

  const latestLocation = locations[locations.length - 1];
  const { latitude, longitude, speed, heading, altitude, accuracy } = latestLocation.coords;

  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const userId = sessionData.session?.user?.id;
    if (!userId) return;

    // Check battery/data optimization: only update if moved > 20 meters OR 5 minutes passed
    const now = Date.now();
    if (lastCoords) {
      const dist = haversineDistanceKm(lastCoords.lat, lastCoords.lng, latitude, longitude) * 1000; // in meters
      const timeDiff = now - lastCoords.time;
      if (dist < 20 && timeDiff < 5 * 60 * 1000) {
        return;
      }
    }

    lastCoords = { lat: latitude, lng: longitude, time: now };

    // Parallel DB updates for live tracking, history, and per-order tracking
    const dbWrites: PromiseLike<any>[] = [
      supabase.from('driver_locations').upsert({
        profile_id: userId,
        lat: latitude,
        lng: longitude,
        speed: speed ?? null,
        heading: heading ?? null,
        altitude: altitude ?? null,
        accuracy_m: accuracy ?? null,
        updated_at: new Date().toISOString(),
      }),
      supabase.from('driver_location_history').insert({
        profile_id: userId,
        lat: latitude,
        lng: longitude,
        speed: speed ?? null,
        heading: heading ?? null,
        altitude: altitude ?? null,
        accuracy_m: accuracy ?? null,
        recorded_at: new Date(latestLocation.timestamp).toISOString(),
      }),
    ];

    // Dual-write: also update delivery_tracking for any active order
    // Look up the rider's current active dispatched order
    const { data: activeOrder } = await supabase
      .from('orders')
      .select('id')
      .eq('assigned_to', userId)
      .in('status', ['dispatched', 'picked_up'])
      .limit(1)
      .maybeSingle();

    if (activeOrder) {
      const nowIso = new Date(latestLocation.timestamp).toISOString();
      dbWrites.push(
        supabase.from('delivery_tracking').upsert(
          {
            order_id: activeOrder.id,
            rider_id: userId,
            lat: latitude,
            lng: longitude,
            heading: heading ?? null,
            speed: speed ?? null,
            accuracy: accuracy ?? null,
            updated_at: nowIso,
          },
          { onConflict: 'order_id' },
        ),
        supabase.from('delivery_location_history').insert({
          order_id: activeOrder.id,
          rider_id: userId,
          lat: latitude,
          lng: longitude,
          heading: heading ?? null,
          speed: speed ?? null,
          recorded_at: nowIso,
        }),
      );
    }

    await Promise.allSettled(dbWrites);
  } catch (err) {
    console.error('Error writing location in background:', err);
  }
});
