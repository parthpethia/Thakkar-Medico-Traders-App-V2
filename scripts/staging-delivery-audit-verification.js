/**
 * Staging Delivery Subsystem Verification Script
 *
 * Runs actual live database queries and RPC calls against the configured Supabase instance:
 * 1. Dual-Table Atomic Sync Test (orders + delivery_tracking)
 * 2. Realtime Telemetry Reconnection Event Ingestion & Querying
 * 3. Historical Delivered Order Snapshot Isolation Verification
 * 4. reconcile_historical_delivered_order_snapshots(p_dry_run = true) RPC Execution
 *
 * Usage:
 *   node scripts/staging-delivery-audit-verification.js [--email admin@example.com --password secret] [--service-key <key>]
 */

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

async function runStagingVerification() {
  console.log('===============================================================');
  console.log('🚀 RUNNING STAGING DELIVERY SUBSYSTEM REAL VERIFICATION PROTOCOL');
  console.log('===============================================================\n');

  const env = readEnv();
  const supabaseUrl = (process.env.EXPO_PUBLIC_SUPABASE_URL || env.EXPO_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
  const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';

  const args = process.argv;
  const emailIdx = args.indexOf('--email');
  const passIdx = args.indexOf('--password');
  const serviceKeyIdx = args.indexOf('--service-key');

  const email = emailIdx !== -1 ? args[emailIdx + 1] : (process.env.ADMIN_EMAIL || env.ADMIN_EMAIL);
  const password = passIdx !== -1 ? args[passIdx + 1] : (process.env.ADMIN_PASSWORD || env.ADMIN_PASSWORD);
  const serviceKey = serviceKeyIdx !== -1 ? args[serviceKeyIdx + 1] : (process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY);

  const clientKey = serviceKey || supabaseAnonKey;
  const supabase = createClient(supabaseUrl, clientKey, {
    auth: { persistSession: false }
  });

  if (email && password && !serviceKey) {
    console.log(`🔐 Authenticating as: ${email}`);
    const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({ email, password });
    if (authErr) {
      console.warn('Authentication warning:', authErr.message);
    } else {
      console.log(`✅ Authenticated session established for: ${authData.user?.email} (${authData.user?.id})`);
    }
  }

  console.log(`📡 Supabase Endpoint: ${supabaseUrl}`);

  // ---------------------------------------------------------------------------
  // CHECK 1: Dual-Table Atomic Sync Test
  // ---------------------------------------------------------------------------
  console.log('\n--- CHECK 1: Dual-Table Atomic Sync Test (orders + delivery_tracking) ---');
  try {
    const { data: sampleOrder, error: sampleErr } = await supabase
      .from('orders')
      .select('id, order_number, destination_lat, destination_lng, delivery_status, status')
      .in('status', ['accepted', 'dispatched', 'in_transit'])
      .limit(1)
      .maybeSingle();

    if (sampleErr) {
      console.log('Sample order query notice:', sampleErr.message);
    } else if (sampleOrder) {
      const { data: trackingRow } = await supabase
        .from('delivery_tracking')
        .select('order_id, destination_lat, destination_lng, updated_at')
        .eq('order_id', sampleOrder.id)
        .maybeSingle();

      console.log('Order table record:');
      console.log(`  Order ID: ${sampleOrder.id} (#${sampleOrder.order_number})`);
      console.log(`  orders.destination_lat/lng: ${sampleOrder.destination_lat}, ${sampleOrder.destination_lng}`);
      if (trackingRow) {
        console.log(`  delivery_tracking.destination_lat/lng: ${trackingRow.destination_lat}, ${trackingRow.destination_lng}`);
        console.log(`  delivery_tracking.updated_at: ${trackingRow.updated_at}`);
        const syncMatch = sampleOrder.destination_lat === trackingRow.destination_lat && sampleOrder.destination_lng === trackingRow.destination_lng;
        console.log(`  Atomic Sync Status: ${syncMatch ? '✅ MATCHED' : '⚠️ MISMATCH'}`);
      } else {
        console.log('  delivery_tracking row: (No active tracking row seeded for this order yet)');
      }
    } else {
      console.log('No active in-flight orders currently in database. (Seed active orders to test live sync)');
    }
  } catch (e) {
    console.error('Check 1 error:', e.message);
  }

  // ---------------------------------------------------------------------------
  // CHECK 2: Realtime Reconnect Telemetry Ingestion & Querying
  // ---------------------------------------------------------------------------
  console.log('\n--- CHECK 2: Telemetry Ingestion & Querying (delivery_telemetry_events) ---');
  try {
    const pingId = `test-${Date.now()}`;
    const { error: logErr } = await supabase.rpc('log_delivery_telemetry_event', {
      p_event_type: 'realtime_reconnect',
      p_metadata: { trigger: 'staging_verification_run', ping_id: pingId, client: 'node_verifier' }
    });

    if (logErr) {
      console.log('Telemetry ingestion notice:', logErr.message);
    } else {
      console.log('✅ log_delivery_telemetry_event RPC executed successfully.');
    }

    const { data: latestEvent, error: eventErr } = await supabase
      .from('delivery_telemetry_events')
      .select('id, event_type, metadata, created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (eventErr) {
      console.log('Telemetry query notice:', eventErr.message);
    } else if (latestEvent) {
      console.log('Latest delivery_telemetry_events row:');
      console.log(JSON.stringify(latestEvent, null, 2));
    }
  } catch (e) {
    console.error('Check 2 error:', e.message);
  }

  // ---------------------------------------------------------------------------
  // CHECK 3: Post-Delivery Historical Snapshot Isolation
  // ---------------------------------------------------------------------------
  console.log('\n--- CHECK 3: Historical Delivered Order Snapshot Isolation ---');
  try {
    const { data: deliveredOrders, error: delivErr } = await supabase
      .from('orders')
      .select('id, order_number, destination_lat, destination_lng, delivery_snapshot, delivered_at, status')
      .or('status.eq.delivered,delivery_status.eq.delivered,delivered_at.not.is.null')
      .limit(5);

    if (delivErr) {
      console.log('Delivered orders query notice:', delivErr.message);
    } else if (deliveredOrders && deliveredOrders.length > 0) {
      console.log(`Auditing ${deliveredOrders.length} delivered order sample rows:`);
      deliveredOrders.forEach(o => {
        const snap = o.delivery_snapshot || {};
        console.log(`  Order #${o.order_number}:`);
        console.log(`    Status: ${o.status}, Delivered At: ${o.delivered_at || 'Recorded'}`);
        console.log(`    orders.destination: (${o.destination_lat}, ${o.destination_lng})`);
        console.log(`    delivery_snapshot: (${snap.lat || 'none'}, ${snap.lng || 'none'}) - ${snap.shop_name || 'N/A'}`);
      });
    } else {
      console.log('No delivered orders found in table sample.');
    }
  } catch (e) {
    console.error('Check 3 error:', e.message);
  }

  // ---------------------------------------------------------------------------
  // CHECK 4: reconcile_historical_delivered_order_snapshots(p_dry_run = true)
  // ---------------------------------------------------------------------------
  console.log('\n--- CHECK 4: Live RPC reconcile_historical_delivered_order_snapshots(p_dry_run = true) ---');
  try {
    const { data: auditResult, error: auditErr } = await supabase.rpc('reconcile_historical_delivered_order_snapshots', {
      p_dry_run: true
    });

    if (auditErr) {
      console.log('Audit RPC notice:', auditErr.message);
    } else {
      // Note: Expected to be 0 in this pre-production staging run. In production, a non-zero
      // mismatches_found here is not itself a failure — it means the monitoring caught real drift
      // and the reviewed remediation path (p_dry_run = false, after manual review of the returned row list)
      // should be followed, not treated as an alarm.
      console.log('reconcile_historical_delivered_order_snapshots(true) output:');
      console.log(JSON.stringify(auditResult, null, 2));
    }
  } catch (e) {
    console.error('Check 4 error:', e.message);
  }

  console.log('\n===============================================================');
  console.log('🏁 STAGING VERIFICATION PROTOCOL EXECUTION COMPLETE');
  console.log('===============================================================');
}

runStagingVerification().catch((err) => {
  console.error('Execution error:', err);
});
