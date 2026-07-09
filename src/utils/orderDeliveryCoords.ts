import { geocodeAddress } from '../services/googleMapsApi';

type SnapshotLike = {
  lat?: number;
  lng?: number;
  latitude?: number;
  longitude?: number;
  address?: string;
  formatted_address?: string;
  full_address?: string;
} | null | undefined;

export type OrderCoords = {
  lat: number;
  lng: number;
  address?: string;
  source: 'snapshot' | 'shop_location' | 'address_fallback';
};

export function coordsFromSnapshot(snapshot: SnapshotLike): OrderCoords | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const lat = Number(snapshot.lat ?? snapshot.latitude);
  const lng = Number(snapshot.lng ?? snapshot.longitude);
  const address = snapshot.address ?? snapshot.formatted_address ?? snapshot.full_address;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    if (address && address.trim() !== '') {
      return { lat: 0, lng: 0, address, source: 'address_fallback' };
    }
    return null;
  }
  if (lat === 0 && lng === 0) {
    if (address && address.trim() !== '') {
      return { lat: 0, lng: 0, address, source: 'address_fallback' };
    }
    return null;
  }
  return { lat, lng, address, source: 'snapshot' };
}

export async function resolveOrderCoords(
  supabase: any,
  order: {
    id?: string;
    delivery_snapshot?: unknown;
    delivery_address_id?: string | null;
    delivery_address?: string | null;
  },
): Promise<OrderCoords | null> {
  const fromSnap = coordsFromSnapshot(order.delivery_snapshot as SnapshotLike);
  if (fromSnap && (fromSnap.lat !== 0 || fromSnap.lng !== 0)) return fromSnap;

  const shopId = order.delivery_address_id;
  let lat = 0;
  let lng = 0;
  let formatted_address = '';
  let hasCoords = false;

  if (shopId) {
    const { data } = await supabase
      .from('retailer_shop_locations')
      .select('lat, lng, formatted_address')
      .eq('id', shopId)
      .maybeSingle();

    if (data) {
      lat = Number(data.lat);
      lng = Number(data.lng);
      formatted_address = data.formatted_address || '';
      if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
        hasCoords = true;
      }
    }
  }

  const fallbackAddress = order.delivery_address || formatted_address || (fromSnap ? fromSnap.address : '');

  if (hasCoords) {
    return { lat, lng, address: fallbackAddress, source: 'shop_location' };
  }

  if (fallbackAddress && fallbackAddress.trim() !== '') {
    try {
      const geo = await geocodeAddress(fallbackAddress);
      if (geo && geo.lat !== 0 && geo.lng !== 0) {
        console.log(`[Geocode] Resolved "${fallbackAddress.slice(0, 60)}" → ${geo.lat},${geo.lng}`);
        lat = geo.lat;
        lng = geo.lng;

        // Perform async database updates in the background (do not await to keep UI fast)
        if (shopId) {
          supabase.rpc('update_shop_location_coordinates', {
            p_location_id: shopId,
            p_lat: lat,
            p_lng: lng
          }).catch((err: any) => console.warn('Failed to update shop location coordinates:', err));
        }
        if (order.id) {
          supabase.rpc('update_order_delivery_coordinates', {
            p_order_id: order.id,
            p_lat: lat,
            p_lng: lng
          }).catch((err: any) => console.warn('Failed to update order snapshot coordinates:', err));
        }

        return { lat, lng, address: fallbackAddress, source: 'address_fallback' };
      }
    } catch (e) {
      console.warn('[Geocode] On-the-fly geocoding failed for address:', fallbackAddress, e);
    }

    return { lat: 0, lng: 0, address: fallbackAddress, source: 'address_fallback' };
  }

  return null;
}

export function googleMapsDirUrl(lat: number, lng: number, address?: string): string {
  const hasValidCoords = Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0);
  if (!hasValidCoords && address && address.trim() !== '') {
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}&travelmode=driving`;
  }
  if (hasValidCoords) {
    return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
  }
  // Last resort: no coords and no address — return empty (caller should handle)
  return '';
}
