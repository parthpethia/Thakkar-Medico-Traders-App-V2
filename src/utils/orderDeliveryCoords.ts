type SnapshotLike = {
  lat?: number;
  lng?: number;
  latitude?: number;
  longitude?: number;
} | null | undefined;

export type OrderCoords = {
  lat: number;
  lng: number;
  source: 'snapshot' | 'shop_location';
};

export function coordsFromSnapshot(snapshot: SnapshotLike): OrderCoords | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const lat = Number(snapshot.lat ?? snapshot.latitude);
  const lng = Number(snapshot.lng ?? snapshot.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng, source: 'snapshot' };
}

export async function resolveOrderCoords(
  supabase: any,
  order: {
    delivery_snapshot?: unknown;
    delivery_address_id?: string | null;
  },
): Promise<OrderCoords | null> {
  const fromSnap = coordsFromSnapshot(order.delivery_snapshot as SnapshotLike);
  if (fromSnap) return fromSnap;

  const shopId = order.delivery_address_id;
  if (!shopId) return null;

  const { data } = await supabase
    .from('retailer_shop_locations')
    .select('lat, lng')
    .eq('id', shopId)
    .maybeSingle();

  if (!data) return null;
  const lat = Number(data.lat);
  const lng = Number(data.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, source: 'shop_location' };
}

export function googleMapsDirUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
}
