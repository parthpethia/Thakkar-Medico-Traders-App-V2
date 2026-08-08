-- =============================================================================
-- Migration v72: Geocoding Cache, Suggestion Confidence & Stats Update
--
-- Features:
-- 1. Creates public.geocoding_cache table for caching geocoded addresses.
-- 2. Adds suggestion_confidence column to public.retailer_shop_locations.
-- 3. Creates RPCs:
--    - save_geocoding_cache(p_address, p_lat, p_lng, p_confidence)
--    - apply_shop_location_suggestion(p_location_id, p_lat, p_lng, p_confidence, p_not_on_maps)
-- 4. Updates get_address_correction_stats() to include auto_suggested count.
-- =============================================================================

BEGIN;

-- 1. Create geocoding cache table
CREATE TABLE IF NOT EXISTS public.geocoding_cache (
  normalized_address text PRIMARY KEY,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  confidence text NOT NULL DEFAULT 'NOMINATIM',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_geocoding_cache_created
  ON public.geocoding_cache (created_at DESC);

-- Enable RLS on geocoding_cache
ALTER TABLE public.geocoding_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "geocoding_cache_read_all" ON public.geocoding_cache;
CREATE POLICY "geocoding_cache_read_all" ON public.geocoding_cache
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "geocoding_cache_write_staff" ON public.geocoding_cache;
CREATE POLICY "geocoding_cache_write_staff" ON public.geocoding_cache
  FOR ALL TO authenticated
  USING ((SELECT public.current_user_is_staff()))
  WITH CHECK ((SELECT public.current_user_is_staff()));

-- 2. Add suggestion_confidence to retailer_shop_locations
ALTER TABLE public.retailer_shop_locations
  ADD COLUMN IF NOT EXISTS suggestion_confidence text;

-- 3. RPC to save address in cache
CREATE OR REPLACE FUNCTION public.save_geocoding_cache(
  p_address text,
  p_lat double precision,
  p_lng double precision,
  p_confidence text DEFAULT 'NOMINATIM'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_norm text;
BEGIN
  v_norm := lower(regexp_replace(trim(p_address), '[\s,]+', ' ', 'g'));
  IF v_norm IS NULL OR v_norm = '' OR p_lat IS NULL OR p_lng IS NULL OR (p_lat = 0 AND p_lng = 0) THEN
    RETURN;
  END IF;

  INSERT INTO public.geocoding_cache (normalized_address, lat, lng, confidence, created_at)
  VALUES (v_norm, p_lat, p_lng, COALESCE(p_confidence, 'APPROXIMATE'), now())
  ON CONFLICT (normalized_address) DO UPDATE
    SET lat = EXCLUDED.lat,
        lng = EXCLUDED.lng,
        confidence = EXCLUDED.confidence;
END;
$$;

-- 4. RPC to apply auto-geocode suggestion to retailer_shop_locations
CREATE OR REPLACE FUNCTION public.apply_shop_location_suggestion(
  p_location_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_confidence text DEFAULT 'APPROXIMATE',
  p_not_on_maps boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_lat IS NOT NULL AND p_lng IS NOT NULL AND (p_lat != 0 OR p_lng != 0) THEN
    UPDATE public.retailer_shop_locations
       SET suggested_lat = p_lat,
           suggested_lng = p_lng,
           flag_reason = 'geocode_suggestion',
           suggestion_confidence = COALESCE(p_confidence, 'APPROXIMATE')
     WHERE id = p_location_id
       AND is_verified = false;
  ELSIF p_not_on_maps = true THEN
    UPDATE public.retailer_shop_locations
       SET not_on_google_maps = true
     WHERE id = p_location_id
       AND is_verified = false;
  END IF;
END;
$$;

-- 5. Updated stats function including auto_suggested count
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
  v_suggested integer := 0;
  v_pct numeric := 0;
BEGIN
  -- Total retailer shop locations
  SELECT count(*) INTO v_total FROM public.retailer_shop_locations;

  -- Genuinely verified by staff/admin through portal save flow
  SELECT count(*) INTO v_verified 
    FROM public.retailer_shop_locations 
   WHERE is_verified = true 
     AND verified_by IS NOT NULL;

  IF v_total > 0 THEN
    v_pct := round((v_verified::numeric / v_total::numeric) * 100, 1);
  END IF;

  -- Corrections logged today
  SELECT count(*) INTO v_today
    FROM public.location_corrections
   WHERE created_at >= date_trunc('day', now());

  -- Corrections logged this week
  SELECT count(*) INTO v_this_week
    FROM public.location_corrections
   WHERE created_at >= date_trunc('week', now());

  -- Fallback flagged locations (unverified AND within ~220m of Sandesh Dawa Bazar warehouse (21.150167, 79.099140) OR lat=0,lng=0)
  SELECT count(*) INTO v_fallback
    FROM public.retailer_shop_locations
   WHERE (is_verified = false OR verified_by IS NULL)
     AND (
       (lat = 0 AND lng = 0)
       OR (lat IS NULL OR lng IS NULL)
       OR (
         abs(lat - 21.150167) < 0.002
         AND abs(lng - 79.099140) < 0.002
       )
     );

  -- Needs reverification from delivery outcome drift
  SELECT count(*) INTO v_reverification
    FROM public.retailer_shop_locations
   WHERE needs_reverification = true
     AND (is_verified = false OR verified_by IS NULL)
     AND flag_reason IN ('geofence_miss', 'large_gps_deviation', 'unresolved_zero_pin');

  -- Auto-suggested pre-geocoded pins awaiting admin confirmation
  SELECT count(*) INTO v_suggested
    FROM public.retailer_shop_locations
   WHERE flag_reason = 'geocode_suggestion'
     AND suggested_lat IS NOT NULL
     AND (is_verified = false OR verified_by IS NULL);

  RETURN jsonb_build_object(
    'total_locations', v_total,
    'verified_locations', v_verified,
    'verified_percentage', v_pct,
    'corrections_today', v_today,
    'corrections_this_week', v_this_week,
    'fallback_flagged', v_fallback,
    'needs_reverification', v_reverification,
    'auto_suggested', v_suggested
  );
END;
$$;

REVOKE ALL ON FUNCTION public.save_geocoding_cache(text, double precision, double precision, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_shop_location_suggestion(uuid, double precision, double precision, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_geocoding_cache(text, double precision, double precision, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_shop_location_suggestion(uuid, double precision, double precision, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_address_correction_stats() TO authenticated;

COMMIT;
