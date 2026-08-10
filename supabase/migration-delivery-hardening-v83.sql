-- =============================================================================
-- Migration v83: Delivery Subsystem Zero-55000 Error Hardening
-- 
-- Fixes:
-- 1. Strongly-typed %ROWTYPE for all record variables across get_public_order_tracking,
--    get_order_tracking_bundle, and evaluate_delivered_order_pin_drift.
-- 2. Eliminates PL/pgSQL Error 55000 ("record is not assigned yet") on null lookups.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Hardened Public RPC: get_public_order_tracking
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_public_order_tracking(p_order_identifier text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_tracking public.delivery_tracking%ROWTYPE;
  v_rider public.profiles%ROWTYPE;
  v_proof public.delivery_proofs%ROWTYPE;
  v_shop public.retailer_shop_locations%ROWTYPE;
  v_limit_rec public.public_tracking_rate_limits%ROWTYPE;
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
  c_max_requests CONSTANT int := 30; -- Max 30 requests/minute per IP
BEGIN
  -- A. Input Sanitization & Minimum Length Check
  IF p_order_identifier IS NULL OR length(trim(p_order_identifier)) < 6 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid order identifier (minimum 6 characters required)');
  END IF;

  v_clean_id := trim(p_order_identifier);

  -- B. Strict Matching (Exact UUID or exact Order Number)
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
  SELECT * INTO v_tracking
  FROM public.delivery_tracking
  WHERE order_id = v_order_uuid;

  -- 3. Fetch assigned rider profile
  IF v_order.assigned_to IS NOT NULL THEN
    SELECT * INTO v_rider
    FROM public.profiles
    WHERE id = v_order.assigned_to;
  END IF;

  -- 4. Fetch delivery proof if completed
  SELECT * INTO v_proof
  FROM public.delivery_proofs
  WHERE order_id = v_order_uuid;

  -- 5. RESOLVE DROP LOCATION STORE
  IF v_order.delivery_address_id IS NOT NULL THEN
    SELECT * INTO v_shop FROM public.retailer_shop_locations WHERE id = v_order.delivery_address_id LIMIT 1;
  END IF;

  IF v_shop.id IS NULL AND v_order.user_id IS NOT NULL THEN
    SELECT * INTO v_shop FROM public.retailer_shop_locations
    WHERE retailer_account_id = v_order.user_id
    ORDER BY is_verified DESC, is_default DESC, updated_at DESC
    LIMIT 1;
  END IF;

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

-- -----------------------------------------------------------------------------
-- 2. Hardened get_order_tracking_bundle
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_order_tracking_bundle(p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_bundle jsonb;
BEGIN
  v_bundle := public.get_public_order_tracking(p_order_id::text);
  IF (v_bundle->>'success')::boolean = false THEN
    RETURN jsonb_build_object('error', 'Order not found');
  END IF;
  RETURN jsonb_build_object(
    'order', v_bundle->'order',
    'tracking', v_bundle->'tracking',
    'history', '[]'::jsonb,
    'rider', v_bundle->'rider',
    'proof', v_bundle->'proof',
    'timeline', jsonb_build_object(
      'placed_at', v_bundle->'order'->>'created_at',
      'confirmed_at', v_bundle->'order'->>'created_at',
      'dispatched_at', v_bundle->'order'->>'dispatched_at',
      'delivered_at', v_bundle->'order'->>'delivered_at',
      'failed_at', NULL
    )
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. Hardened evaluate_delivered_order_pin_drift
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.evaluate_delivered_order_pin_drift(
  p_order_id uuid,
  p_threshold_meters double precision DEFAULT 150.0
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c_default_threshold CONSTANT double precision := 150.0;
  v_threshold double precision := COALESCE(p_threshold_meters, c_default_threshold);
  v_order public.orders%ROWTYPE;
  v_shop public.retailer_shop_locations%ROWTYPE;
  v_tracking public.delivery_tracking%ROWTYPE;
  v_last_hist public.delivery_location_history%ROWTYPE;
  v_rider_lat double precision;
  v_rider_lng double precision;
  v_dest_lat double precision;
  v_dest_lng double precision;
  v_dist double precision;
  v_geofence_ever_arrived boolean := false;
  v_flag_reason text;
BEGIN
  -- 1. Fetch order details
  SELECT * INTO v_order
    FROM public.orders
   WHERE id = p_order_id;

  IF v_order.id IS NULL OR v_order.delivery_address_id IS NULL THEN
    RETURN false;
  END IF;

  -- 2. Fetch retailer_shop_locations row
  SELECT * INTO v_shop
    FROM public.retailer_shop_locations
   WHERE id = v_order.delivery_address_id;

  -- Skip check entirely if is_verified = true
  IF v_shop.id IS NULL OR v_shop.is_verified = true THEN
    RETURN false;
  END IF;

  -- 3. Inspect delivery_tracking
  SELECT * INTO v_tracking
    FROM public.delivery_tracking
   WHERE order_id = p_order_id;

  IF v_tracking.geofence_arrived = true THEN
    v_geofence_ever_arrived := true;
  END IF;

  -- Pull rider's last known position before / at delivery from history
  SELECT * INTO v_last_hist
    FROM public.delivery_location_history
   WHERE order_id = p_order_id
   ORDER BY recorded_at DESC
   LIMIT 1;

  v_rider_lat := COALESCE(v_last_hist.lat, v_tracking.lat);
  v_rider_lng := COALESCE(v_last_hist.lng, v_tracking.lng);

  -- If rider GPS wasn't captured, cannot evaluate drift
  IF v_rider_lat IS NULL OR v_rider_lng IS NULL OR (v_rider_lat = 0 AND v_rider_lng = 0) THEN
    RETURN false;
  END IF;

  -- Destination coordinates from order or shop location
  v_dest_lat := COALESCE(v_order.destination_lat, v_shop.lat);
  v_dest_lng := COALESCE(v_order.destination_lng, v_shop.lng);

  -- If current stored destination pin is 0/null/fallback, flag with rider drop location
  IF v_dest_lat IS NULL OR v_dest_lng IS NULL OR (v_dest_lat = 0 AND v_dest_lng = 0) THEN
    UPDATE public.retailer_shop_locations
       SET needs_reverification = true,
           flag_reason = 'unresolved_zero_pin',
           suggested_lat = v_rider_lat,
           suggested_lng = v_rider_lng
     WHERE id = v_shop.id
       AND is_verified = false;
    RETURN true;
  END IF;

  -- 4. Compute Haversine distance in meters
  v_dist := public.haversine_distance_meters(v_rider_lat, v_rider_lng, v_dest_lat, v_dest_lng);

  -- If distance exceeds threshold (150m) and shop is not verified, flag for review
  IF v_dist IS NOT NULL AND v_dist > v_threshold THEN
    IF v_geofence_ever_arrived = false THEN
      v_flag_reason := 'geofence_miss';
    ELSE
      v_flag_reason := 'large_gps_deviation';
    END IF;

    UPDATE public.retailer_shop_locations
       SET needs_reverification = true,
           flag_reason = v_flag_reason,
           suggested_lat = v_rider_lat,
           suggested_lng = v_rider_lng
     WHERE id = v_shop.id
       AND is_verified = false;

    RETURN true;
  END IF;

  RETURN false;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. Permissions
-- -----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.get_public_order_tracking(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_order_tracking_bundle(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.evaluate_delivered_order_pin_drift(uuid, double precision) TO authenticated, service_role;

COMMIT;
