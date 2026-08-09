/**
 * Thakkar Medico — Address Query Builder & Geocode Fallback Ladder
 *
 * Implements:
 * - Tier 0: Raw formatted_address always attempted first (lightly cleaned)
 * - Tier 1: Street / Road direct & segment breakdown
 * - Tier 2: Landmark & Area locality matching
 * - Tier 3: Pincode approximate matching
 * - Geocoder metadata precision rejection (Nominatim/Photon/Google)
 * - Zero Mile Park (21.1498, 79.0821) city-centroid collapse rejection
 */

const PLACEHOLDERS = new Set([
  'n/a', 'na', 'none', '-', '--', '---', '.', '..', 'null', 'nil',
  'undefined', 'unknown', 'tbd', 'to be decided', 'not specified',
  'not available', 'no', '0', '000000', 'blank', 'empty', 'xxx',
  'owner', 'retailer'
]);

export const ZERO_MILE_NAGPUR = { lat: 21.1498134, lng: 79.0820556 };
export const WAREHOUSE_COORDS = { lat: 21.150167, lng: 79.099140 };

export function isPlaceholderValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  const s = String(v).trim().toLowerCase();
  if (s === '' || s.length === 0) return true;
  if (PLACEHOLDERS.has(s)) return true;
  if (/^n[\s/.]*a$/i.test(s)) return true;
  if (/^[-._\s]+$/.test(s)) return true;
  return false;
}

export function cleanField(v: unknown): string {
  if (isPlaceholderValue(v)) return '';
  return String(v).trim();
}

export function cleanStreetName(v: unknown): string {
  const s = cleanField(v);
  if (!s) return '';
  return s.replace(/^(near|opp|opposite|behind|beside|front of|next to|above|below)\s+/i, '').trim();
}

export function cleanAddressNoise(s: unknown): string {
  if (!s) return '';
  let str = String(s).trim();
  str = str.replace(/\s*\(\d+\)/g, '');
  str = str.replace(/\bROOM\s*(?:NO\.?)?\s*[\w\d\s\-]+/gi, '');
  str = str.replace(/\bGRD\.?\s*FLR?\b/gi, '');
  str = str.replace(/\b\d+(?:st|nd|rd|th)?\s*FLR?\b/gi, '');
  str = str.replace(/\bH\.?\s*NO\.?\s*[\w\d\/\-]+/gi, '');
  str = str.replace(/\bPLOT\s*(?:NO\.?)?\s*[\w\d\/\-]+/gi, '');
  str = str.replace(/\bKH\.?\s*NO\.?\s*[\w\d\/\-]+/gi, '');
  str = str.replace(/\bADM\/BS\/[\w\d\/\-]+/gi, '');
  str = str.replace(/[\s,]+,/g, ',');
  return str.replace(/^\s*,\s*|\s*,\s*$/g, '').trim();
}

export function cleanTier0FormattedAddress(text: unknown, city = 'Nagpur', state = 'Maharashtra'): string {
  if (!text || isPlaceholderValue(text)) return '';
  let str = String(text).trim();
  // Collapse repeated commas/spaces
  str = str.replace(/[\s,]+,/g, ', ').replace(/\s{2,}/g, ' ');
  // Strip trailing dangling fragment if < 3 chars after last comma (e.g. ", NA" -> "")
  str = str.replace(/,\s*([A-Za-z0-9]{1,2})\s*$/i, (match, fragment) => {
    const lower = fragment.toLowerCase();
    return (lower === 'in' || lower === 'mh') ? match : '';
  }).trim();

  if (str.length < 5) return '';

  if (!str.toLowerCase().includes(city.toLowerCase()) && !str.toLowerCase().includes('nagpur')) {
    str = `${str}, ${city}`;
  }
  if (!str.toLowerCase().includes(state.toLowerCase()) && !str.toLowerCase().includes('maharashtra')) {
    str = `${str}, ${state}`;
  }
  if (!str.toLowerCase().includes('india')) {
    str = `${str}, India`;
  }
  return str;
}

