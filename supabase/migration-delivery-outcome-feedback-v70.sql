-- =============================================================================
-- Migration v70: Delivery Outcome Feedback & Pin Drift Auto-Detection
--
-- Features:
-- 1. Adds feedback columns to public.retailer_shop_locations:
--    - needs_reverification (boolean NOT NULL DEFAULT false)
--    - flag_reason (text, e.g. 'geofence_miss', 'large_gps_deviation')
--    - suggested_lat (double precision)
--    - suggested_lng (double precision)
-- 2. Creates haversine_distance_meters helper function.
-- 3. Creates evaluate_delivered_order_pin_drift() with configurable threshold (150m).
-- 4. Creates trigger on public.orders when orders transition to 'delivered'.
-- 5. Creates batch audit function audit_delivered_orders_for_pin_drift().
-- 6. Updates get_address_correction_stats() to report needs_reverification count.
-- =============================================================================

BEGIN;

-- 1. Add feedback columns to retailer_shop_locations
ALTER TABLE public.retailer_shop_locations
  ADD COLUMN IF NOT EXISTS needs_reverification boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS flag_reason text,
  ADD COLUMN IF NOT EXISTS suggested_lat double precision,
  ADD COLUMN IF NOT EXISTS suggested_lng double precision;

CREATE INDEX IF NOT EXISTS idx_shop_locations_reverification
  ON public.retailer_shop_locations (needs_reverification)
  WHERE needs_reverification = true;

-- 2. Pure SQL Haversine distance calculator in meters
CREATE OR REPLACE FUNCTION public.haversine_distance_meters(
  lat1 double precision,
  lon1 double precision,
  lat2 double precision,
  lon2 double precision
)
RETURNS double precision
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  r CONSTANT double precision := 6371000.0; -- Earth radius in meters
  dlat double precision;
  dlon double precision;
  a double precision;
BEGIN
  IF lat1 IS NULL OR lon1 IS NULL OR lat2 IS NULL OR lon2 IS NULL THEN
    RETURN NULL;
  END IF;
  dlat := radians(lat2 - lat1);
  dlon := radians(lon2 - lon1);
  a := sin(dlat / 2.0)^2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2.0)^2;
  RETURN r * 2.0 * atan2(sqrt(a), sqrt(1.0 - a));
END;
$$;

-- 3. Core Pin Drift Detection logic for a delivered order
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

  -- PART 1 rule: Skip check entirely if is_verified = true
  -- (Verified pins are authoritative and must never be auto-flagged by drift heuristics)
  IF v_shop.id IS NULL OR v_shop.is_verified = true THEN
    RETURN false;
  END IF;

  -- 3. Inspect delivery_tracking & delivery_location_history
  SELECT lat, lng, geofence_arrived, destination_lat, destination_lng
    INTO v_tracking
    FROM public.delivery_tracking
   WHERE order_id = p_order_id;

  IF v_tracking.geofence_arrived = true THEN
    v_geofence_ever_arrived := true;
  END IF;

  -- Pull rider's last known position before / at delivery
  SELECT lat, lng, geofence_arrived
    INTO v_last_hist
    FROM public.delivery_location_history
   WHERE order_id = p_order_id
   ORDER BY recorded_at DESC
   LIMIT 1;

  IF v_last_hist.geofence_arrived = true THEN
    v_geofence_ever_arrived := true;
  END IF;

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

-- 4. Trigger on orders transitioning to delivered
CREATE OR REPLACE FUNCTION public.trg_flag_delivered_order_pin_drift()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF (NEW.delivery_status = 'delivered' AND (OLD.delivery_status IS DISTINCT FROM 'delivered' OR OLD.delivered_at IS NULL))
     OR (NEW.delivered_at IS NOT NULL AND OLD.delivered_at IS NULL) THEN
    PERFORM public.evaluate_delivered_order_pin_drift(NEW.id, 150.0);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_orders_flag_pin_drift ON public.orders;
CREATE TRIGGER trg_orders_flag_pin_drift
  AFTER UPDATE OF delivery_status, delivered_at ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_flag_delivered_order_pin_drift();

-- 5. Batch audit function for scheduled cron / manual scan
CREATE OR REPLACE FUNCTION public.audit_delivered_orders_for_pin_drift(
  p_threshold_meters double precision DEFAULT 150.0
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order RECORD;
  v_flagged_count integer := 0;
BEGIN
  FOR v_order IN
    SELECT o.id
      FROM public.orders o
     WHERE o.delivery_status = 'delivered'
       AND o.delivery_address_id IS NOT NULL
     ORDER BY o.created_at DESC
     LIMIT 500
  LOOP
    IF public.evaluate_delivered_order_pin_drift(v_order.id, p_threshold_meters) THEN
      v_flagged_count := v_flagged_count + 1;
    END IF;
  END LOOP;

  RETURN v_flagged_count;
END;
$$;

-- 6. Updated Stats RPC to report needs_reverification count
CREATE OR REPLACE FUNCTION public.get_address_correction_stats()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total integer := 0;
  v_verified integer := 0;
  v_today integer := 0;
  v_this_week integer := 0;
  v_fallback integer := 0;
  v_reverification integer := 0;
  v_pct numeric := 0;
BEGIN
  SELECT count(*) INTO v_total FROM public.retailer_shop_locations;
  SELECT count(*) INTO v_verified FROM public.retailer_shop_locations WHERE is_verified = true;

  IF v_total > 0 THEN
    v_pct := round((v_verified::numeric / v_total::numeric) * 100, 1);
  END IF;

  SELECT count(*) INTO v_today
    FROM public.location_corrections
   WHERE created_at >= date_trunc('day', now());

  SELECT count(*) INTO v_this_week
    FROM public.location_corrections
   WHERE created_at >= date_trunc('week', now());

  SELECT count(*) INTO v_fallback
    FROM public.retailer_shop_locations
   WHERE is_verified = false
     AND (
       (lat = 0 AND lng = 0)
       OR (lat IS NULL OR lng IS NULL)
       OR (
         abs(lat - 21.150167) < 0.0018
         AND abs(lng - 79.099140) < 0.0018
       )
     );

  SELECT count(*) INTO v_reverification
    FROM public.retailer_shop_locations
   WHERE needs_reverification = true
     AND is_verified = false;

  RETURN jsonb_build_object(
    'total_locations', v_total,
    'verified_locations', v_verified,
    'verified_percentage', v_pct,
    'corrections_today', v_today,
    'corrections_this_week', v_this_week,
    'fallback_flagged', v_fallback,
    'needs_reverification', v_reverification
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_address_correction_stats() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_address_correction_stats() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_address_correction_stats() TO authenticated;

REVOKE ALL ON FUNCTION public.audit_delivered_orders_for_pin_drift(double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.audit_delivered_orders_for_pin_drift(double precision) TO authenticated;

COMMIT;
