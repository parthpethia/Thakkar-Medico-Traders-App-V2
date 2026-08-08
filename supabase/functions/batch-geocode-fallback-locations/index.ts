import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const PLACEHOLDERS = new Set([
  'n/a', 'na', 'none', '-', '--', '---', '.', '..', 'null', 'nil',
  'undefined', 'unknown', 'tbd', 'to be decided', 'not specified',
  'not available', 'no', '0', '000000', 'blank', 'empty', 'xxx',
  'owner', 'retailer'
]);

function isPlaceholderValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  const s = String(v).trim().toLowerCase();
  if (s === '' || s.length === 0) return true;
  if (PLACEHOLDERS.has(s)) return true;
  if (/^n[\s/.]*a$/i.test(s)) return true;
  if (/^[-._\s]+$/.test(s)) return true;
  return false;
}

function cleanField(v: unknown): string {
  if (isPlaceholderValue(v)) return '';
  return String(v).trim();
}

function normalizeKey(str: string): string {
  return str.toLowerCase().trim().replace(/[\s,]+/g, ' ');
}

interface GeocodeQueryCandidate {
  level: number;
  name: string;
  query: string;
  defaultConfidence: string;
}

function buildGeocodeQueryLadder(loc: any): GeocodeQueryCandidate[] {
  const shopName = cleanField(loc.shop_name);
  const shopNo = cleanField(loc.shop_no);
  const building = cleanField(loc.building);
  const street = cleanField(loc.street);
  const landmark = cleanField(loc.landmark);
  const area = cleanField(loc.area);
  const city = cleanField(loc.city) || 'Nagpur';
  const state = cleanField(loc.state) || 'Maharashtra';
  const pincode = cleanField(loc.pincode);

  const candidates: GeocodeQueryCandidate[] = [];
  const seenQueries = new Set<string>();

  const addCandidate = (level: number, name: string, parts: string[], defaultConfidence: string) => {
    const filtered = parts.map((p) => (p ? p.trim() : '')).filter((p) => p.length > 0 && !isPlaceholderValue(p));
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

    const norm = normalizeKey(q);
    if (!seenQueries.has(norm) && norm.length >= 8) {
      seenQueries.add(norm);
      candidates.push({ level, name, query: q, defaultConfidence });
    }
  };

  addCandidate(1, 'full_address', [shopName, shopNo, building, street, landmark, area, pincode, city, state], 'ROOFTOP');

  const formatted = cleanField(loc.formatted_address);
  if (formatted && formatted.length > 5) {
    addCandidate(1, 'full_address', [formatted], 'ROOFTOP');
  }

  addCandidate(2, 'street_area_city', [street, landmark, area, pincode, city, state], 'STREET');
  addCandidate(3, 'landmark_area_city', [landmark, area, city, state], 'AREA_APPROXIMATE');

  if (area) {
    addCandidate(4, 'area_city', [area, city, state], 'AREA_APPROXIMATE');
  }
  if (pincode && pincode.length === 6) {
    addCandidate(5, 'pincode_city', [pincode, city, state], 'PINCODE_APPROXIMATE');
  }
  addCandidate(6, 'city_state', [city, state], 'CITY_APPROXIMATE');

  return candidates;
}

interface GeocodeResult {
  lat: number;
  lng: number;
  confidence: string;
}

