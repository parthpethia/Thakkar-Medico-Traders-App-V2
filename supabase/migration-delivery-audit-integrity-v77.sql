-- =============================================================================
-- Migration v77: Delivery Audit Data Integrity & RPC Hardening
--
-- Fixes:
-- 1. Corrects evaluate_delivered_order_pin_drift() to query geofence_arrived
--    from delivery_tracking (where it exists) rather than delivery_location_history.
-- 2. Hardens update_order_delivery_coordinates() to atomically write to
--    destination_lat, destination_lng, AND delivery_snapshot in a single query.
-- 3. Hardens update_shop_location_coordinates() with verified/locked safeguards
--    to prevent trigger conflicts during automated client-side geocode self-healing.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Fix evaluate_delivered_order_pin_drift: resolve schema discrepancy
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
  v_order RECORD;
  v_shop RECORD;
  v_tracking RECORD;
  v_last_hist RECORD;
  v_rider_lat double precision;
  v_rider_lng double precision;
  v_dest_lat double precision;
  v_dest_lng double precision;
  v_dist double precision;
  v_geofence_ever_arrived boolean := false;
  v_flag_reason text;
BEGIN
  -- 1. Fetch order details
  SELECT id, delivery_address_id, destination_lat, destination_lng, delivery_status, delivered_at
    INTO v_order
    FROM public.orders
   WHERE id = p_order_id;

  IF v_order.id IS NULL OR v_order.delivery_address_id IS NULL THEN
    RETURN false;
  END IF;

  -- 2. Fetch retailer_shop_locations row
  SELECT id, is_verified, lat, lng, needs_reverification
    INTO v_shop
    FROM public.retailer_shop_locations
   WHERE id = v_order.delivery_address_id;

  -- Skip check entirely if is_verified = true (verified pins are authoritative)
  IF v_shop.id IS NULL OR v_shop.is_verified = true THEN
    RETURN false;
  END IF;

  -- 3. Inspect delivery_tracking
  SELECT lat, lng, geofence_arrived, destination_lat, destination_lng
    INTO v_tracking
    FROM public.delivery_tracking
   WHERE order_id = p_order_id;

  IF v_tracking.geofence_arrived = true THEN
    v_geofence_ever_arrived := true;
  END IF;

  -- Pull rider's last known position before / at delivery from history
  SELECT lat, lng
    INTO v_last_hist
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
-- 2. Hardened atomic update_order_delivery_coordinates (orders + delivery_tracking)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_order_delivery_coordinates(
  p_order_id uuid,
  p_lat double precision,
  p_lng double precision
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_lat IS NULL OR p_lng IS NULL OR (p_lat = 0 AND p_lng = 0) THEN
    RETURN;
  END IF;

  -- 1. Update orders table (destination coords + snapshot)
  UPDATE public.orders
     SET destination_lat = p_lat,
         destination_lng = p_lng,
         delivery_snapshot = COALESCE(delivery_snapshot, '{}'::jsonb) || jsonb_build_object('lat', p_lat, 'lng', p_lng)
   WHERE id = p_order_id;

  -- 2. Atomically update delivery_tracking table to maintain single source of truth
  UPDATE public.delivery_tracking
     SET destination_lat = p_lat,
         destination_lng = p_lng,
         updated_at = now()
   WHERE order_id = p_order_id;
END;
$$;

REVOKE ALL ON FUNCTION public.update_order_delivery_coordinates(uuid, double precision, double precision) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_order_delivery_coordinates(uuid, double precision, double precision) FROM anon;
GRANT EXECUTE ON FUNCTION public.update_order_delivery_coordinates(uuid, double precision, double precision) TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. Hardened update_shop_location_coordinates
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_shop_location_coordinates(
  p_location_id uuid,
  p_lat double precision,
  p_lng double precision
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_lat IS NULL OR p_lng IS NULL OR (p_lat = 0 AND p_lng = 0) THEN
    RETURN;
  END IF;

  -- Admin can update any row; non-admin can only update unverified & unlocked rows
  IF public.is_admin() THEN
    UPDATE public.retailer_shop_locations
       SET lat = p_lat,
           lng = p_lng,
           updated_at = now()
     WHERE id = p_location_id;
  ELSE
    UPDATE public.retailer_shop_locations
       SET lat = p_lat,
           lng = p_lng,
           updated_at = now()
     WHERE id = p_location_id
       AND is_verified = false
       AND is_locked_by_admin = false;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.update_shop_location_coordinates(uuid, double precision, double precision) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_shop_location_coordinates(uuid, double precision, double precision) FROM anon;
GRANT EXECUTE ON FUNCTION public.update_shop_location_coordinates(uuid, double precision, double precision) TO authenticated;

-- -----------------------------------------------------------------------------
-- 4. Health Metric & Reconciliation: reconcile_historical_delivered_order_snapshots
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reconcile_historical_delivered_order_snapshots()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_fixed_count int := 0;
  v_total_delivered bigint := 0;
BEGIN
  SELECT count(*) INTO v_total_delivered
    FROM public.orders
   WHERE (delivered_at IS NOT NULL OR status = 'delivered' OR delivery_status = 'delivered')
     AND delivery_snapshot IS NOT NULL
     AND delivery_snapshot->>'lat' IS NOT NULL
     AND (delivery_snapshot->>'lat')::double precision != 0;

  WITH affected AS (
    UPDATE public.orders
       SET destination_lat = (delivery_snapshot->>'lat')::double precision,
           destination_lng = (delivery_snapshot->>'lng')::double precision
     WHERE (delivered_at IS NOT NULL OR status = 'delivered' OR delivery_status = 'delivered')
       AND delivery_snapshot IS NOT NULL
       AND delivery_snapshot->>'lat' IS NOT NULL
       AND (delivery_snapshot->>'lat')::double precision != 0
       AND (
         ABS(COALESCE(destination_lat, 0) - (delivery_snapshot->>'lat')::double precision) > 0.0001 
         OR ABS(COALESCE(destination_lng, 0) - (delivery_snapshot->>'lng')::double precision) > 0.0001
       )
     RETURNING id
  )
  SELECT count(*) INTO v_fixed_count FROM affected;

  RETURN jsonb_build_object(
    'status', 'complete',
    'total_historical_delivered_checked', v_total_delivered,
    'remediated_orders_count', v_fixed_count,
    'timestamp', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_historical_delivered_order_snapshots() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconcile_historical_delivered_order_snapshots() FROM anon;
GRANT EXECUTE ON FUNCTION public.reconcile_historical_delivered_order_snapshots() TO authenticated;

COMMIT;
