/**
 * Geofence Service — Client-side destination proximity checking.
 *
 * Checks if the rider is within 500m of the delivery destination,
 * and updates delivery_tracking and orders tables accordingly.
 */
import { calculateDistance } from './routesApiService';
import { supabase } from './supabase';

export const ARRIVAL_GEOFENCE_METERS = 500;

/**
 * Check if the rider's coordinates are within the arrival geofence (500m) of the destination.
 */
export function checkGeofence(
  riderLat: number,
  riderLng: number,
  destLat: number,
  destLng: number,
  customThreshold = ARRIVAL_GEOFENCE_METERS,
): boolean {
  if (
    !Number.isFinite(riderLat) ||
    !Number.isFinite(riderLng) ||
    !Number.isFinite(destLat) ||
    !Number.isFinite(destLng) ||
    (riderLat === 0 && riderLng === 0) ||
    (destLat === 0 && destLng === 0)
  ) {
    return false;
  }

  const distance = calculateDistance({ lat: riderLat, lng: riderLng }, { lat: destLat, lng: destLng });
  return distance <= customThreshold;
}

/**
 * Trigger the geofence arrival event:
 * 1. Upsert delivery_tracking with geofence_arrived = true
 * 2. Update orders with delivery_status = 'arriving_soon'
 */
export async function triggerGeofenceArrival(
  orderId: string,
  riderId?: string | null,
): Promise<{ success: boolean; error?: string }> {
  try {
    const promises: PromiseLike<any>[] = [
      supabase
        .from('orders')
        .update({ delivery_status: 'arriving_soon' })
        .eq('id', orderId)
        .neq('delivery_status', 'delivered'),
    ];

    if (riderId) {
      promises.push(
        supabase
          .from('delivery_tracking')
          .update({ geofence_arrived: true, updated_at: new Date().toISOString() })
          .eq('order_id', orderId),
      );
    }

    await Promise.allSettled(promises);
    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to trigger geofence arrival';
    return { success: false, error: msg };
  }
}
