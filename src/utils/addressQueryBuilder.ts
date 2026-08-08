/**
 * Thakkar Medico — Address Query Builder & Geocode Fallback Ladder
 *
 * Cleans address fields by stripping placeholder values ('N/A', 'none', '-', etc.)
 * and internal building noise (room numbers, floor numbers, house numbers, bracketed IDs).
 * Constructs a hierarchical fallback ladder for geocoding services.
 */

const PLACEHOLDERS = new Set([
  'n/a', 'na', 'none', '-', '--', '---', '.', '..', 'null', 'nil',
  'undefined', 'unknown', 'tbd', 'to be decided', 'not specified',
  'not available', 'no', '0', '000000', 'blank', 'empty', 'xxx',
  'owner', 'retailer'
]);

const GENERIC_ADDRESS_TERMS = new Set([
  'PHARMACY', 'MEDICAL', 'STORE', 'STORES', 'CHEMIST', 'DRUGS', 'MEDICINE',
  'DISTRIBUTOR', 'TRADERS', 'AGENCY', 'AGENCIES', 'ENTERPRISES', 'LIMITED',
  'PVT', 'LTD', 'ROOM', 'MAIN', 'BUILDING', 'HEADQUARTER', 'HEADQUARTERS',
  'NAGPUR', 'MAHARASHTRA', 'INDIA', 'SHOP', 'FLOOR', 'FLR', 'GRD'
]);

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
  // Strip bracketed numbers e.g. (452)
  str = str.replace(/\s*\(\d+\)/g, '');
  // Strip room, floor, house no, plot no, kh no patterns
  str = str.replace(/\bROOM\s*(?:NO\.?)?\s*[\w\d\s\-]+/gi, '');
  str = str.replace(/\bGRD\.?\s*FLR?\b/gi, '');
  str = str.replace(/\b\d+(?:st|nd|rd|th)?\s*FLR?\b/gi, '');
  str = str.replace(/\bH\.?\s*NO\.?\s*[\w\d\/\-]+/gi, '');
  str = str.replace(/\bPLOT\s*(?:NO\.?)?\s*[\w\d\/\-]+/gi, '');
  str = str.replace(/\bKH\.?\s*NO\.?\s*[\w\d\/\-]+/gi, '');
  str = str.replace(/\bADM\/BS\/[\w\d\/\-]+/gi, '');
  // Strip duplicate consecutive spaces/commas
  str = str.replace(/[\s,]+,/g, ',');
  return str.replace(/^\s*,\s*|\s*,\s*$/g, '').trim();
}

export function extractUniquePOITokens(text: string): string[] {
  if (!text) return [];
  const cleaned = cleanAddressNoise(text);
  const words = cleaned.toUpperCase().split(/[\s,\-\/()]+/).filter((w) => w.length >= 3 && !GENERIC_ADDRESS_TERMS.has(w) && !/^\d+$/.test(w));
  return Array.from(new Set(words));
}

export interface GeocodeQueryCandidate {
  level: number;
  name: 'full_address' | 'street_direct' | 'poi_acronym' | 'street_area_city' | 'landmark_area_city' | 'area_city' | 'pincode_city';
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
  const shopNo = cleanField(loc.shop_no);
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
    name: GeocodeQueryCandidate['name'],
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
      candidates.push({ level, name, query: q, defaultConfidence });
    }
  };

  // 1. Direct Street / Road candidate (primary if street available)
  if (rawStreet) {
    addCandidate(1, 'street_direct', [rawStreet, area, pincode, city, state], 'STREET');
    if (street && street !== rawStreet) {
      addCandidate(1, 'street_direct', [street, area, pincode, city, state], 'STREET');
    }
  }

  // 2. Cleaned formatted address (strips room/floor/house noise)
  if (formatted && formatted.length > 5) {
    const cleanFormatted = cleanAddressNoise(formatted);
    addCandidate(1, 'full_address', [cleanFormatted], 'ROOFTOP');
  }

  // 3. Unique POI / Acronym candidates (e.g. "WCL, NAGPUR, Maharashtra, India")
  const poiTokens = [
    ...extractUniquePOITokens(shopName),
    ...extractUniquePOITokens(building),
    ...extractUniquePOITokens(formatted),
  ];
  for (const poi of Array.from(new Set(poiTokens))) {
    if (poi.length >= 3) {
      addCandidate(1, 'poi_acronym', [poi, area, city, state], 'STREET');
      addCandidate(2, 'poi_acronym', [poi, city, state], 'STREET');
    }
  }

  // 4. Fullest available structured combination (noise cleaned)
  addCandidate(1, 'full_address', [shopName, building, street || rawStreet, landmark, area, pincode, city, state], 'ROOFTOP');

  // 5. Standalone Street with City
  if (street || rawStreet) {
    addCandidate(2, 'street_direct', [street || rawStreet, city, state], 'STREET');
  }

  // 6. Street + Landmark + Area + City
  addCandidate(2, 'street_area_city', [street || rawStreet, landmark, area, pincode, city, state], 'STREET');

  // 7. Landmark + Area + City
  addCandidate(3, 'landmark_area_city', [landmark, area, city, state], 'AREA_APPROXIMATE');

  // 8. Locality / Area + City (e.g. "Raghuji Nagar, Nagpur", "Dharampeth, Nagpur")
  if (area) {
    addCandidate(4, 'area_city', [area, city, state], 'AREA_APPROXIMATE');
  }

  // 9. Pincode + City (e.g. "440001, Nagpur")
  if (pincode && pincode.length === 6) {
    addCandidate(5, 'pincode_city', [pincode, city, state], 'PINCODE_APPROXIMATE');
  }

  // NOTE: City baseline ("NAGPUR, Maharashtra, India") is intentionally EXCLUDED from candidates!
  // We do NOT auto-place a pin at generic city centroid if all specific location attempts fail.

  return candidates;
}

export function normalizeAddressForCache(query: string): string {
  return query
    .toLowerCase()
    .trim()
    .replace(/[\s,]+/g, ' ');
}
