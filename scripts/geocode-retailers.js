/**
 * Geocoding Utility for Thakkar Medico Shop Locations
 * 
 * This script scans the database for retailer shop locations that currently have
 * coordinates set to 0,0 (or are missing), calls the Google Geocoding API, and
 * updates their latitude and longitude coordinates.
 * 
 * Usage:
 * 1. Get your Supabase "service_role" key from:
 *    Supabase Dashboard → Project Settings → API → service_role key
 * 2. Run the script:
 *    node scripts/geocode-retailers.js <your_service_role_key>
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

// Helper to read .env
function readEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

// Custom promise wrapper for HTTPS requests
function makeRequest(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Timeout')));
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function main() {
  const serviceRoleKey = process.argv[2];
  if (!serviceRoleKey) {
    console.error('ERROR: Missing Supabase service_role key.');
    console.log('\nUsage:');
    console.log('  node scripts/geocode-retailers.js <your_service_role_key>');
    process.exit(1);
  }

  const env = readEnv();
  const supabaseUrl = (process.env.EXPO_PUBLIC_SUPABASE_URL || env.EXPO_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
  const googleApiKey = process.env.EXPO_PUBLIC_GOOGLE_VISION_API_KEY || env.EXPO_PUBLIC_GOOGLE_VISION_API_KEY || '';

  if (!supabaseUrl) {
    console.error('ERROR: EXPO_PUBLIC_SUPABASE_URL not found in .env');
    process.exit(1);
  }
  if (!googleApiKey) {
    console.error('ERROR: EXPO_PUBLIC_GOOGLE_VISION_API_KEY (Google Maps Key) not found in .env');
    process.exit(1);
  }

  console.log(`Connecting to Supabase at: ${supabaseUrl}`);
  console.log('Fetching retailer shop locations with 0,0 coordinates...');

  // Query shop locations where lat = 0 and lng = 0
  const selectUrl = `${supabaseUrl}/rest/v1/retailer_shop_locations?lat=eq.0&lng=eq.0&select=id,shop_name,formatted_address,street,city,state,pincode`;
  const selectHeaders = {
    'apikey': serviceRoleKey,
    'Authorization': `Bearer ${serviceRoleKey}`
  };

  const { status, body } = await makeRequest(selectUrl, { method: 'GET', headers: selectHeaders });
  if (status !== 200) {
    console.error(`ERROR: Failed to fetch shop locations (Status ${status})`);
    console.error(body);
    process.exit(1);
  }

  const locations = JSON.parse(body);
  console.log(`Found ${locations.length} locations to geocode.`);

  if (locations.length === 0) {
    console.log('All locations are already geocoded!');
    process.exit(0);
  }

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < locations.length; i++) {
    const loc = locations[i];
    
    // Build address query
    let addressQuery = loc.formatted_address || '';
    if (!addressQuery || addressQuery.trim() === '') {
      addressQuery = `${loc.street || ''}, ${loc.city || ''}, ${loc.state || ''} ${loc.pincode || ''}`;
    }
    addressQuery = addressQuery.trim().replace(/^,\s*|,\s*$/g, '');

    if (!addressQuery) {
      console.log(`[${i + 1}/${locations.length}] Skipping "${loc.shop_name}" (No address text)`);
      continue;
    }

    console.log(`[${i + 1}/${locations.length}] Geocoding "${loc.shop_name}" -> "${addressQuery}"`);

    try {
      const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(addressQuery)}&key=${googleApiKey}`;
      const { status: gStatus, body: gBody } = await makeRequest(geocodeUrl, { method: 'GET' });

      if (gStatus !== 200) {
        console.error(`  Google API HTTP ${gStatus} error`);
        failCount++;
        continue;
      }

      const response = JSON.parse(gBody);
      if (response.status !== 'OK' || !response.results?.[0]) {
        console.warn(`  Google Geocoding failed: status ${response.status}`);
        failCount++;
        continue;
      }

      const result = response.results[0];
      const { lat, lng } = result.geometry.location;
      const formatted = result.formatted_address;

      console.log(`  Resolved coordinates: ${lat}, ${lng} (${formatted})`);

      // Update in Supabase
      const updateUrl = `${supabaseUrl}/rest/v1/retailer_shop_locations?id=eq.${loc.id}`;
      const updateHeaders = {
        'apikey': serviceRoleKey,
        'Authorization': `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      };
      
      const updatePayload = {
        lat,
        lng,
        formatted_address: formatted
      };

      const { status: uStatus, body: uBody } = await makeRequest(
        updateUrl, 
        { method: 'PATCH', headers: updateHeaders }, 
        updatePayload
      );

      if (uStatus === 200 || uStatus === 204) {
        console.log('  Updated successfully.');
        successCount++;
      } else {
        console.error(`  Failed to update database: Status ${uStatus}`);
        console.error(uBody);
        failCount++;
      }

    } catch (err) {
      console.error(`  Error geocoding location: ${err.message}`);
      failCount++;
    }

    // Wait a brief moment to avoid hitting API rate limits
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log(`\nGeocoding finished!`);
  console.log(`Successfully updated: ${successCount}`);
  console.log(`Failed/Skipped: ${failCount}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