export function extractFormattedSegments(text: string, shopName?: string): string[] {
  if (!text) return [];
  const cleaned = cleanAddressNoise(text);
  const raw = cleaned.split(',').map((s) => s.trim()).filter((s) => s.length >= 2 && !isPlaceholderValue(s));
  const stripPrefix = (s: string) => s.replace(/^(near|opp|opposite|behind|beside|front of|next to|above|below)\s+/i, '').trim();
  const shopNameNorm = (shopName || '').toLowerCase().trim();
  const skipWords = new Set(['nagpur', 'maharashtra', 'india']);
  const segments: string[] = [];
  for (const seg of raw) {
    const lower = seg.toLowerCase().trim();
    if (shopNameNorm && lower.includes(shopNameNorm.substring(0, 8))) continue;
    if (/^\d+$/.test(seg.trim())) continue;
    if (skipWords.has(lower)) continue;
    const stripped = stripPrefix(seg);
    if (stripped.length >= 2 && !isPlaceholderValue(stripped)) {
      segments.push(stripped);
    }
  }
  return segments;
}

export function normalizeAddressForCache(query: string): string {
  return query
    .toLowerCase()
    .trim()
    .replace(/[\s,]+/g, ' ');
}

export function haversineDistMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  if (!lat1 || !lon1 || !lat2 || !lon2) return 0;
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function isCityCentroidCollapse(lat: number, lng: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return true;
  return haversineDistMeters(ZERO_MILE_NAGPUR.lat, ZERO_MILE_NAGPUR.lng, lat, lng) < 350;
}

export function isLowPrecisionNominatim(item: { class?: string; type?: string; boundingbox?: string[] }): boolean {
  if (!item) return true;
  const broadTypes = new Set([
    'city', 'town', 'village', 'state', 'country', 'administrative',
    'county', 'district', 'region', 'postcode', 'state_district', 'nation'
  ]);
  if (item.class === 'boundary' || (item.class === 'place' && broadTypes.has(item.type || '')) || broadTypes.has(item.type || '')) {
    return true;
  }
  if (item.boundingbox && Array.isArray(item.boundingbox) && item.boundingbox.length === 4) {
    const [minLat, maxLat, minLng, maxLng] = item.boundingbox.map(Number);
    const latSpan = Math.abs(maxLat - minLat);
    const lngSpan = Math.abs(maxLng - minLng);
    if (latSpan > 0.04 || lngSpan > 0.04) {
      return true;
    }
  }
  return false;
}

export function isLowPrecisionPhoton(feature: { properties?: { type?: string; osm_key?: string; osm_value?: string }; extent?: number[] }): boolean {
  if (!feature || !feature.properties) return true;
  const props = feature.properties;
  const broadTypes = new Set([
    'city', 'town', 'village', 'state', 'country', 'county',
    'district', 'locality', 'administrative', 'state_district'
  ]);
  if (broadTypes.has(props.type || '') || (props.osm_key === 'place' && broadTypes.has(props.osm_value || '')) || props.osm_key === 'boundary') {
    return true;
  }
  if (feature.extent && Array.isArray(feature.extent) && feature.extent.length === 4) {
    const [minLng, maxLat, maxLng, minLat] = feature.extent;
    const latSpan = Math.abs(maxLat - minLat);
    const lngSpan = Math.abs(maxLng - minLng);
    if (latSpan > 0.04 || lngSpan > 0.04) {
      return true;
    }
  }
  return false;
}

export interface GeocodeQueryCandidate {
  level: number;
  tier: string;
  name: string;
  query: string;
  defaultConfidence: 'ROOFTOP' | 'STREET' | 'AREA_APPROXIMATE' | 'PINCODE_APPROXIMATE';
}

