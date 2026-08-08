/**
 * Thakkar Medico — Address Query Builder & Geocode Fallback Ladder
 *
 * Cleans address fields by stripping placeholder values ('N/A', 'none', '-', etc.)
 * and constructs a hierarchical fallback ladder for geocoding services.
 * Prioritizes Street / Road field when available.
 */

const PLACEHOLDERS = new Set([
  'n/a', 'na', 'none', '-', '--', '---', '.', '..', 'null', 'nil',
  'undefined', 'unknown', 'tbd', 'to be decided', 'not specified',
  'not available', 'no', '0', '000000', 'blank', 'empty', 'xxx',
  'owner', 'retailer'
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
  // Strip leading positional prefixes if present in street field
  return s.replace(/^(near|opp|opposite|behind|beside|front of|next to|above|below)\s+/i, '').trim();
}

export interface GeocodeQueryCandidate {
  level: number;
  name: 'full_address' | 'street_direct' | 'street_area_city' | 'landmark_area_city' | 'area_city' | 'pincode_city' | 'city_state';
  query: string;
  defaultConfidence: 'ROOFTOP' | 'STREET' | 'AREA_APPROXIMATE' | 'PINCODE_APPROXIMATE' | 'CITY_APPROXIMATE';
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

  const candidates: GeocodeQueryCandidate[] = [];
  const seenQueries = new Set<string>();

  const addCandidate = (
    level: number,
    name: GeocodeQueryCandidate['name'],
    parts: string[],
    defaultConfidence: GeocodeQueryCandidate['defaultConfidence'],
  ) => {
    const filtered = parts.map((p) => p.trim()).filter((p) => p.length > 0 && !isPlaceholderValue(p));
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

  // 1. Direct Street / Road candidate (if street is provided, use it directly as primary query)
  if (rawStreet) {
    addCandidate(1, 'street_direct', [rawStreet, area, pincode, city, state], 'STREET');
    if (street && street !== rawStreet) {
      addCandidate(1, 'street_direct', [street, area, pincode, city, state], 'STREET');
    }
  }

  // 2. Fullest available structured combination (Shop name + Shop No + Building + Street + Landmark + Area + City + Pincode)
  addCandidate(1, 'full_address', [shopName, shopNo, building, street || rawStreet, landmark, area, pincode, city, state], 'ROOFTOP');

  // If structured fields are missing, try formatted_address
  const formatted = cleanField(loc.formatted_address);
  if (formatted && formatted.length > 5) {
    addCandidate(1, 'full_address', [formatted], 'ROOFTOP');
  }

  // 3. Street / Road standalone with City
  if (street || rawStreet) {
    addCandidate(2, 'street_direct', [street || rawStreet, city, state], 'STREET');
  }

  // 4. Street + Landmark + Area + City + Pincode
  addCandidate(2, 'street_area_city', [street || rawStreet, landmark, area, pincode, city, state], 'STREET');

  // 5. Landmark + Area + City
  addCandidate(3, 'landmark_area_city', [landmark, area, city, state], 'AREA_APPROXIMATE');

  // 6. Locality / Area + City (e.g. "Raghuji Nagar, Nagpur", "Dharampeth, Nagpur")
  if (area) {
    addCandidate(4, 'area_city', [area, city, state], 'AREA_APPROXIMATE');
  }

  // 7. Pincode + City (e.g. "440002, Nagpur")
  if (pincode && pincode.length === 6) {
    addCandidate(5, 'pincode_city', [pincode, city, state], 'PINCODE_APPROXIMATE');
  }

  // 8. City + State baseline
  addCandidate(6, 'city_state', [city, state], 'CITY_APPROXIMATE');

  return candidates;
}

export function normalizeAddressForCache(query: string): string {
  return query
    .toLowerCase()
    .trim()
    .replace(/[\s,]+/g, ' ');
}
