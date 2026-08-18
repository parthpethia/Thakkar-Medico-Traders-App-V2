-- =============================================================================
-- Thakkar Medico — V84: Live Delivery Tracking Hotfixes (P0 & P1)
--
-- 1. ITEM 1 (P0): Eliminates Pin Resolution Divergence between Client & SQL.
--    - SQL resolution in get_public_order_tracking now applies EXACT same precedence
--      as orderDeliveryCoords.ts: verified shop location first -> delivery_snapshot
--      second -> unverified shop location third -> centroid fallback.
-- 2. ITEM 2 (P0): Resolves get_delivery_health_summary function overload collision.
--    - Explicitly drops parameterless get_delivery_health_summary().
--    - Consolidates active fleet metrics (active orders, battery averages, stationary)
--      into single get_delivery_health_summary(p_canary_only boolean DEFAULT false).
-- 3. ITEM 3 (P1): Reads COALESCE(delivery_failure_reason, failed_reason) so failed
--    order reasons surface correctly in get_public_order_tracking & bundle.
-- 4. ITEM 4 (P1): Corrects 50-point location history breadcrumb query in
--    get_public_order_tracking to select the 50 LATEST coordinates aggregated
--    in ascending chronological order.
-- 5. ITEM 5 (P1): Complete order payload (delivery_snapshot, landmark, user_phone)
--    for full web/mobile client compatibility.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- SECTION 0: Rate Limiting Table & Performance Indexes
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.public_tracking_rate_limits (
  ip_key          text PRIMARY KEY,
  request_count   int NOT NULL DEFAULT 1,
  last_request_at timestamptz NOT NULL DEFAULT now()
);

-- Ensure backward-compatible columns exist
ALTER TABLE public.public_tracking_rate_limits
  ADD COLUMN IF NOT EXISTS ip_key text,
  ADD COLUMN IF NOT EXISTS last_request_at timestamptz DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_tracking_rate_limits_last_req
  ON public.public_tracking_rate_limits (last_request_at);

-- Composite index on delivery_location_history for sub-millisecond breadcrumb lookup
CREATE INDEX IF NOT EXISTS idx_delivery_location_history_order_recorded
  ON public.delivery_location_history (order_id, recorded_at DESC);

-- Index on delivery_tracking rider lookups
CREATE INDEX IF NOT EXISTS idx_delivery_tracking_rider_id
  ON public.delivery_tracking (rider_id);

-- -----------------------------------------------------------------------------
-- SECTION 1: Drop parameterless get_delivery_health_summary overload
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_delivery_health_summary();

