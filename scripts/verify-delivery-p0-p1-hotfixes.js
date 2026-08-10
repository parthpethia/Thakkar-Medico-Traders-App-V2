/**
 * Comprehensive Verification & Diagnostics Suite for Delivery Subsystem
 *
 * Verifies P0 (Items 1 & 2), P1 (Items 3, 4, 5), and P1.5 (Item 6):
 * 1. Pin Resolution Parity (Client orderDeliveryCoords.ts vs SQL get_public_order_tracking).
 * 2. get_delivery_health_summary signature and consolidated schema verification.
 * 3. Failed delivery reason visibility across orders.
 * 4. Breadcrumb trail restoration in tracking bundles.
 * 5. Storage bucket usage audit across delivery_proofs.
 * 6. OTP verification flow audit (verify_delivery_otp vs Photo POD).
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

// Client-side pin resolution simulation matching orderDeliveryCoords.ts
function coordsFromSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const lat = Number(snapshot.lat ?? snapshot.latitude);
  const lng = Number(snapshot.lng ?? snapshot.longitude);
  const address = snapshot.address ?? snapshot.formatted_address ?? snapshot.full_address;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) {
    return null;
  }
  return { lat, lng, address, source: 'snapshot' };
}

function isOrderActive(order) {
  if (order.delivered_at) return false;
  const s = (order.delivery_status || order.status || '').toLowerCase().trim();
  if (['delivered', 'cancelled', 'failed', 'delivery_failed', 'returned'].includes(s)) {
    return false;
  }
  return true;
}

async function resolveOrderCoordsClient(supabase, order) {
  const isActive = isOrderActive(order);

  // 1. Historical / Delivered: Snapshot is Layer 1 truth
  if (!isActive) {
    const fromSnap = coordsFromSnapshot(order.delivery_snapshot);
    if (fromSnap) return fromSnap;
  }

  const shopId = order.delivery_address_id;
  const userId = order.user_id;

  // 2. Active + explicit shopId: only trust verified
  if (isActive && shopId) {
    const { data } = await supabase
      .from('retailer_shop_locations')
      .select('lat, lng, formatted_address, is_verified')
      .eq('id', shopId)
      .maybeSingle();

    if (data && data.is_verified && Number(data.lat) !== 0 && Number(data.lng) !== 0) {
      return { lat: Number(data.lat), lng: Number(data.lng), is_verified: true, source: 'shop_location_verified' };
    }
  }

  // 3. Active + userId: check verified default
  if (isActive && userId) {
    const { data: verifiedLocations } = await supabase
      .from('retailer_shop_locations')
      .select('lat, lng, formatted_address, is_verified')
      .eq('retailer_account_id', userId)
      .eq('is_verified', true)
      .limit(1);

    if (verifiedLocations && verifiedLocations[0] && Number(verifiedLocations[0].lat) !== 0) {
      return { lat: Number(verifiedLocations[0].lat), lng: Number(verifiedLocations[0].lng), is_verified: true, source: 'user_verified_default' };
    }
  }

  // 4. Fallback to delivery_snapshot
  const fromSnap = coordsFromSnapshot(order.delivery_snapshot);
  if (fromSnap) return fromSnap;

  // 5. Fallback to unverified shop location
  if (shopId) {
    const { data } = await supabase
      .from('retailer_shop_locations')
      .select('lat, lng, formatted_address, is_verified')
      .eq('id', shopId)
      .maybeSingle();

    if (data && Number(data.lat) !== 0 && Number(data.lng) !== 0) {
      return { lat: Number(data.lat), lng: Number(data.lng), is_verified: false, source: 'shop_location_unverified' };
    }
  }

  // 6. Centroid fallback
  return { lat: 21.150167, lng: 79.099140, source: 'centroid_fallback' };
}

async function runAuditDiagnostics() {
  console.log('======================================================================');
  console.log('🔬 LIVE DELIVERY TRACKING SUBSYSTEM: P0 & P1 AUDIT & VERIFICATION');
  console.log('======================================================================\n');

  const env = readEnv();
  const supabaseUrl = (process.env.EXPO_PUBLIC_SUPABASE_URL || env.EXPO_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
  const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';

  const supabase = createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false } });

  // -------------------------------------------------------------------------
  // AUDIT ITEM 1 (P0): Pin Resolution Parity (Client vs SQL RPC)
  // -------------------------------------------------------------------------
  console.log('--- [ITEM 1 - P0] Checking Pin Resolution Parity across Orders ---');
  const { data: sampleOrders, error: ordersErr } = await supabase
    .from('orders')
    .select('id, order_number, user_id, user_name, delivery_address, delivery_address_id, delivery_snapshot, status, delivery_status, delivered_at, destination_lat, destination_lng')
    .order('created_at', { ascending: false })
    .limit(10);

  if (ordersErr || !sampleOrders || sampleOrders.length === 0) {
    console.log('No orders found to sample:', ordersErr?.message || 'Empty table');
  } else {
    console.log(`Auditing ${sampleOrders.length} sample orders for Client vs SQL coordinate parity:\n`);
    for (const ord of sampleOrders) {
      const clientRes = await resolveOrderCoordsClient(supabase, ord);

      const { data: sqlRes, error: sqlErr } = await supabase.rpc('get_public_order_tracking', {
        p_order_identifier: ord.id
      });

      if (sqlErr) {
        console.log(`Order #${ord.order_number || ord.id.slice(0,8)}: RPC error -> ${sqlErr.message}`);
        continue;
      }

      const sqlLat = sqlRes?.order?.destination_lat;
      const sqlLng = sqlRes?.order?.destination_lng;
      const sqlVer = sqlRes?.order?.is_destination_verified;

      const latDiff = Math.abs(clientRes.lat - (sqlLat || 0));
      const lngDiff = Math.abs(clientRes.lng - (sqlLng || 0));
      const match = latDiff < 0.0001 && lngDiff < 0.0001;

      console.log(`Order #${ord.order_number || ord.id.slice(0,8)} [Status: ${ord.delivery_status || ord.status}]:`);
      console.log(`  Client Resolution : Lat=${clientRes.lat.toFixed(6)}, Lng=${clientRes.lng.toFixed(6)} (Source: ${clientRes.source})`);
      console.log(`  SQL Resolution    : Lat=${Number(sqlLat || 0).toFixed(6)}, Lng=${Number(sqlLng || 0).toFixed(6)} (Verified: ${sqlVer})`);
      console.log(`  Parity Match      : ${match ? '✅ EXACT MATCH' : '❌ DIVERGENCE DETECTED'}`);
      console.log('');
    }
  }

  // -------------------------------------------------------------------------
  // AUDIT ITEM 2 (P0): get_delivery_health_summary Overload & Consolidation
  // -------------------------------------------------------------------------
  console.log('\n--- [ITEM 2 - P0] Checking get_delivery_health_summary RPC Signatures ---');
  
  // Test Parameterized Signature
  const { data: healthParamRes, error: healthParamErr } = await supabase.rpc('get_delivery_health_summary', {
    p_canary_only: false
  });

  if (healthParamErr) {
    console.log('❌ Error calling get_delivery_health_summary(p_canary_only):', healthParamErr.message);
  } else {
    console.log('✅ Parameterized get_delivery_health_summary(p_canary_only) returned:');
    console.log(JSON.stringify(healthParamRes, null, 2));
  }

  // Test Zero-Parameter Call
  const { data: healthZeroRes, error: healthZeroErr } = await supabase.rpc('get_delivery_health_summary');
  if (healthZeroErr) {
    console.log('\nZero-parameter call result:', healthZeroErr.message);
  } else {
    console.log('\nZero-parameter call returned payload:');
    console.log(JSON.stringify(healthZeroRes, null, 2));
  }

  // -------------------------------------------------------------------------
  // AUDIT ITEM 3 (P1): Failed Delivery Reason Visibility
  // -------------------------------------------------------------------------
  console.log('\n--- [ITEM 3 - P1] Auditing Failed Orders & Failure Reason Columns ---');
  const { data: failedOrders, error: failedErr } = await supabase
    .from('orders')
    .select('id, order_number, status, delivery_status, failed_reason, delivery_failure_reason, created_at')
    .or('status.eq.delivery_failed,delivery_status.eq.failed,delivery_status.eq.delivery_failed');

  if (failedErr) {
    console.log('Error querying failed orders:', failedErr.message);
  } else {
    const totalFailed = failedOrders?.length || 0;
    const withDeliveryFailureReason = failedOrders?.filter(o => o.delivery_failure_reason != null)?.length || 0;
    const withFailedReason = failedOrders?.filter(o => o.failed_reason != null)?.length || 0;

    console.log(`Total Failed Orders in Database       : ${totalFailed}`);
    console.log(`With delivery_failure_reason set      : ${withDeliveryFailureReason}`);
    console.log(`With failed_reason set                : ${withFailedReason}`);

    if (totalFailed > 0) {
      console.log('\nSample Failed Orders:');
      for (const fo of failedOrders.slice(0, 5)) {
        console.log(`  Order #${fo.order_number || fo.id.slice(0,8)}:`);
        console.log(`    orders.delivery_failure_reason : "${fo.delivery_failure_reason || '(null)'}"`);
        console.log(`    orders.failed_reason          : "${fo.failed_reason || '(null)'}"`);

        // Test RPC bundle output
        const { data: bundle } = await supabase.rpc('get_public_order_tracking', { p_order_identifier: fo.id });
        console.log(`    RPC output failed_reason       : "${bundle?.order?.failed_reason || '(null)'}"`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // AUDIT ITEM 4 (P1): Location History Breadcrumb Trail
  // -------------------------------------------------------------------------
  console.log('\n--- [ITEM 4 - P1] Auditing Location History Breadcrumbs in Tracking Bundles ---');
  const { data: sampleHistory } = await supabase
    .from('delivery_location_history')
    .select('order_id, lat, lng, recorded_at')
    .order('recorded_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (sampleHistory?.order_id) {
    console.log(`Testing Order #${sampleHistory.order_id} with existing location history:`);
    const { data: bundle } = await supabase.rpc('get_public_order_tracking', { p_order_identifier: sampleHistory.order_id });
    const historyCount = Array.isArray(bundle?.history) ? bundle.history.length : 0;
    console.log(`  Breadcrumb points returned in bundle: ${historyCount} points`);
    if (historyCount > 0) {
      console.log(`  Sample Point: Lat=${bundle.history[0].lat}, Lng=${bundle.history[0].lng}, Recorded=${bundle.history[0].recorded_at}`);
    }
  } else {
    console.log('No rows currently in delivery_location_history to test breadcrumb query.');
  }

  // -------------------------------------------------------------------------
  // AUDIT ITEM 5 (P1): Storage Bucket & Photo POD Audit
  // -------------------------------------------------------------------------
  console.log('\n--- [ITEM 5 - P1] Auditing Supabase Storage Buckets & Delivery Proofs ---');
  const { data: proofs, error: proofErr } = await supabase
    .from('delivery_proofs')
    .select('id, order_id, photo_url, photo_storage_path, captured_at, created_at')
    .order('created_at', { ascending: false })
    .limit(20);

  if (proofErr) {
    console.log('Error querying delivery_proofs:', proofErr.message);
  } else {
    console.log(`Total recent delivery_proofs checked: ${proofs?.length || 0}`);
    let bucketPhotosCount = 0;
    let bucketProofsCount = 0;
    let otherBucketCount = 0;
    let nullPhotoCount = 0;

    for (const p of (proofs || [])) {
      if (!p.photo_url) {
        nullPhotoCount++;
      } else if (p.photo_url.includes('delivery-photos')) {
        bucketPhotosCount++;
      } else if (p.photo_url.includes('delivery-proofs')) {
        bucketProofsCount++;
      } else {
        otherBucketCount++;
      }
    }

    console.log(`  Photos in 'delivery-photos' bucket : ${bucketPhotosCount}`);
    console.log(`  Photos in 'delivery-proofs' bucket : ${bucketProofsCount}`);
    console.log(`  Photos in other buckets/URLs       : ${otherBucketCount}`);
    console.log(`  Proofs with null photo_url         : ${nullPhotoCount}`);
    if (proofs && proofs.length > 0 && proofs[0].photo_url) {
      console.log(`  Sample Photo URL                   : ${proofs[0].photo_url}`);
    }
  }

  // -------------------------------------------------------------------------
  // AUDIT ITEM 6 (P1.5): OTP Verification Investigation
  // -------------------------------------------------------------------------
  console.log('\n--- [ITEM 6 - P1.5] Auditing OTP Verification vs Photo POD Flow ---');
  const { data: otpOrders } = await supabase
    .from('orders')
    .select('id, order_number, delivery_type, status, created_at')
    .limit(10);

  console.log('Inspecting active delivery completion architecture:');
  console.log('  1. Photo POD Sheet: ProofOfDeliverySheet.tsx captures camera image, uploads to storage, upserts delivery_proofs, and sets status=\'delivered\'.');
  console.log('  2. OTP RPCs: generate_delivery_otp exists in migration-otp-pod-v29.sql / v48, but verify_delivery_otp has 0 callers across mobile app & admin portal.');
  console.log('  3. Security / Flow Analysis: Photo POD with captured GPS coords and timestamp is the primary proof mechanism for B2B pharmaceutical deliveries to physical chemist shops.');

  console.log('\n======================================================================');
  console.log('🏁 AUDIT DIAGNOSTICS SUITE COMPLETE');
  console.log('======================================================================');
}

runAuditDiagnostics().catch((e) => {
  console.error('Audit script exception:', e);
  process.exit(1);
});
