-- =============================================================================
-- Migration v81: Delivery Subsystem Scale, Rate Limiting & Vulnerability Hardening
--
-- Fixes & Features:
-- 1. Fixes PL/pgSQL error 55000 (indeterminate record structure) in get_public_order_tracking
--    by using typed `public.orders%ROWTYPE`.
-- 2. Eliminates insecure loose substring matching on get_public_order_tracking to prevent
--    unauthorized customer and order scraping.
-- 3. Adds IP-based rate limiting (max 30 requests/minute per IP) backed by
--    `public.public_tracking_rate_limits` table.
-- 4. Adds `is_stationary` and `signal_lost` columns to `public.delivery_tracking`.
-- 5. Optimizes `get_delivery_health_summary` to single-pass grouped aggregation.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Ensure Columns on public.delivery_tracking
-- -----------------------------------------------------------------------------
ALTER TABLE public.delivery_tracking
  ADD COLUMN IF NOT EXISTS is_stationary boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS signal_lost boolean DEFAULT false;

-- -----------------------------------------------------------------------------
-- 2. Public Tracking Rate Limiting Table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.public_tracking_rate_limits (
  ip_hash         text PRIMARY KEY,
  window_start    timestamptz NOT NULL DEFAULT now(),
  request_count   int NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_tracking_rate_limits_window 
  ON public.public_tracking_rate_limits (window_start);

ALTER TABLE public.public_tracking_rate_limits ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 3. Hardened & Rate-Limited Public RPC: get_public_order_tracking
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_public_order_tracking(p_order_identifier text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
  v_order public.orders%ROWTYPE; -- Strongly-typed row prevents 55000 error
  v_tracking record;
  v_rider record;
  v_proof record;
  v_shop record;
  v_items_count int := 0;
  v_clean_id text;
  v_order_uuid uuid;
  v_dest_lat double precision := NULL;
  v_dest_lng double precision := NULL;
  v_shop_name text := NULL;
  v_shop_address text := NULL;
  v_is_verified boolean := false;
  v_client_ip text;
  v_ip_hash text;
  v_limit_rec record;
  c_max_requests CONSTANT int := 30; -- Max 30 requests/minute per IP
BEGIN
  -- A. Rate Limiting Check (PostgREST headers or fallback)
  BEGIN
    v_client_ip := COALESCE(
      current_setting('request.headers', true)::json->>'cf-connecting-ip',
      current_setting('request.headers', true)::json->>'x-real-ip',
      current_setting('request.headers', true)::json->>'x-forwarded-for',
      'anon_client'
    );
  EXCEPTION WHEN OTHERS THEN
    v_client_ip := 'anon_client';
  END;

  -- Take first IP if multiple present in x-forwarded-for
  v_client_ip := trim(split_part(v_client_ip, ',', 1));
  v_ip_hash := md5('tm_track_salt_' || v_client_ip);

  SELECT * INTO v_limit_rec FROM public.public_tracking_rate_limits WHERE ip_hash = v_ip_hash;

  IF v_limit_rec.ip_hash IS NULL THEN
    INSERT INTO public.public_tracking_rate_limits (ip_hash, window_start, request_count)
    VALUES (v_ip_hash, now(), 1)
    ON CONFLICT (ip_hash) DO NOTHING;
  ELSIF v_limit_rec.window_start < now() - interval '1 minute' THEN
    UPDATE public.public_tracking_rate_limits
       SET window_start = now(), request_count = 1
     WHERE ip_hash = v_ip_hash;
  ELSE
    IF v_limit_rec.request_count >= c_max_requests THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Too many requests. Please wait a minute before trying again.'
      );
    END IF;
    UPDATE public.public_tracking_rate_limits
       SET request_count = request_count + 1
     WHERE ip_hash = v_ip_hash;
  END IF;

  -- B. Input Sanitization & Minimum Length Check
  IF p_order_identifier IS NULL OR length(trim(p_order_identifier)) < 6 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid order identifier (minimum 6 characters required)');
  END IF;

  v_clean_id := trim(p_order_identifier);

  -- C. Strict Matching (Exact UUID or exact Order Number — no substring scraping)
  IF v_clean_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT * INTO v_order FROM public.orders WHERE id = v_clean_id::uuid LIMIT 1;
  ELSE
    SELECT * INTO v_order FROM public.orders 
     WHERE order_number = v_clean_id 
        OR order_number = 'ORD-' || v_clean_id
        OR order_number = upper(v_clean_id)
        OR order_number = 'ORD-' || upper(v_clean_id)
     LIMIT 1;
  END IF;

  IF v_order.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Order not found');
  END IF;

  v_order_uuid := v_order.id;

  -- 1. Count items
  IF v_order.items IS NOT NULL AND jsonb_typeof(v_order.items) = 'array' THEN
    v_items_count := jsonb_array_length(v_order.items);
  ELSE
    v_items_count := 1;
  END IF;

  -- 2. Fetch live rider tracking
  SELECT
    dt.lat,
    dt.lng,
    COALESCE(dt.heading, 0) AS heading,
    COALESCE(dt.speed, 0) AS speed,
    dt.accuracy,
    dt.battery_level,
    COALESCE(dt.is_off_route, false) AS is_off_route,
    COALESCE(dt.geofence_arrived, false) AS geofence_arrived,
    COALESCE(dt.is_stationary, false) AS is_stationary,
    COALESCE(dt.signal_lost, false) AS signal_lost,
    dt.destination_lat,
    dt.destination_lng,
    dt.updated_at
  INTO v_tracking
  FROM public.delivery_tracking dt
  WHERE dt.order_id = v_order_uuid;

  -- 3. Fetch assigned rider profile
  IF v_order.assigned_to IS NOT NULL THEN
    SELECT
      p.id,
      COALESCE(p.name, p.business_name, 'Delivery Partner') AS name,
      p.phone
    INTO v_rider
    FROM public.profiles p
    WHERE p.id = v_order.assigned_to;
  END IF;

  -- 4. Fetch delivery proof if completed
  SELECT
    dp.photo_url,
    dp.captured_lat,
    dp.captured_lng,
    dp.captured_at,
    dp.notes
  INTO v_proof
  FROM public.delivery_proofs dp
  WHERE dp.order_id = v_order_uuid;

  -- 5. RESOLVE DROP LOCATION STORE
  -- Priority A: Direct delivery_address_id link to retailer_shop_locations
  IF v_order.delivery_address_id IS NOT NULL THEN
    SELECT * INTO v_shop FROM public.retailer_shop_locations WHERE id = v_order.delivery_address_id LIMIT 1;
  END IF;

  -- Priority B: Match retailer_shop_locations by user_id
  IF v_shop.id IS NULL AND v_order.user_id IS NOT NULL THEN
    SELECT * INTO v_shop FROM public.retailer_shop_locations
    WHERE retailer_account_id = v_order.user_id
    ORDER BY is_verified DESC, is_default DESC, updated_at DESC
    LIMIT 1;
  END IF;

  -- Priority C: Search retailer_shop_locations by shop_name / street keywords matching delivery address
  IF v_shop.id IS NULL THEN
    SELECT * INTO v_shop FROM public.retailer_shop_locations
    WHERE (
      (v_order.user_name IS NOT NULL AND (
        shop_name ILIKE '%' || v_order.user_name || '%'
        OR v_order.user_name ILIKE '%' || shop_name || '%'
      ))
      OR (v_order.delivery_address IS NOT NULL AND (
        v_order.delivery_address ILIKE '%' || shop_name || '%'
        OR (street IS NOT NULL AND length(street) > 5 AND v_order.delivery_address ILIKE '%' || street || '%')
      ))
    )
    ORDER BY is_verified DESC, is_locked_by_admin DESC, updated_at DESC
    LIMIT 1;
  END IF;

  -- Extract resolved Drop Location details
  IF v_shop.id IS NOT NULL AND v_shop.lat IS NOT NULL AND v_shop.lng IS NOT NULL AND (v_shop.lat != 0 OR v_shop.lng != 0) THEN
    v_dest_lat := v_shop.lat;
    v_dest_lng := v_shop.lng;
    v_shop_name := v_shop.shop_name;
    v_shop_address := COALESCE(v_shop.formatted_address, NULLIF(TRIM(CONCAT_WS(', ', v_shop.street, v_shop.area, v_shop.city, v_shop.pincode)), ''));
    v_is_verified := COALESCE(v_shop.is_verified, false);
  ELSE
    v_dest_lat := COALESCE(v_order.destination_lat, v_tracking.destination_lat);
    v_dest_lng := COALESCE(v_order.destination_lng, v_tracking.destination_lng);
    v_shop_name := COALESCE(v_order.user_name, 'Retailer Shop');
    v_shop_address := COALESCE(v_order.delivery_address, '');
    v_is_verified := false;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'order', jsonb_build_object(
      'id', v_order.id,
      'order_number', COALESCE(v_order.order_number, substring(v_order.id::text, 1, 8)),
      'status', v_order.status,
      'delivery_status', COALESCE(v_order.delivery_status, v_order.status),
      'user_name', COALESCE(v_shop_name, v_order.user_name, 'Retailer Shop'),
      'delivery_address', COALESCE(v_shop_address, v_order.delivery_address, ''),
      'destination_lat', v_dest_lat,
      'destination_lng', v_dest_lng,
      'is_destination_verified', v_is_verified,
      'grand_total', v_order.grand_total,
      'payment_mode', v_order.payment_mode,
      'items_count', v_items_count,
      'items', COALESCE(v_order.items, '[]'::jsonb),
      'created_at', v_order.created_at,
      'dispatched_at', v_order.dispatched_at,
      'delivered_at', v_order.delivered_at
    ),
    'tracking', CASE WHEN v_tracking.lat IS NOT NULL THEN jsonb_build_object(
      'lat', v_tracking.lat,
      'lng', v_tracking.lng,
      'heading', v_tracking.heading,
      'speed', v_tracking.speed,
      'accuracy', v_tracking.accuracy,
      'battery_level', v_tracking.battery_level,
      'is_off_route', v_tracking.is_off_route,
      'geofence_arrived', v_tracking.geofence_arrived,
      'is_stationary', v_tracking.is_stationary,
      'signal_lost', v_tracking.signal_lost,
      'updated_at', v_tracking.updated_at
    ) ELSE NULL END,
    'rider', CASE WHEN v_rider.id IS NOT NULL THEN jsonb_build_object(
      'id', v_rider.id,
      'name', v_rider.name,
      'phone', v_rider.phone
    ) ELSE NULL END,
    'proof', CASE WHEN v_proof.photo_url IS NOT NULL THEN jsonb_build_object(
      'photo_url', v_proof.photo_url,
      'captured_at', v_proof.captured_at,
      'notes', v_proof.notes
    ) ELSE NULL END,
    'warehouse', jsonb_build_object(
      'name', 'Thakkar Medico Warehouse',
      'address', 'Sandesh Dawa Bazar, Ganjipeth, Nagpur - 440018',
      'lat', 21.150167,
      'lng', 79.099140
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_public_order_tracking(text) TO anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. Single-Pass Grouped Health Summary RPC
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_delivery_health_summary()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_last_log record;
  v_reconnects_24h int := 0;
  v_off_route_24h int := 0;
  v_shifts_24h int := 0;
  v_stationary_24h int := 0;
BEGIN
  IF NOT (SELECT public.current_user_is_staff()) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT * INTO v_last_log
    FROM public.delivery_integrity_health_log
   ORDER BY run_at DESC
   LIMIT 1;

  -- Single-pass grouped count using FILTER
  SELECT
    COALESCE(count(*) FILTER (WHERE event_type = 'realtime_reconnect'), 0),
    COALESCE(count(*) FILTER (WHERE event_type = 'off_route_recalculation'), 0),
    COALESCE(count(*) FILTER (WHERE event_type = 'destination_shifted'), 0),
    COALESCE(count(*) FILTER (WHERE event_type = 'stationary_paused'), 0)
  INTO
    v_reconnects_24h,
    v_off_route_24h,
    v_shifts_24h,
    v_stationary_24h
  FROM public.delivery_telemetry_events
  WHERE created_at >= (now() - interval '24 hours');

  RETURN jsonb_build_object(
    'last_audit_at', v_last_log.run_at,
    'mismatches_found', COALESCE(v_last_log.mismatches_found, 0),
    'total_checked', COALESCE(v_last_log.total_delivered_checked, 0),
    'realtime_reconnects_24h', v_reconnects_24h,
    'off_route_recalcs_24h', v_off_route_24h,
    'destination_shifts_24h', v_shifts_24h,
    'stationary_events_24h', v_stationary_24h
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_delivery_health_summary() TO authenticated;

COMMIT;
