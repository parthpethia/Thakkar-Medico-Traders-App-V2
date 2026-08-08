/**
 * Thakkar Medico — Background Batch Geocoding for Unverified Fallback Locations
 *
 * Usage:
 *   node scripts/batch-geocode-fallback.js
 *
 * Reads unverified shop locations, checks geocoding_cache, calls Google/Nominatim/Photon,
 * and sets suggested_lat, suggested_lng, flag_reason = 'geocode_suggestion', and suggestion_confidence.
 */

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const GOOGLE_KEY = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function cleanAddress(loc) {
  const parts = [];
  const clean = (s) => (s && s !== 'N/A' && s !== 'NA' && s !== '-' ? s.trim() : '');

  const shop = clean(loc.shop_name);
  const shopNo = clean(loc.shop_no);
  const bldg = clean(loc.building);
  const street = clean(loc.street);
  const lmark = clean(loc.landmark);
  const area = clean(loc.area);
  const city = clean(loc.city) || 'Nagpur';
  const state = clean(loc.state) || 'Maharashtra';
  const pin = clean(loc.pincode);

  if (shop) parts.push(shop);
  if (shopNo) parts.push(shopNo);
  if (bldg) parts.push(bldg);
  if (street) parts.push(street);
  if (lmark) parts.push(`Near ${lmark}`);
  if (area) parts.push(area);
  if (city) parts.push(city);
  if (pin) parts.push(pin);
  if (state) parts.push(state);

  let q = parts.filter(Boolean).join(', ');
  if (!q || q.length < 5) q = clean(loc.formatted_address);
  if (q && !q.toLowerCase().includes('nagpur')) q = `${q}, Nagpur, Maharashtra, India`;
  else if (q && !q.toLowerCase().includes('india')) q = `${q}, India`;

  return q;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function geocode(q) {
  if (!q || q.length < 3) return null;

  // 1. Google Maps if configured
  if (GOOGLE_KEY) {
    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&components=country:IN&key=${GOOGLE_KEY}`;
      const res = await fetch(url);
      const json = await res.json();
      if (json.status === 'OK' && json.results?.[0]) {
        const item = json.results[0];
        return {
          lat: item.geometry.location.lat,
          lng: item.geometry.location.lng,
          confidence: item.geometry.location_type || 'APPROXIMATE',
        };
      }
    } catch (e) {}
  }

  // 2. Nominatim
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&addressdetails=1&countrycodes=in`;
    const res = await fetch(url, { headers: { 'User-Agent': 'ThakkarMedicoCLI/1.0' } });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        const item = data[0];
        const lat = parseFloat(item.lat);
        const lng = parseFloat(item.lon);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          return { lat, lng, confidence: (item.type || 'NOMINATIM').toUpperCase() };
        }
      }
    }
  } catch (e) {}

  // 3. Photon
  try {
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=1`;
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
  } catch (e) {}

  return null;
}

async function run() {
  console.log('🚀 Starting batch geocoding for unverified fallback locations...');

  let processed = 0;
  let batchIndex = 0;

  while (true) {
    batchIndex++;
    const { data: rows, error } = await supabase
      .from('retailer_shop_locations')
      .select('id, shop_name, shop_no, building, street, landmark, area, city, state, pincode, formatted_address')
      .eq('is_verified', false)
      .is('suggested_lat', null)
      .eq('not_on_google_maps', false)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      console.error('Fetch error:', error);
      break;
    }

    if (!rows || rows.length === 0) {
      console.log('🎉 No more pending fallback rows to geocode!');
      break;
    }

    console.log(`\n📦 Processing batch #${batchIndex} (${rows.length} shops)...`);

    for (const loc of rows) {
      processed++;
      const q = cleanAddress(loc);
      const normKey = q.toLowerCase().trim().replace(/[\s,]+/g, ' ');

      // Cache lookup
      const { data: cached } = await supabase
        .from('geocoding_cache')
        .select('lat, lng, confidence')
        .eq('normalized_address', normKey)
        .maybeSingle();

      if (cached && cached.lat) {
        await supabase.rpc('apply_shop_location_suggestion', {
          p_location_id: loc.id,
          p_lat: cached.lat,
          p_lng: cached.lng,
          p_confidence: cached.confidence || 'CACHE',
          p_not_on_maps: false,
        });
        process.stdout.write(`⚡ [Cache Hit] ${loc.shop_name || loc.id}\n`);
        continue;
      }

      // External geocode
      const geo = await geocode(q);
      if (geo) {
        await supabase.rpc('save_geocoding_cache', {
          p_address: q,
          p_lat: geo.lat,
          p_lng: geo.lng,
          p_confidence: geo.confidence,
        });
        await supabase.rpc('apply_shop_location_suggestion', {
          p_location_id: loc.id,
          p_lat: geo.lat,
          p_lng: geo.lng,
          p_confidence: geo.confidence,
          p_not_on_maps: false,
        });
        process.stdout.write(`✅ [Geocoded] ${loc.shop_name} -> ${geo.lat.toFixed(5)}, ${geo.lng.toFixed(5)} (${geo.confidence})\n`);
      } else {
        await supabase.rpc('apply_shop_location_suggestion', {
          p_location_id: loc.id,
          p_lat: null,
          p_lng: null,
          p_confidence: null,
          p_not_on_maps: true,
        });
        process.stdout.write(`⚠️ [Not on maps] ${loc.shop_name}\n`);
      }

      await sleep(1000); // 1 req/sec throttle
    }
  }

  console.log(`\n🏁 Finished! Processed ${processed} shop locations.`);
}

run().catch(console.error);
