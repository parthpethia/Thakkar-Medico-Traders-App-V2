/**
 * Geofence Service — Client-side destination proximity checking.
 *
 * Checks if the rider is within 500m of the delivery destination,
 * and updates delivery_tracking and orders tables accordingly.
 */
import { calculateDistance } from './routesApiService';
import { supabase } from './supabase';
import { triggerNotification } from './notificationTriggerService';

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

    // Asynchronously dispatch rider_arriving_soon push notification to the retailer
    (async () => {
      try {
        const { data: order } = await supabase
          .from('orders')
          .select('order_number, user_id')
          .eq('id', orderId)
          .maybeSingle();

        if (order?.user_id) {
          let riderName = 'Delivery Partner';
          if (riderId) {
            const { data: riderProfile } = await supabase
              .from('profiles')
              .select('name, business_name')
              .eq('id', riderId)
              .maybeSingle();
            if (riderProfile?.name) riderName = riderProfile.name;
          }

          let shopName = 'Your Shop';
          const { data: retailerProfile } = await supabase
            .from('profiles')
            .select('name, business_name')
            .eq('id', order.user_id)
            .maybeSingle();
          if (retailerProfile?.business_name || retailerProfile?.name) {
            shopName = retailerProfile.business_name || retailerProfile.name;
          }

          void triggerNotification({
            order_id: orderId,
            event_type: 'rider_arriving_soon',
            recipient_user_id: order.user_id,
            data: {
              order_number: order.order_number || orderId.slice(0, 8),
              shop_name: shopName,
              rider_name: riderName,
            },
          });
        }
      } catch (notifErr) {
        console.warn('[geofenceService] Push notification error:', notifErr);
      }
    })();

    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to trigger geofence arrival';
    return { success: false, error: msg };
  }
}
