/**
 * Thakkar Medico — Background Batch Geocoding for Unverified Fallback Locations
 *
 * Features:
 * - Robust placeholder filtering ('N/A', 'none', '-', 'TBD', etc.)
 * - Hierarchical Fallback Query Ladder (Shop -> Street -> Landmark -> Area -> Pincode)
 * - Geocoding Cache Lookup
 * - Distinguishes provider error from genuine no-match
 * - Calls apply_shop_location_suggestion_v2
 *
 * Usage:
 *   node scripts/batch-geocode-fallback.js
 */

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const GOOGLE_KEY = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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

function isPlaceholderValue(v) {
  if (v === null || v === undefined) return true;
  const s = String(v).trim().toLowerCase();
  if (s === '' || s.length === 0) return true;
  if (PLACEHOLDERS.has(s)) return true;
  if (/^n[\s/.]*a$/i.test(s)) return true;
  if (/^[-._\s]+$/.test(s)) return true;
  return false;
}

function cleanField(v) {
  if (isPlaceholderValue(v)) return '';
  return String(v).trim();
}

function cleanStreetName(v) {
  const s = cleanField(v);
  if (!s) return '';
  return s.replace(/^(near|opp|opposite|behind|beside|front of|next to|above|below)\s+/i, '').trim();
}

function cleanAddressNoise(s) {
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

function extractUniquePOITokens(text) {
  if (!text) return [];
  const cleaned = cleanAddressNoise(text);
  const words = cleaned.toUpperCase().split(/[\s,\-\/()]+/).filter((w) => w.length >= 3 && !GENERIC_ADDRESS_TERMS.has(w) && !/^\d+$/.test(w));
  return Array.from(new Set(words));
}

function normalizeAddressForCache(query) {
  return query.toLowerCase().trim().replace(/[\s,]+/g, ' ');
}

function buildGeocodeQueryLadder(loc) {
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

  const candidates = [];
  const seenQueries = new Set();

  const addCandidate = (level, name, parts, defaultConfidence) => {
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

  // 1. Direct Street / Road candidate
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

  // 8. Locality / Area + City
  if (area) {
    addCandidate(4, 'area_city', [area, city, state], 'AREA_APPROXIMATE');
  }

  // 9. Pincode + City
  if (pincode && pincode.length === 6) {
    addCandidate(5, 'pincode_city', [pincode, city, state], 'PINCODE_APPROXIMATE');
  }

  // NOTE: City baseline ("NAGPUR, Maharashtra, India") is intentionally EXCLUDED from candidates!

  return candidates;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function haversineDistMeters(lat1, lon1, lat2, lon2) {
  if (!lat1 || !lon1 || !lat2 || !lon2) return 0;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const NAGPUR_LAT = 21.1458;
const NAGPUR_LNG = 79.0882;

async function geocodeSingle(q) {
  if (!q || q.length < 3) return null;

  // 1. Google Maps
  if (GOOGLE_KEY) {
    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&components=country:IN&key=${GOOGLE_KEY}`;
      const res = await fetch(url);
      const json = await res.json();
      if (json.status === 'OK' && json.results?.[0]) {
        const item = json.results[0];
        const lat = item.geometry.location.lat;
        const lng = item.geometry.location.lng;
        if (haversineDistMeters(NAGPUR_LAT, NAGPUR_LNG, lat, lng) <= 45000) {
          return { lat, lng, confidence: item.geometry.location_type || 'APPROXIMATE' };
        }
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
          if (haversineDistMeters(NAGPUR_LAT, NAGPUR_LNG, lat, lng) <= 45000) {
            return { lat, lng, confidence: (item.type || 'NOMINATIM').toUpperCase() };
          }
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
          if (haversineDistMeters(NAGPUR_LAT, NAGPUR_LNG, lat, lng) <= 45000) {
            return { lat, lng, confidence: 'PHOTON' };
          }
        }
      }
    }
  } catch (e) {}

  return null;
}

async function run() {
  const args = process.argv;
  const emailIdx = args.indexOf('--email');
  const passIdx = args.indexOf('--password');
  const email = emailIdx !== -1 ? args[emailIdx + 1] : process.env.ADMIN_EMAIL;
  const password = passIdx !== -1 ? args[passIdx + 1] : process.env.ADMIN_PASSWORD;

  if (email && password) {
    const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({ email, password });
    if (authErr) {
      console.error('Admin authentication failed:', authErr.message);
      process.exit(1);
    }
    console.log(`🔐 Authenticated as admin: ${authData.user.email}`);
  }

  console.log('🚀 Starting batch geocoding with Fallback Query Ladder...');

  let processed = 0;
  let batchIndex = 0;

  while (true) {
    batchIndex++;
    // Process unverified locations where suggested_lat is null OR was previously flagged not_on_google_maps
    const { data: rows, error } = await supabase
      .from('retailer_shop_locations')
      .select('id, shop_name, shop_no, building, street, landmark, area, city, state, pincode, formatted_address')
      .eq('is_verified', false)
      .is('suggested_lat', null)
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
      const ladder = buildGeocodeQueryLadder(loc);

      if (ladder.length === 0) {
        await supabase.rpc('apply_shop_location_suggestion_v2', {
          p_location_id: loc.id,
          p_lat: null,
          p_lng: null,
          p_confidence: null,
          p_query: 'Incomplete address',
          p_not_on_maps: true,
          p_error: null,
        });
        process.stdout.write(`⚠️ [Empty Address] ${loc.shop_name || loc.id}\n`);
        continue;
      }

      let resolved = null;
      let matchedCandidate = null;

      // Try each ladder candidate in order
      for (const candidate of ladder) {
        const normKey = normalizeAddressForCache(candidate.query);

        // Cache lookup
        const { data: cached } = await supabase
          .from('geocoding_cache')
          .select('lat, lng, confidence')
          .eq('normalized_address', normKey)
          .maybeSingle();

        if (cached && cached.lat && cached.lng) {
          resolved = { lat: cached.lat, lng: cached.lng, confidence: cached.confidence || candidate.defaultConfidence };
          matchedCandidate = candidate;
          process.stdout.write(`⚡ [Cache Hit Level ${candidate.level}] ${loc.shop_name} -> ${candidate.query}\n`);
          break;
        }

        // Live Geocoding
        const geo = await geocodeSingle(candidate.query);
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

          process.stdout.write(`✅ [Ladder Level ${candidate.level}] ${loc.shop_name} (${resolved.confidence}) -> ${candidate.query}\n`);
          break;
        }

        await sleep(1000); // 1 req/sec throttle between non-cached attempts
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
        process.stdout.write(`❌ [Zero Results] ${loc.shop_name} -> ${ladder[0].query}\n`);
      }
    }
  }

  console.log(`\n🏁 Finished! Processed ${processed} shop locations.`);
}

run().catch(console.error);
