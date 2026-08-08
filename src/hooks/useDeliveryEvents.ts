import { useCallback } from 'react';
import * as Location from 'expo-location';
import { supabase } from '../services/supabase';
import { useAuthStore } from '../store/authStore';
import type { DeliveryEventType } from '../types';

export function useDeliveryEvents() {
  const user = useAuthStore((s) => s.user);

  const logDeliveryEvent = useCallback(
    async (
      orderId: string | null,
      eventType: DeliveryEventType,
      metadata: Record<string, any> = {},
      manifestId: string | null = null,
    ) => {
      try {
        if (!user?.id) return;

        // Proactively capture coordinates if foreground permission is granted
        let gpsLat: number | null = null;
        let gpsLng: number | null = null;
        let gpsAccuracyM: number | null = null;

        try {
          const { status } = await Location.getForegroundPermissionsAsync();
          if (status === 'granted') {
            const loc = await Location.getCurrentPositionAsync({
              accuracy: Location.Accuracy.Balanced,
            });
            gpsLat = loc.coords.latitude;
            gpsLng = loc.coords.longitude;
            gpsAccuracyM = loc.coords.accuracy;
          }
        } catch (locErr) {
          console.warn('Failed to obtain coordinates for event log:', locErr);
        }

        const { error } = await supabase.from('delivery_events').insert({
          order_id: orderId,
          manifest_id: manifestId,
          event_type: eventType,
          actor_id: user.id,
          actor_role: user.role,
          metadata,
          gps_lat: gpsLat,
          gps_lng: gpsLng,
          gps_accuracy_m: gpsAccuracyM,
        });

        if (error) throw error;
      } catch (err) {
        console.error('Error logging delivery event:', err);
      }
    },
    [user],
  );

  return { logDeliveryEvent };
}