export function buildGeocodeQueryLadder(loc: {
  shop_name?: string | null;
  shop_no?: string | null;
  building?: string | null;
  street?: string | null;
  landmark?: string | null;
  area?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  formatted_address?: string | null;
}): GeocodeQueryCandidate[] {
  const shopName = cleanField(loc.shop_name);
  const building = cleanField(loc.building);
  const rawStreet = cleanField(loc.street);
  const street = cleanStreetName(loc.street);
  const landmark = cleanField(loc.landmark);
  const area = cleanField(loc.area);
  const city = cleanField(loc.city) || 'Nagpur';
  const state = cleanField(loc.state) || 'Maharashtra';
  const pincode = cleanField(loc.pincode);
  const formatted = cleanField(loc.formatted_address);

  const candidates: GeocodeQueryCandidate[] = [];
  const seenQueries = new Set<string>();

  const addCandidate = (
    level: number,
    tier: string,
    name: string,
    parts: string[],
    defaultConfidence: GeocodeQueryCandidate['defaultConfidence'],
  ) => {
    const filtered = parts.map((p) => cleanAddressNoise(p)).filter((p) => p.length > 0 && !isPlaceholderValue(p));
    if (filtered.length === 0) return;

    let q = filtered.join(', ');
    if (!q.toLowerCase().includes('nagpur') && !q.toLowerCase().includes(city.toLowerCase())) {
      q = `${q}, ${city}`;
    }
    if (!q.toLowerCase().includes('maharashtra') && !q.toLowerCase().includes(state.toLowerCase())) {
      q = `${q}, ${state}`;
    }
    if (!q.toLowerCase().includes('india')) {
      q = `${q}, India`;
    }

    const norm = normalizeAddressForCache(q);
    if (!seenQueries.has(norm) && norm.length >= 8) {
      seenQueries.add(norm);
      candidates.push({ level, tier, name, query: q, defaultConfidence });
    }
  };

  // ===========================================================================
  // TIER 0: Raw Formatted Address (Lightly Cleaned) ALWAYS Tried First
  // ===========================================================================
  if (formatted && formatted.length >= 5) {
    const cleanTier0 = cleanTier0FormattedAddress(formatted, city, state);
    if (cleanTier0.length >= 8) {
      const norm = normalizeAddressForCache(cleanTier0);
      if (!seenQueries.has(norm)) {
        seenQueries.add(norm);
        candidates.push({
          level: 0,
          tier: 'Tier 0 (formatted_address)',
          name: 'tier0_formatted_address',
          query: cleanTier0,
          defaultConfidence: 'ROOFTOP',
        });
      }
    }
  }

  // ===========================================================================
  // TIER 1: Street / Road Direct & Clean Structured Combinations
  // ===========================================================================
  if (rawStreet) {
    addCandidate(1, 'Tier 1 (street_direct)', 'street_direct', [rawStreet, area, pincode, city, state], 'STREET');
    if (street && street !== rawStreet) {
      addCandidate(1, 'Tier 1 (street_direct)', 'street_direct', [street, area, pincode, city, state], 'STREET');
    }
  }

  // ===========================================================================
  // TIER 2: Formatted Address Segments Breakdown (minus shop name)
  // ===========================================================================
  if (formatted && formatted.length > 5) {
    const segments = extractFormattedSegments(formatted, shopName);
    if (segments.length >= 1) {
      addCandidate(2, 'Tier 2 (formatted_segments)', 'formatted_segments_all', [...segments, city, state], 'ROOFTOP');
    }
    for (let i = 0; i < segments.length; i++) {
      if (i + 1 < segments.length) {
        addCandidate(2, 'Tier 2 (formatted_segments)', 'formatted_segment_pair', [segments[i], segments[i + 1], city, state], 'STREET');
      }
    }
    for (const seg of segments) {
      if (seg.length >= 3) {
        addCandidate(2, 'Tier 2 (formatted_segments)', 'formatted_segment_single', [seg, area, city, state], 'AREA_APPROXIMATE');
        addCandidate(2, 'Tier 2 (formatted_segments)', 'formatted_segment_single', [seg, city, state], 'AREA_APPROXIMATE');
      }
    }
  }

  // ===========================================================================
  // TIER 3: Structured Shop + Building + Street + Landmark
  // ===========================================================================
  addCandidate(3, 'Tier 3 (structured_full)', 'structured_full', [shopName, building, street || rawStreet, landmark, area, pincode, city, state], 'ROOFTOP');

  if (street || rawStreet) {
    addCandidate(3, 'Tier 3 (street_standalone)', 'street_standalone', [street || rawStreet, city, state], 'STREET');
    addCandidate(3, 'Tier 3 (street_landmark_area)', 'street_landmark_area', [street || rawStreet, landmark, area, pincode, city, state], 'STREET');
  }

  // ===========================================================================
  // TIER 4: Landmark + Area Locality Matching
  // ===========================================================================
  addCandidate(4, 'Tier 4 (landmark_area)', 'landmark_area', [landmark, area, city, state], 'AREA_APPROXIMATE');
  if (area) {
    addCandidate(4, 'Tier 4 (area_city)', 'area_city', [area, city, state], 'AREA_APPROXIMATE');
  }

  // ===========================================================================
  // TIER 5: Pincode Matching
  // ===========================================================================
  if (pincode && pincode.length === 6) {
    addCandidate(5, 'Tier 5 (pincode_city)', 'pincode_city', [pincode, city, state], 'PINCODE_APPROXIMATE');
  }

  return candidates;
}
