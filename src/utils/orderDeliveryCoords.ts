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

export function isOrderActive(order: {
  delivered_at?: string | null;
  delivery_status?: string | null;
  status?: string | null;
}): boolean {
  if (order.delivered_at) return false;
  const s = (order.delivery_status || order.status || '').toLowerCase().trim();
  if (['delivered', 'cancelled', 'failed', 'delivery_failed', 'returned'].includes(s)) {
    return false;
  }
  return true;
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
    delivered_at?: string | null;
    delivery_status?: string | null;
    status?: string | null;
  },
): Promise<OrderCoords | null> {
  const isActive = isOrderActive(order);

  // 1. FOR HISTORICAL / DELIVERED ORDERS: delivery_snapshot is Layer 1 immutable truth
  if (!isActive) {
    const fromSnap = coordsFromSnapshot(order.delivery_snapshot as SnapshotLike);
    if (fromSnap && (fromSnap.lat !== 0 || fromSnap.lng !== 0)) {
      return fromSnap;
    }
  }

  const shopId = order.delivery_address_id;
  const userId = order.user_id;
  let lat = 0;
  let lng = 0;
  let formatted_address = '';
  let hasCoords = false;
  let isVerified = false;

  // 2. FOR ACTIVE IN-FLIGHT ORDERS: Authoritative verified retailer_shop_locations takes precedence over stale snapshot
  if (isActive && shopId) {
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
      // If manually verified by admin, treat as authoritative over any stale snapshot for in-flight deliveries
      if (isVerified && hasCoords) {
        return { lat, lng, address: formatted_address || order.delivery_address || '', source: 'shop_location' };
      }
    }
  }

  // 3. FOR ACTIVE IN-FLIGHT ORDERS: Check user's verified shop locations
  if (isActive && userId) {
    const { data: verifiedUserLocations } = await supabase
      .from('retailer_shop_locations')
      .select('id, lat, lng, formatted_address, street, area, city, pincode, is_default, is_verified')
      .eq('retailer_account_id', userId)
      .eq('is_verified', true)
      .order('is_default', { ascending: false })
      .order('updated_at', { ascending: false })
      .limit(1);

    if (verifiedUserLocations && verifiedUserLocations[0]) {
      const vLoc = verifiedUserLocations[0];
      const vLat = Number(vLoc.lat);
      const vLng = Number(vLoc.lng);
      if (Number.isFinite(vLat) && Number.isFinite(vLng) && (vLat !== 0 || vLng !== 0)) {
        const vAddr = vLoc.formatted_address || [vLoc.street, vLoc.area, vLoc.city, vLoc.pincode].filter(Boolean).join(', ');
        return { lat: vLat, lng: vLng, address: vAddr || order.delivery_address || '', source: 'shop_location' };
      }
    }
  }

  // 4. FALLBACK: Check delivery_snapshot (if active order has no verified pin)
  const fromSnap = coordsFromSnapshot(order.delivery_snapshot as SnapshotLike);
  if (fromSnap && (fromSnap.lat !== 0 || fromSnap.lng !== 0)) return fromSnap;

  // 5. FALLBACK: Check unverified shop location if coordinates exist
  if (hasCoords) {
    return { lat, lng, address: formatted_address || order.delivery_address || '', source: 'shop_location' };
  }

  if (userId) {
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
      if (!formatted_address) {
        formatted_address = loc.formatted_address || [loc.street, loc.area, loc.city, loc.pincode].filter(Boolean).join(', ');
      }
      if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
        return { lat, lng, address: formatted_address || order.delivery_address || '', source: 'shop_location' };
      }
    }
  }

  // 5. PRIORITY 5: Try profiles table by user_id
  if (userId) {
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

  // 6. PRIORITY 6: Geocode address via Google Maps API or OSM Nominatim
  // Self-heal is strictly gated: ONLY for unverified locations (!isVerified) on active orders (isActive)
  if (!isVerified && fallbackAddress && fallbackAddress.trim() !== '') {
    try {
      const geo = await geocodeAddress(fallbackAddress);
      if (geo && geo.lat !== 0 && geo.lng !== 0) {
        console.log(`[Geocode] Resolved "${fallbackAddress.slice(0, 60)}" → ${geo.lat},${geo.lng}`);
        lat = geo.lat;
        lng = geo.lng;

        // Async self-heal write: strictly only for active orders on unverified shop locations
        if (isActive && shopId && !isVerified) {
          void supabase
            .rpc('update_shop_location_coordinates', {
              p_location_id: shopId,
              p_lat: lat,
              p_lng: lng,
            })
            .then(
              () => {},
              () => {},
            );
        }
        if (isActive && order.id) {
          void supabase
            .rpc('update_order_delivery_coordinates', {
              p_order_id: order.id,
              p_lat: lat,
              p_lng: lng,
            })
            .then(
              () => {},
              () => {},
            );
        }

        return { lat, lng, address: fallbackAddress, source: 'address_fallback' };
      }
    } catch (e) {
      console.warn('[Geocode] Geocoding failed for address:', fallbackAddress, e);
    }
  }

  // 7. Deterministic fallback near warehouse in Nagpur so tracking map ALWAYS loads
  const seed = (order.id || userId || 'thakkar').split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const deltaLat = ((seed % 100) - 50) * 0.0003;
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

export function googleMapsDirUrl(
  lat: number,
  lng: number,
  address?: string,
  origin?: { lat: number; lng: number },
): string {
  const hasValidCoords = Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0);
  const hasValidOrigin = origin && Number.isFinite(origin.lat) && Number.isFinite(origin.lng) && (origin.lat !== 0 || origin.lng !== 0);
  const originParam = hasValidOrigin ? `&origin=${origin.lat},${origin.lng}` : '';

  if (hasValidCoords) {
    return `https://www.google.com/maps/dir/?api=1${originParam}&destination=${lat},${lng}&travelmode=driving`;
  }
  if (address && address.trim() !== '') {
    return `https://www.google.com/maps/dir/?api=1${originParam}&destination=${encodeURIComponent(address.trim())}&travelmode=driving`;
  }
  return '';
}
