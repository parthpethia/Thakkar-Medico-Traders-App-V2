const { createClient } = require('@supabase/supabase-js');
const fs = require('node:fs');
const path = require('node:path');

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

const env = readEnv();
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL || env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function runDiagnostic() {
  console.log('--- RUNNING HISTORICAL DAMAGE DIAGNOSTIC ---');

  // Fetch delivered orders
  const { data: deliveredOrders, error } = await sb
    .from('orders')
    .select('id, order_number, destination_lat, destination_lng, delivery_snapshot, delivered_at, status, delivery_status, delivery_address_id')
    .or('status.eq.delivered,delivery_status.eq.delivered,delivered_at.not.is.null')
    .limit(1000);

  if (error) {
    console.error('Error querying orders:', error.message);
    process.exit(1);
  }

  console.log(`Total delivered orders fetched: ${deliveredOrders.length}`);

  let totalWithSnapshot = 0;
  const mismatches = [];

  for (const o of deliveredOrders) {
    const snap = o.delivery_snapshot;
    if (!snap || typeof snap !== 'object') continue;

    const snapLat = snap.lat != null ? Number(snap.lat) : null;
    const snapLng = snap.lng != null ? Number(snap.lng) : null;

    if (snapLat != null && snapLng != null && (snapLat !== 0 || snapLng !== 0)) {
      totalWithSnapshot++;

      const destLat = o.destination_lat != null ? Number(o.destination_lat) : 0;
      const destLng = o.destination_lng != null ? Number(o.destination_lng) : 0;

      const latDiff = Math.abs(destLat - snapLat);
      const lngDiff = Math.abs(destLng - snapLng);

      if (latDiff > 0.0001 || lngDiff > 0.0001) {
        mismatches.push({
          id: o.id,
          order_number: o.order_number || o.id.slice(0, 8),
          current_dest_lat: destLat,
          current_dest_lng: destLng,
          snapshot_lat: snapLat,
          snapshot_lng: snapLng,
          lat_diff_meters: Math.round(latDiff * 111000),
          lng_diff_meters: Math.round(lngDiff * 111000),
          delivered_at: o.delivered_at,
          status: o.status,
          delivery_address_id: o.delivery_address_id,
        });
      }
    }
  }

  console.log(`\n========================================`);
  console.log(`DIAGNOSTIC RESULTS:`);
  console.log(`Total delivered orders with valid snapshot: ${totalWithSnapshot}`);
  console.log(`Mismatches count: ${mismatches.length}`);
  console.log(`========================================\n`);

  if (mismatches.length > 0) {
    console.log('Affected orders preview:');
    console.table(mismatches);
  } else {
    console.log('✓ Zero delivered orders have destination_lat/lng mismatch against delivery_snapshot.');
  }
}

runDiagnostic();
