/**
 * Thakkar Medico — Background Batch Geocoding for Unverified Fallback Locations
 *
 * Features:
 * - Tier 0: Raw formatted_address always attempted first (lightly cleaned)
 * - Hierarchical Fallback Query Ladder with Tier breakdown (Tiers 0-5)
 * - Geocoding Cache Lookup
 * - Strict Metadata Precision Filtering (Nominatim/Photon/Google)
 * - Zero Mile Park (21.1498, 79.0821) city-centroid collapse rejection
 * - 45km city boundary verification
 * - Calls apply_shop_location_suggestion_v2
 *
 * Usage:
 *   node scripts/batch-geocode-fallback.js
 *   node scripts/batch-geocode-fallback.js --target "ADARSH SALES"
 *   node scripts/batch-geocode-fallback.js --audit
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

const ZERO_MILE_NAGPUR = { lat: 21.1498134, lng: 79.0820556 };
const NAGPUR_LAT = 21.1458;
const NAGPUR_LNG = 79.0882;

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

function isCityCentroidCollapse(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return true;
  return haversineDistMeters(ZERO_MILE_NAGPUR.lat, ZERO_MILE_NAGPUR.lng, lat, lng) < 350;
}

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

function cleanTier0FormattedAddress(text, city = 'Nagpur', state = 'Maharashtra') {
  if (!text || isPlaceholderValue(text)) return '';
  let str = String(text).trim();
  str = str.replace(/[\s,]+,/g, ', ').replace(/\s{2,}/g, ' ');
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

function extractFormattedSegments(text, shopName) {
  if (!text) return [];
  const cleaned = cleanAddressNoise(text);
  const raw = cleaned.split(',').map((s) => s.trim()).filter((s) => s.length >= 2 && !isPlaceholderValue(s));
  const stripPrefix = (s) => s.replace(/^(near|opp|opposite|behind|beside|front of|next to|above|below)\s+/i, '').trim();
  const shopNameNorm = (shopName || '').toLowerCase().trim();
  const skipWords = new Set(['nagpur', 'maharashtra', 'india']);
  const segments = [];
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

function normalizeAddressForCache(query) {
  return query.toLowerCase().trim().replace(/[\s,]+/g, ' ');
}

function isLowPrecisionNominatim(item) {
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

function isLowPrecisionPhoton(feature) {
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

function isLowPrecisionGoogle(result) {
  if (!result) return true;
  if (result.geometry?.location_type === 'APPROXIMATE') {
    const types = result.types || [];
    const broadTypes = new Set([
      'administrative_area_level_1', 'administrative_area_level_2',
      'locality', 'political', 'country', 'postal_code'
    ]);
    const hasSpecific = types.some((t) =>
      ['street_address', 'route', 'premise', 'subpremise', 'establishment', 'point_of_interest', 'sublocality', 'sublocality_level_1'].includes(t)
    );
    if (!hasSpecific && types.some((t) => broadTypes.has(t))) {
      return true;
    }
  }
  return false;
}

function buildGeocodeQueryLadder(loc) {
  if (!loc) return [];
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

  const candidates = [];
  const seenQueries = new Set();

  const addCandidate = (level, tier, name, parts, defaultConfidence) => {
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
  // TIER 0: Raw Formatted Address (Lightly Cleaned) ALWAYS Attempted First
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
  // TIER 1: Street / Road Direct
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

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

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
        const isLow = isLowPrecisionGoogle(item);
        const isCentroid = isCityCentroidCollapse(lat, lng);
        const dist = haversineDistMeters(NAGPUR_LAT, NAGPUR_LNG, lat, lng);

        if (!isLow && !isCentroid && dist <= 45000) {
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
          const isLow = isLowPrecisionNominatim(item);
          const isCentroid = isCityCentroidCollapse(lat, lng);
          const dist = haversineDistMeters(NAGPUR_LAT, NAGPUR_LNG, lat, lng);

          if (!isLow && !isCentroid && dist <= 45000) {
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
        const feat = data.features[0];
        const [lng, lat] = feat.geometry.coordinates;
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          const isLow = isLowPrecisionPhoton(feat);
          const isCentroid = isCityCentroidCollapse(lat, lng);
          const dist = haversineDistMeters(NAGPUR_LAT, NAGPUR_LNG, lat, lng);

          if (!isLow && !isCentroid && dist <= 45000) {
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
  const targetIdx = args.indexOf('--target');
  const isAudit = args.includes('--audit');

  const email = emailIdx !== -1 ? args[emailIdx + 1] : process.env.ADMIN_EMAIL;
  const password = passIdx !== -1 ? args[passIdx + 1] : process.env.ADMIN_PASSWORD;
  const targetShop = targetIdx !== -1 ? args[targetIdx + 1] : null;

  if (email && password) {
    const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({ email, password });
    if (authErr) {
      console.error('Admin authentication failed:', authErr.message);
      process.exit(1);
    }
    console.log(`🔐 Authenticated as admin: ${authData.user.email}`);
  }

  if (isAudit) {
    console.log('📊 Running Problem 3 Scope Audit across retailer_shop_locations...');
    const { data: allRows, error: auditErr } = await supabase
      .from('retailer_shop_locations')
      .select('id, shop_name, street, formatted_address, is_verified, lat, lng');

    if (auditErr) {
      console.error('Audit query error:', auditErr.message);
      return;
    }

    const total = allRows?.length || 0;
    const dumpedStreet = allRows.filter((r) => (r.street || '').length > 50 || ((r.street || '').match(/,/g) || []).length >= 2);
    const hasFormatted = allRows.filter((r) => (r.formatted_address || '').length >= 10 && !isPlaceholderValue(r.formatted_address));
    const zeroMileCollapses = allRows.filter((r) => isCityCentroidCollapse(r.lat, r.lng) && !r.is_verified);

    console.log(`\n--- SCOPE AUDIT SUMMARY ---`);
    console.log(`Total shop locations: ${total}`);
    console.log(`Rows with full address dumped in 'street': ${dumpedStreet.length}`);
    console.log(`Rows with populated 'formatted_address': ${hasFormatted.length}`);
    console.log(`Unverified rows sitting on Zero Mile centroid: ${zeroMileCollapses.length}`);
    return;
  }

  console.log('🚀 Starting batch geocoding with Tier 0 & Fallback Query Ladder...');

  let processed = 0;
  let batchIndex = 0;

  while (true) {
    batchIndex++;
    let query = supabase
      .from('retailer_shop_locations')
      .select('id, shop_name, shop_no, building, street, landmark, area, city, state, pincode, formatted_address')
      .eq('is_verified', false)
      .is('suggested_lat', null)
      .order('created_at', { ascending: false })
      .limit(50);

    if (targetShop) {
      query = query.ilike('shop_name', `%${targetShop}%`);
    }

    const { data: rows, error } = await query;

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

      for (const candidate of ladder) {
        const normKey = normalizeAddressForCache(candidate.query);

        // Cache lookup
        const { data: cached } = await supabase
          .from('geocoding_cache')
          .select('lat, lng, confidence')
          .eq('normalized_address', normKey)
          .maybeSingle();

        if (cached && cached.lat && cached.lng) {
          if (!isCityCentroidCollapse(cached.lat, cached.lng) && haversineDistMeters(NAGPUR_LAT, NAGPUR_LNG, cached.lat, cached.lng) <= 45000) {
            resolved = { lat: cached.lat, lng: cached.lng, confidence: cached.confidence || candidate.defaultConfidence };
            matchedCandidate = candidate;
            process.stdout.write(`⚡ [Cache Hit ${candidate.tier}] ${loc.shop_name} -> ${candidate.query}\n`);
            break;
          }
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

          process.stdout.write(`✅ [${candidate.tier}] ${loc.shop_name} (${resolved.confidence}) -> ${candidate.query}\n`);
          break;
        }

        await sleep(1000);
      }

      const loggedQuery = matchedCandidate ? `[${matchedCandidate.tier}] ${matchedCandidate.query}` : ladder[0].query;

      if (resolved && matchedCandidate) {
        await supabase.rpc('apply_shop_location_suggestion_v2', {
          p_location_id: loc.id,
          p_lat: resolved.lat,
          p_lng: resolved.lng,
          p_confidence: resolved.confidence,
          p_query: loggedQuery,
          p_not_on_maps: false,
          p_error: null,
        });
      } else {
        await supabase.rpc('apply_shop_location_suggestion_v2', {
          p_location_id: loc.id,
          p_lat: null,
          p_lng: null,
          p_confidence: null,
          p_query: loggedQuery,
          p_not_on_maps: true,
          p_error: 'Zero results across fallback ladder (low precision filtered)',
        });
        process.stdout.write(`❌ [Zero Results] ${loc.shop_name} -> ${ladder[0].query}\n`);
      }
    }

    if (targetShop) break;
  }

  console.log(`\n🏁 Finished! Processed ${processed} shop locations.`);
}

if (require.main === module) {
  run();
}
