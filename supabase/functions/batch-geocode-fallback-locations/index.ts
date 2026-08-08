import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const WAREHOUSE_LAT = 21.150167;
const WAREHOUSE_LNG = 79.099140;

interface GeocodeResult {
  formatted_address: string;
  lat: number;
  lng: number;
  confidence: string;
}

function cleanAddressQuery(loc: any): string {
  const parts: string[] = [];

  const clean = (s?: string | null) => {
    if (!s) return '';
    const t = s.trim();
    if (t === 'N/A' || t === 'NA' || t === '-' || t === 'null') return '';
    return t;
  };

  const shopName = clean(loc.shop_name);
  const shopNo = clean(loc.shop_no);
  const building = clean(loc.building);
  const street = clean(loc.street);
  const landmark = clean(loc.landmark);
  const area = clean(loc.area);
  const city = clean(loc.city) || 'Nagpur';
  const state = clean(loc.state) || 'Maharashtra';
  const pincode = clean(loc.pincode);

  if (shopName) parts.push(shopName);
  if (shopNo) parts.push(shopNo);
  if (building) parts.push(building);
  if (street) parts.push(street);
  if (landmark) parts.push(`Near ${landmark}`);
  if (area) parts.push(area);
  if (city) parts.push(city);
  if (pincode) parts.push(pincode);
  if (state) parts.push(state);

  let query = parts.filter(Boolean).join(', ');
  if (!query || query.length < 5) {
    query = clean(loc.formatted_address) || '';
  }

  if (query && !query.toLowerCase().includes('nagpur')) {
    query = `${query}, Nagpur, Maharashtra, India`;
  } else if (query && !query.toLowerCase().includes('india')) {
    query = `${query}, India`;
  }

  return query;
}

function normalizeKey(str: string): string {
  return str.toLowerCase().trim().replace(/[\s,]+/g, ' ');
}

async function geocodeAddress(query: string, googleApiKey?: string): Promise<GeocodeResult | null> {
  if (!query || query.trim().length < 3) return null;
  const cleanQ = query.trim();

  // 1. Google Maps Geocoding API if key configured
  if (googleApiKey) {
    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(cleanQ)}&components=country:IN&key=${googleApiKey}`;
      const res = await fetch(url);
      const json = await res.json();
      if (json.status === 'OK' && json.results?.[0]) {
        const item = json.results[0];
        const locationType = item.geometry?.location_type || 'APPROXIMATE';
        return {
          formatted_address: item.formatted_address || cleanQ,
          lat: item.geometry.location.lat,
          lng: item.geometry.location.lng,
          confidence: locationType, // e.g. ROOFTOP, RANGE_INTERPOLATED, GEOMETRIC_CENTER, APPROXIMATE
        };
      }
    } catch {
      // Fallback to OSM
    }
  }

  // 2. OpenStreetMap Nominatim
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cleanQ)}&format=json&limit=1&addressdetails=1&countrycodes=in`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ThakkarMedicoBatchGeocoding/1.0' },
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        const item = data[0];
        const lat = parseFloat(item.lat);
        const lng = parseFloat(item.lon);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          const type = item.type || item.class || 'NOMINATIM';
          return {
            formatted_address: item.display_name || cleanQ,
            lat,
            lng,
            confidence: type.toUpperCase(),
          };
        }
      }
    }
  } catch {
    // Fallback to Photon
  }

  // 3. Photon (Komoot OSM)
  try {
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(cleanQ)}&limit=1`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (data.features && data.features.length > 0) {
        const feat = data.features[0];
        const [lng, lat] = feat.geometry.coordinates;
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          return {
            formatted_address: feat.properties?.name ? `${feat.properties.name}, Nagpur` : cleanQ,
            lat,
            lng,
            confidence: 'PHOTON',
          };
        }
      }
    }
  } catch {
    // Both failed
  }

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

    let body: { batch_size?: number; offset?: number } = {};
    if (req.method === 'POST') {
      try {
        body = await req.json();
      } catch {
        body = {};
      }
    }

    const batchSize = Math.min(Math.max(body.batch_size || 50, 1), 200);

    // Select candidate unverified fallback rows
    const { data: candidates, error: fetchErr } = await supabase
      .from('retailer_shop_locations')
      .select(`
        id, shop_name, shop_no, building, street, landmark, area, city, state, pincode,
        formatted_address, lat, lng, is_verified, verified_by, suggested_lat, not_on_google_maps
      `)
      .eq('is_verified', false)
      .is('suggested_lat', null)
      .eq('not_on_google_maps', false)
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
      const query = cleanAddressQuery(loc);
      if (!query || query.length < 5) {
        await supabase
          .from('retailer_shop_locations')
          .update({ not_on_google_maps: true })
          .eq('id', loc.id);
        notFoundCount++;
        continue;
      }

      const normKey = normalizeKey(query);

      // Check geocoding_cache
      const { data: cacheRow } = await supabase
        .from('geocoding_cache')
        .select('lat, lng, confidence')
        .eq('normalized_address', normKey)
        .maybeSingle();

      if (cacheRow && cacheRow.lat && cacheRow.lng) {
        await supabase.rpc('apply_shop_location_suggestion', {
          p_location_id: loc.id,
          p_lat: cacheRow.lat,
          p_lng: cacheRow.lng,
          p_confidence: cacheRow.confidence || 'CACHE',
          p_not_on_maps: false,
        });
        cacheHits++;
        successCount++;
        continue;
      }

      // Live geocode
      const geo = await geocodeAddress(query, googleApiKey);

      if (geo && geo.lat !== 0 && geo.lng !== 0) {
        // Save to cache
        await supabase.rpc('save_geocoding_cache', {
          p_address: query,
          p_lat: geo.lat,
          p_lng: geo.lng,
          p_confidence: geo.confidence || 'APPROXIMATE',
        });

        // Apply suggestion
        await supabase.rpc('apply_shop_location_suggestion', {
          p_location_id: loc.id,
          p_lat: geo.lat,
          p_lng: geo.lng,
          p_confidence: geo.confidence || 'APPROXIMATE',
          p_not_on_maps: false,
        });

        successCount++;
      } else {
        // Mark not_on_google_maps as pre-filled suggestion
        await supabase.rpc('apply_shop_location_suggestion', {
          p_location_id: loc.id,
          p_lat: null,
          p_lng: null,
          p_confidence: null,
          p_not_on_maps: true,
        });
        notFoundCount++;
      }

      // Throttle 1 second per non-cached external request
      await sleep(1000);
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