async function geocodeSingle(query: string, googleApiKey?: string): Promise<GeocodeResult | null> {
  if (!query || query.trim().length < 3) return null;
  const cleanQ = query.trim();

  // 1. Google Maps
  if (googleApiKey) {
    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(cleanQ)}&components=country:IN&key=${googleApiKey}`;
      const res = await fetch(url);
      const json = await res.json();
      if (json.status === 'OK' && json.results?.[0]) {
        const item = json.results[0];
        return {
          lat: item.geometry.location.lat,
          lng: item.geometry.location.lng,
          confidence: item.geometry?.location_type || 'APPROXIMATE',
        };
      }
    } catch {}
  }

  // 2. Nominatim
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cleanQ)}&format=json&limit=1&addressdetails=1&countrycodes=in`;
    const res = await fetch(url, { headers: { 'User-Agent': 'ThakkarMedicoBatchGeocoding/1.0' } });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        const item = data[0];
        const lat = parseFloat(item.lat);
        const lng = parseFloat(item.lon);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          return {
            lat,
            lng,
            confidence: (item.type || 'NOMINATIM').toUpperCase(),
          };
        }
      }
    }
  } catch {}

  // 3. Photon
  try {
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(cleanQ)}&limit=1`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (data.features && data.features.length > 0) {
        const [lng, lat] = data.features[0].geometry.coordinates;
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          return { lat, lng, confidence: 'PHOTON' };
        }
      }
    }
  } catch {}

  return null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const googleApiKey = Deno.env.get('GOOGLE_MAPS_API_KEY') || Deno.env.get('EXPO_PUBLIC_GOOGLE_MAPS_API_KEY');
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    let body: { batch_size?: number } = {};
    if (req.method === 'POST') {
      try {
        body = await req.json();
      } catch {
        body = {};
      }
    }

    const batchSize = Math.min(Math.max(body.batch_size || 50, 1), 200);

    const { data: candidates, error: fetchErr } = await supabase
      .from('retailer_shop_locations')
      .select(`
        id, shop_name, shop_no, building, street, landmark, area, city, state, pincode,
        formatted_address, lat, lng, is_verified, verified_by, suggested_lat, not_on_google_maps
      `)
      .eq('is_verified', false)
      .is('suggested_lat', null)
      .order('created_at', { ascending: false })
      .limit(batchSize);

    if (fetchErr) {
      return jsonResponse({ success: false, error: fetchErr.message }, 400);
    }

    if (!candidates || candidates.length === 0) {
      return jsonResponse({
        success: true,
        message: 'No remaining unverified fallback locations pending geocoding.',
        processed_count: 0,
      });
    }

    let successCount = 0;
    let cacheHits = 0;
    let notFoundCount = 0;

    for (const loc of candidates) {
      const ladder = buildGeocodeQueryLadder(loc);
      if (ladder.length === 0) {
        await supabase.rpc('apply_shop_location_suggestion_v2', {
          p_location_id: loc.id,
          p_lat: null,
          p_lng: null,
          p_confidence: null,
          p_query: 'Empty address',
          p_not_on_maps: true,
          p_error: null,
        });
        notFoundCount++;
        continue;
      }

      let resolved: GeocodeResult | null = null;
      let matchedCandidate: GeocodeQueryCandidate | null = null;

      for (const candidate of ladder) {
        const normKey = normalizeKey(candidate.query);

        // Cache lookup
        const { data: cacheRow } = await supabase
          .from('geocoding_cache')
          .select('lat, lng, confidence')
          .eq('normalized_address', normKey)
          .maybeSingle();

        if (cacheRow && cacheRow.lat && cacheRow.lng) {
          resolved = { lat: cacheRow.lat, lng: cacheRow.lng, confidence: cacheRow.confidence || candidate.defaultConfidence };
          matchedCandidate = candidate;
          cacheHits++;
          break;
        }

        // Live geocode
        const geo = await geocodeSingle(candidate.query, googleApiKey);
        if (geo && geo.lat !== 0 && geo.lng !== 0) {
          resolved = { lat: geo.lat, lng: geo.lng, confidence: geo.confidence || candidate.defaultConfidence };
          matchedCandidate = candidate;

          // Save to cache
          await supabase.rpc('save_geocoding_cache', {
            p_address: candidate.query,
            p_lat: geo.lat,
            p_lng: geo.lng,
            p_confidence: resolved.confidence,
          });
          break;
        }

        await sleep(1000);
      }

      if (resolved && matchedCandidate) {
        await supabase.rpc('apply_shop_location_suggestion_v2', {
          p_location_id: loc.id,
          p_lat: resolved.lat,
          p_lng: resolved.lng,
          p_confidence: resolved.confidence,
          p_query: matchedCandidate.query,
          p_not_on_maps: false,
          p_error: null,
        });
        successCount++;
      } else {
        await supabase.rpc('apply_shop_location_suggestion_v2', {
          p_location_id: loc.id,
          p_lat: null,
          p_lng: null,
          p_confidence: null,
          p_query: ladder[0].query,
          p_not_on_maps: true,
          p_error: 'Zero results across fallback ladder',
        });
        notFoundCount++;
      }
    }

    return jsonResponse({
      success: true,
      batch_size: candidates.length,
      geocoded_success: successCount,
      cache_hits: cacheHits,
      not_found_flagged: notFoundCount,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse({ success: false, error: message }, 500);
  }
});

function jsonResponse(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