-- -----------------------------------------------------------------------------
-- SECTION 2: Consolidated & Optimized get_delivery_health_summary
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_delivery_health_summary(p_canary_only boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
  v_caller_role          text;
  v_breakers_count       integer := 0;
  v_rider_issues_count   integer := 0;
  v_reconnects_count     integer := 0;
  v_recalcs_count        integer := 0;
  v_shifts_count         integer := 0;
  v_mismatches_found     integer := 0;
  v_total_checked        integer := 0;
  v_auto_healed_count    integer := 0;
  v_last_audit_at        timestamptz;
  v_canary_riders_count  integer := 0;
  v_total_riders_count   integer := 0;
  v_canary_rider_ids     uuid[] := ARRAY[]::uuid[];
  -- Fleet metrics (from v81)
  v_active_tracking_count integer := 0;
  v_stationary_count      integer := 0;
  v_signal_lost_count     integer := 0;
  v_off_route_count       integer := 0;
  v_geofence_arrived_count integer := 0;
  v_avg_battery_level     numeric := 0;
BEGIN
  -- Verify caller is admin or delivery role
  SELECT role INTO v_caller_role
    FROM public.profiles
   WHERE id = auth.uid();

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'delivery') THEN
    RETURN jsonb_build_object(
      'error', 'Unauthorized: Only admins and delivery staff can view health metrics',
      'circuit_breakers_24h', 0,
      'rider_issues_24h', 0,
      'realtime_reconnects_24h', 0,
      'off_route_recalcs_24h', 0,
      'destination_shifts_24h', 0,
      'active_tracking_count', 0
    );
  END IF;

  -- 1. Fetch canary rider list and count in a single query
  SELECT
    COALESCE(array_agg(rider_id), ARRAY[]::uuid[]),
    COUNT(*)::integer
  INTO
    v_canary_rider_ids,
    v_canary_riders_count
  FROM public.canary_rider_flags
  WHERE feature_set = 'delivery_flow_v2'
    AND enabled = true;

  v_canary_rider_ids := COALESCE(v_canary_rider_ids, ARRAY[]::uuid[]);

  -- Total riders registered
  SELECT COUNT(*)::integer
    INTO v_total_riders_count
    FROM public.profiles
   WHERE role = 'delivery';

  -- 2. Telemetry metrics in last 24 hours (with cohort scoping)
  SELECT
    COUNT(*) FILTER (WHERE event_type = 'auto_circuit_breaker_triggered')::integer,
    COUNT(*) FILTER (WHERE event_type = 'rider_reported_issue')::integer,
    COUNT(*) FILTER (WHERE event_type = 'realtime_reconnect')::integer,
    COUNT(*) FILTER (WHERE event_type = 'off_route_recalculation')::integer,
    COUNT(*) FILTER (WHERE event_type = 'destination_shifted')::integer
  INTO
    v_breakers_count,
    v_rider_issues_count,
    v_reconnects_count,
    v_recalcs_count,
    v_shifts_count
  FROM public.delivery_telemetry_events
  WHERE created_at >= (now() - interval '24 hours')
    AND (
      NOT p_canary_only
      OR actor_id = ANY(v_canary_rider_ids)
      OR (metadata->>'rider_id')::uuid = ANY(v_canary_rider_ids)
    );

  -- 3. Latest historical snapshot reconciliation audit status
  SELECT
    total_orders_checked,
    mismatches_found,
    auto_healed_count,
    created_at
  INTO
    v_total_checked,
    v_mismatches_found,
    v_auto_healed_count,
    v_last_audit_at
  FROM public.delivery_integrity_health_log
  WHERE audit_type = 'historical_delivered_snapshot_check'
  ORDER BY created_at DESC
  LIMIT 1;

  -- 4. Active Fleet & Telematics Metrics (consolidated from v81)
  SELECT
    COUNT(*)::integer,
    COUNT(*) FILTER (WHERE is_stationary = true)::integer,
    COUNT(*) FILTER (WHERE signal_lost = true)::integer,
    COUNT(*) FILTER (WHERE is_off_route = true)::integer,
    COUNT(*) FILTER (WHERE geofence_arrived = true)::integer,
    COALESCE(ROUND(AVG(battery_level) FILTER (WHERE battery_level IS NOT NULL), 1), 0)
  INTO
    v_active_tracking_count,
    v_stationary_count,
    v_signal_lost_count,
    v_off_route_count,
    v_geofence_arrived_count,
    v_avg_battery_level
  FROM public.delivery_tracking
  WHERE updated_at >= (now() - interval '1 hour')
    AND (
      NOT p_canary_only
      OR rider_id = ANY(v_canary_rider_ids)
    );

  -- 5. Construct comprehensive telemetry + fleet response
  RETURN jsonb_build_object(
    'circuit_breakers_24h', COALESCE(v_breakers_count, 0),
    'rider_issues_24h', COALESCE(v_rider_issues_count, 0),
    'realtime_reconnects_24h', COALESCE(v_reconnects_count, 0),
    'off_route_recalcs_24h', COALESCE(v_recalcs_count, 0),
    'destination_shifts_24h', COALESCE(v_shifts_count, 0),
    'mismatches_found', COALESCE(v_mismatches_found, 0),
    'total_checked', COALESCE(v_total_checked, 0),
    'auto_healed_count', COALESCE(v_auto_healed_count, 0),
    'last_audit_at', v_last_audit_at,
    'canary_riders_active', COALESCE(v_canary_riders_count, 0),
    'total_riders_registered', COALESCE(v_total_riders_count, 0),
    'p_canary_only', p_canary_only,
    -- Consolidated fleet metrics
    'active_tracking_count', COALESCE(v_active_tracking_count, 0),
    'stationary_count', COALESCE(v_stationary_count, 0),
    'signal_lost_count', COALESCE(v_signal_lost_count, 0),
    'off_route_count', COALESCE(v_off_route_count, 0),
    'geofence_arrived_count', COALESCE(v_geofence_arrived_count, 0),
    'avg_battery_level', v_avg_battery_level,
    'status', CASE
      WHEN COALESCE(v_breakers_count, 0) > 0 THEN 'warning_circuit_breaker_tripped'
      WHEN COALESCE(v_mismatches_found, 0) > 0 THEN 'warning_snapshot_mismatches'
      ELSE 'healthy'
    END
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_delivery_health_summary(boolean) TO authenticated;

-- -----------------------------------------------------------------------------
-- SECTION 3: Aligned, Hardened & Rate-Limited get_public_order_tracking
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_public_order_tracking(p_order_identifier text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
  v_caller_ip       text;
  v_rate_key        text;
  v_request_count   integer := 1;
  v_clean_id        text;
  v_order_uuid      uuid := NULL;
  v_order           public.orders%ROWTYPE;
  v_tracking        public.delivery_tracking%ROWTYPE;
  v_rider           public.profiles%ROWTYPE;
  v_proof           public.delivery_proofs%ROWTYPE;
  v_shop            public.retailer_shop_locations%ROWTYPE;
  v_history         jsonb := '[]'::jsonb;
  v_dest_lat        double precision := NULL;
  v_dest_lng        double precision := NULL;
  v_is_verified     boolean := false;
  v_shop_name       text := 'Retailer Shop';
  v_address         text := '';
  v_is_active       boolean := true;
  v_snap_lat        double precision := NULL;
  v_snap_lng        double precision := NULL;
BEGIN
  -- Input Validation
  IF p_order_identifier IS NULL OR length(trim(p_order_identifier)) < 3 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Invalid order identifier (minimum 3 characters required).'
    );
  END IF;

  v_clean_id := trim(p_order_identifier);

  -- Rate limiting protection (30 requests/minute per IP)
  BEGIN
    v_caller_ip := current_setting('request.headers', true)::json->>'x-forwarded-for';
    IF v_caller_ip IS NOT NULL AND position(',' in v_caller_ip) > 0 THEN
      v_caller_ip := trim(split_part(v_caller_ip, ',', 1));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_caller_ip := 'unknown_client';
  END;

  IF v_caller_ip IS NULL OR v_caller_ip = '' THEN
    v_caller_ip := 'unknown_client';
  END IF;

  v_rate_key := v_caller_ip || '_' || to_char(now(), 'YYYYMMDD_HH24MI');

  BEGIN
    INSERT INTO public.public_tracking_rate_limits (ip_key, request_count, last_request_at)
    VALUES (v_rate_key, 1, now())
    ON CONFLICT (ip_key)
    DO UPDATE SET
      request_count = public.public_tracking_rate_limits.request_count + 1,
      last_request_at = now()
    RETURNING request_count INTO v_request_count;

    IF v_request_count > 30 THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Too many requests. Please wait a minute before trying again.',
        'rate_limited', true
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Non-fatal fallback for rate limit errors
    NULL;
  END;

  -- Fast Exact Match by UUID or Order Number (utilizing index)
  IF v_clean_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_order_uuid := v_clean_id::uuid;
    SELECT * INTO v_order FROM public.orders WHERE id = v_order_uuid LIMIT 1;
  ELSE
    SELECT * INTO v_order
      FROM public.orders
     WHERE order_number = v_clean_id
        OR order_number = 'ORD-' || v_clean_id
        OR order_number ILIKE v_clean_id
        OR order_number ILIKE 'ORD-' || v_clean_id
     ORDER BY created_at DESC
     LIMIT 1;
  END IF;

  IF v_order.id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Order not found. Please verify the order number or tracking link.'
    );
  END IF;

  -- Determine if order is active vs terminal
  v_is_active := (v_order.delivered_at IS NULL AND
                  COALESCE(v_order.delivery_status, v_order.status, '') NOT IN ('delivered', 'cancelled', 'failed', 'delivery_failed', 'returned'));

  -- Extract snapshot coordinates if available
  IF v_order.delivery_snapshot IS NOT NULL AND v_order.delivery_snapshot <> 'null'::jsonb THEN
    BEGIN
      v_snap_lat := NULLIF((v_order.delivery_snapshot->>'lat'), '')::double precision;
      v_snap_lng := NULLIF((v_order.delivery_snapshot->>'lng'), '')::double precision;
      IF v_snap_lat IS NULL OR v_snap_lng IS NULL THEN
        v_snap_lat := NULLIF((v_order.delivery_snapshot->>'latitude'), '')::double precision;
        v_snap_lng := NULLIF((v_order.delivery_snapshot->>'longitude'), '')::double precision;
      END IF;
      IF v_snap_lat = 0 AND v_snap_lng = 0 THEN
        v_snap_lat := NULL;
        v_snap_lng := NULL;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_snap_lat := NULL;
      v_snap_lng := NULL;
    END;
  END IF;

  -- ---------------------------------------------------------------------------
  -- PIN RESOLUTION LADDER (Aligned with orderDeliveryCoords.ts)
  -- ---------------------------------------------------------------------------

  -- Priority 1: For completed / delivered orders, snapshot is Layer 1 immutable truth
  IF NOT v_is_active AND v_snap_lat IS NOT NULL AND v_snap_lng IS NOT NULL THEN
    v_dest_lat := v_snap_lat;
    v_dest_lng := v_snap_lng;
    v_is_verified := false;
    v_shop_name := COALESCE(v_order.delivery_snapshot->>'shop_name', v_order.user_name, 'Retailer Shop');
    v_address := COALESCE(v_order.delivery_snapshot->>'full_address', v_order.delivery_address, '');
  END IF;

  -- Priority 2: For active orders with explicit delivery_address_id, ONLY trust verified shop pin
  IF v_dest_lat IS NULL AND v_is_active AND v_order.delivery_address_id IS NOT NULL THEN
    SELECT * INTO v_shop FROM public.retailer_shop_locations WHERE id = v_order.delivery_address_id LIMIT 1;
    IF v_shop.id IS NOT NULL AND v_shop.lat IS NOT NULL AND v_shop.lng IS NOT NULL AND (v_shop.lat != 0 OR v_shop.lng != 0) THEN
      IF v_shop.is_verified = true THEN
        v_dest_lat := v_shop.lat;
        v_dest_lng := v_shop.lng;
        v_is_verified := true;
        v_shop_name := v_shop.shop_name;
        v_address := COALESCE(v_shop.formatted_address, NULLIF(concat_ws(', ', NULLIF(trim(v_shop.street), ''), NULLIF(trim(v_shop.area), ''), NULLIF(trim(v_shop.city), ''), NULLIF(trim(v_shop.pincode), '')), ''), v_order.delivery_address, '');
      END IF;
    END IF;
  END IF;

  -- Priority 3: For active orders, check user's verified default shop location
  IF v_dest_lat IS NULL AND v_is_active AND v_order.user_id IS NOT NULL THEN
    SELECT * INTO v_shop
      FROM public.retailer_shop_locations
     WHERE retailer_account_id = v_order.user_id
       AND is_verified = true
       AND lat != 0 AND lng != 0
     ORDER BY is_default DESC, updated_at DESC
     LIMIT 1;

    IF v_shop.id IS NOT NULL THEN
      v_dest_lat := v_shop.lat;
      v_dest_lng := v_shop.lng;
      v_is_verified := true;
      v_shop_name := v_shop.shop_name;
      v_address := COALESCE(v_shop.formatted_address, NULLIF(concat_ws(', ', NULLIF(trim(v_shop.street), ''), NULLIF(trim(v_shop.area), ''), NULLIF(trim(v_shop.city), ''), NULLIF(trim(v_shop.pincode), '')), ''), v_order.delivery_address, '');
    END IF;
  END IF;

  -- Priority 4: Fallback to delivery_snapshot (active order without verified pin)
  IF v_dest_lat IS NULL AND v_snap_lat IS NOT NULL AND v_snap_lng IS NOT NULL THEN
    v_dest_lat := v_snap_lat;
    v_dest_lng := v_snap_lng;
    v_is_verified := false;
    v_shop_name := COALESCE(v_order.delivery_snapshot->>'shop_name', v_order.user_name, 'Retailer Shop');
    v_address := COALESCE(v_order.delivery_snapshot->>'full_address', v_order.delivery_address, '');
  END IF;

  -- Priority 5: Fallback to unverified shop location if coordinates exist
  IF v_dest_lat IS NULL AND v_order.delivery_address_id IS NOT NULL THEN
    SELECT * INTO v_shop FROM public.retailer_shop_locations WHERE id = v_order.delivery_address_id LIMIT 1;
    IF v_shop.id IS NOT NULL AND v_shop.lat IS NOT NULL AND v_shop.lng IS NOT NULL AND (v_shop.lat != 0 OR v_shop.lng != 0) THEN
      v_dest_lat := v_shop.lat;
      v_dest_lng := v_shop.lng;
      v_is_verified := false;
      v_shop_name := v_shop.shop_name;
      v_address := COALESCE(v_shop.formatted_address, NULLIF(concat_ws(', ', NULLIF(trim(v_shop.street), ''), NULLIF(trim(v_shop.area), ''), NULLIF(trim(v_shop.city), ''), NULLIF(trim(v_shop.pincode), '')), ''), v_order.delivery_address, '');
    END IF;
  END IF;

  -- Priority 6: Fallback to destination_lat on orders or delivery_tracking
  IF v_dest_lat IS NULL THEN
    SELECT * INTO v_tracking FROM public.delivery_tracking WHERE order_id = v_order.id LIMIT 1;
    IF v_order.destination_lat IS NOT NULL AND v_order.destination_lng IS NOT NULL AND (v_order.destination_lat != 0 OR v_order.destination_lng != 0) THEN
      v_dest_lat := v_order.destination_lat;
      v_dest_lng := v_order.destination_lng;
    ELSIF v_tracking.destination_lat IS NOT NULL AND v_tracking.destination_lng IS NOT NULL AND (v_tracking.destination_lat != 0 OR v_tracking.destination_lng != 0) THEN
      v_dest_lat := v_tracking.destination_lat;
      v_dest_lng := v_tracking.destination_lng;
    END IF;
    v_shop_name := COALESCE(v_order.user_name, 'Retailer Shop');
    v_address := COALESCE(v_order.delivery_address, 'Nagpur, Maharashtra');
  END IF;

  -- Priority 7: Deterministic fallback centroid near warehouse
  IF v_dest_lat IS NULL OR v_dest_lng IS NULL OR (v_dest_lat = 0 AND v_dest_lng = 0) THEN
    v_dest_lat := 21.150167;
    v_dest_lng := 79.099140;
    v_shop_name := COALESCE(v_order.user_name, 'Retailer Shop');
    v_address := COALESCE(v_order.delivery_address, 'Nagpur, Maharashtra');
  END IF;

  -- Load Tracking Telemetry row
  SELECT * INTO v_tracking FROM public.delivery_tracking WHERE order_id = v_order.id LIMIT 1;

  -- Load Location History: 50 LATEST breadcrumbs aggregated chronologically (recorded_at ASC)
  SELECT COALESCE(jsonb_agg(h_sub ORDER BY h_sub.recorded_at ASC), '[]'::jsonb)
    INTO v_history
    FROM (
      SELECT lat, lng, heading, speed, recorded_at
        FROM public.delivery_location_history
       WHERE order_id = v_order.id
       ORDER BY recorded_at DESC
       LIMIT 50
    ) h_sub;

  -- Load Assigned Rider Profile
  IF v_order.assigned_to IS NOT NULL THEN
    SELECT * INTO v_rider FROM public.profiles WHERE id = v_order.assigned_to LIMIT 1;
  ELSIF v_tracking.rider_id IS NOT NULL THEN
    SELECT * INTO v_rider FROM public.profiles WHERE id = v_tracking.rider_id LIMIT 1;
  END IF;

  -- Load Delivery Proof (Photo POD)
  SELECT * INTO v_proof FROM public.delivery_proofs WHERE order_id = v_order.id LIMIT 1;

  -- Return complete payload with full web/mobile client compatibility
  RETURN jsonb_build_object(
    'success', true,
    'order', jsonb_build_object(
      'id', v_order.id,
      'order_number', v_order.order_number,
      'status', v_order.status,
      'delivery_status', COALESCE(v_order.delivery_status, v_order.status),
      'payment_mode', v_order.payment_mode,
      'grand_total', v_order.grand_total,
      'created_at', v_order.created_at,
      'assigned_at', v_order.assigned_at,
      'dispatched_at', v_order.dispatched_at,
      'delivered_at', v_order.delivered_at,
      'failed_reason', COALESCE(v_order.delivery_failure_reason, v_order.failed_reason),
      'delivery_failure_reason', COALESCE(v_order.delivery_failure_reason, v_order.failed_reason),
      'user_name', v_shop_name,
      'user_phone', v_order.user_phone,
      'user_id', v_order.user_id,
      'assigned_to', v_order.assigned_to,
      'delivery_address_id', v_order.delivery_address_id,
      'delivery_snapshot', v_order.delivery_snapshot,
      'delivery_address', v_address,
      'destination_lat', v_dest_lat,
      'destination_lng', v_dest_lng,
      'is_destination_verified', v_is_verified,
      'items_count', jsonb_array_length(COALESCE(v_order.items, '[]'::jsonb))
    ),
    'tracking', CASE
      WHEN v_tracking.id IS NOT NULL THEN jsonb_build_object(
        'lat', v_tracking.lat,
        'lng', v_tracking.lng,
        'heading', v_tracking.heading,
        'speed', v_tracking.speed,
        'battery_level', v_tracking.battery_level,
        'is_stationary', v_tracking.is_stationary,
        'signal_lost', v_tracking.signal_lost,
        'is_off_route', v_tracking.is_off_route,
        'geofence_arrived', v_tracking.geofence_arrived,
        'updated_at', v_tracking.updated_at
      )
      ELSE NULL
    END,
    'history', v_history,
    'rider', CASE
      WHEN v_rider.id IS NOT NULL THEN jsonb_build_object(
        'name', COALESCE(v_rider.name, v_rider.business_name, 'Delivery Partner'),
        'phone', v_rider.phone
      )
      ELSE NULL
    END,
    'proof', CASE
      WHEN v_proof.id IS NOT NULL THEN jsonb_build_object(
        'photo_url', v_proof.photo_url,
        'captured_at', v_proof.captured_at,
        'notes', v_proof.notes
      )
      ELSE NULL
    END
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_public_order_tracking(text) TO anon, authenticated;

-- -----------------------------------------------------------------------------
-- SECTION 4: Resilient get_order_tracking_bundle
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_order_tracking_bundle(p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
  v_bundle jsonb;
BEGIN
  IF p_order_id IS NULL THEN
    RETURN jsonb_build_object('error', 'order_id_required');
  END IF;

  v_bundle := public.get_public_order_tracking(p_order_id::text);

  IF v_bundle IS NULL OR (v_bundle->>'success')::boolean IS NOT TRUE THEN
    RETURN jsonb_build_object(
      'error', COALESCE(v_bundle->>'error', 'Order tracking bundle not found'),
      'order', NULL,
      'tracking', NULL,
      'history', '[]'::jsonb,
      'rider', NULL,
      'proof', NULL,
      'timeline', NULL
    );
  END IF;

  RETURN jsonb_build_object(
    'order', v_bundle->'order',
    'tracking', v_bundle->'tracking',
    'history', COALESCE(v_bundle->'history', '[]'::jsonb),
    'rider', v_bundle->'rider',
    'proof', v_bundle->'proof',
    'timeline', jsonb_build_object(
      'placed_at', v_bundle->'order'->>'created_at',
      'confirmed_at', COALESCE(v_bundle->'order'->>'assigned_at', v_bundle->'order'->>'created_at'),
      'dispatched_at', v_bundle->'order'->>'dispatched_at',
      'delivered_at', v_bundle->'order'->>'delivered_at',
      'failed_at', CASE
        WHEN v_bundle->'order'->>'delivery_status' = 'failed' OR v_bundle->'order'->>'status' = 'delivery_failed'
        THEN COALESCE(v_bundle->'order'->>'delivered_at', v_bundle->'order'->>'created_at')
        ELSE NULL
      END
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_order_tracking_bundle(uuid) TO anon, authenticated;

COMMIT;

