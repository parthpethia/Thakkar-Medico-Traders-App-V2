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
    user_id?: string | null;
    user_name?: string | null;
  },
): Promise<OrderCoords | null> {
  // 1. Try delivery_snapshot first
  const fromSnap = coordsFromSnapshot(order.delivery_snapshot as SnapshotLike);
  if (fromSnap && (fromSnap.lat !== 0 || fromSnap.lng !== 0)) return fromSnap;

  const shopId = order.delivery_address_id;
  const userId = order.user_id;
  let lat = 0;
  let lng = 0;
  let formatted_address = '';
  let hasCoords = false;

  let isVerified = false;

  // 2. Try retailer_shop_locations by delivery_address_id
  if (shopId) {
    const { data } = await supabase
      .from('retailer_shop_locations')
      .select('lat, lng, formatted_address, street, area, city, pincode, is_verified')
      .eq('id', shopId)
      .maybeSingle();

    if (data) {
      lat = Number(data.lat);
      lng = Number(data.lng);
      isVerified = Boolean(data.is_verified);
      formatted_address = data.formatted_address || [data.street, data.area, data.city, data.pincode].filter(Boolean).join(', ');
      if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
        hasCoords = true;
      }
      // PART 1: Manually-confirmed pins from the Address Correction Portal must not be
      // silently overwritten by automated geocoding. Treat verified rows as authoritative.
      if (isVerified && hasCoords) {
        return { lat, lng, address: formatted_address, source: 'shop_location' };
      }
    }
  }

  // 3. Try retailer_shop_locations by user_id if not found yet
  if (!hasCoords && userId) {
    const { data: userLocations } = await supabase
      .from('retailer_shop_locations')
      .select('id, lat, lng, formatted_address, street, area, city, pincode, is_default, is_verified')
      .eq('retailer_account_id', userId)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1);

    if (userLocations && userLocations[0]) {
      const loc = userLocations[0];
      lat = Number(loc.lat);
      lng = Number(loc.lng);
      isVerified = Boolean(loc.is_verified);
      if (!formatted_address) {
        formatted_address = loc.formatted_address || [loc.street, loc.area, loc.city, loc.pincode].filter(Boolean).join(', ');
      }
      if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
        hasCoords = true;
      }
      // Manually-confirmed default location is authoritative
      if (isVerified && hasCoords) {
        return { lat, lng, address: formatted_address, source: 'shop_location' };
      }
    }
  }

  // 4. Try profiles table by user_id
  if (!hasCoords && userId) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('address, city, state, pincode, business_name')
      .eq('id', userId)
      .maybeSingle();

    if (profile && !formatted_address) {
      formatted_address = [profile.address, profile.city, profile.state, profile.pincode].filter(Boolean).join(', ');
    }
  }

  const fallbackAddress = order.delivery_address || formatted_address || (fromSnap ? fromSnap.address : '') || order.user_name || '';

  if (hasCoords) {
    return { lat, lng, address: fallbackAddress, source: 'shop_location' };
  }

  // 5. Geocode address via Google Maps API or free OSM Nominatim/Photon
  // Skip dynamic geocoding if the location was already manually verified by admin/staff
  if (!isVerified && fallbackAddress && fallbackAddress.trim() !== '') {
    try {
      const geo = await geocodeAddress(fallbackAddress);
      if (geo && geo.lat !== 0 && geo.lng !== 0) {
        console.log(`[Geocode] Resolved "${fallbackAddress.slice(0, 60)}" → ${geo.lat},${geo.lng}`);
        lat = geo.lat;
        lng = geo.lng;

        // Async updates in background
        if (shopId) {
          supabase.rpc('update_shop_location_coordinates', {
            p_location_id: shopId,
            p_lat: lat,
            p_lng: lng,
          }).catch(() => {});
        }
        if (order.id) {
          supabase.rpc('update_order_delivery_coordinates', {
            p_order_id: order.id,
            p_lat: lat,
            p_lng: lng,
          }).catch(() => {});
        }

        return { lat, lng, address: fallbackAddress, source: 'address_fallback' };
      }
    } catch (e) {
      console.warn('[Geocode] Geocoding failed for address:', fallbackAddress, e);
    }
  }

  // 6. Deterministic fallback near warehouse in Nagpur so tracking map ALWAYS loads and never breaks
  // Uses order ID / user ID hash to place marker in retail market area of Nagpur
  const seed = (order.id || userId || 'thakkar').split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const deltaLat = ((seed % 100) - 50) * 0.0003; // +/- ~1.5 km
  const deltaLng = (((seed * 7) % 100) - 50) * 0.0003;
  const estimatedLat = 21.15016745169625 + deltaLat;
  const estimatedLng = 79.09914048349087 + deltaLng;

  return {
    lat: estimatedLat,
    lng: estimatedLng,
    address: fallbackAddress || 'Nagpur, Maharashtra',
    source: 'address_fallback',
  };
}

export function googleMapsDirUrl(lat: number, lng: number, address?: string, origin?: { lat: number; lng: number }): string {
  const hasValidCoords = Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0);
  const originParam = origin && origin.lat && origin.lng ? `&origin=${origin.lat},${origin.lng}` : '';
  if (!hasValidCoords && address && address.trim() !== '') {
    return `https://www.google.com/maps/dir/?api=1${originParam}&destination=${encodeURIComponent(address)}&travelmode=driving`;
  }
  if (hasValidCoords) {
    return `https://www.google.com/maps/dir/?api=1${originParam}&destination=${lat},${lng}&travelmode=driving`;
  }
  // Last resort: no coords and no address — return empty (caller should handle)
  return '';
}
