-- =============================================================================
-- Migration v74: Geocode Query Ladder, Attempt Tracking & Error Diagnostics
--
-- Features:
-- 1. Adds geocode_attempted_at, last_geocode_query, geocode_error to public.retailer_shop_locations.
-- 2. Creates RPC apply_shop_location_suggestion_v2 for comprehensive tracking.
-- 3. Resets unverified rows that were falsely marked not_on_google_maps due to placeholder pollution.
-- =============================================================================

BEGIN;

-- 1. Add tracking columns
ALTER TABLE public.retailer_shop_locations
  ADD COLUMN IF NOT EXISTS geocode_attempted_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_geocode_query text,
  ADD COLUMN IF NOT EXISTS geocode_error text;

-- 2. Enhanced RPC for suggestion placement and diagnostics
CREATE OR REPLACE FUNCTION public.apply_shop_location_suggestion_v2(
  p_location_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_confidence text DEFAULT 'APPROXIMATE',
  p_query text DEFAULT NULL,
  p_not_on_maps boolean DEFAULT false,
  p_error text DEFAULT NULL
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
           suggestion_confidence = COALESCE(p_confidence, 'APPROXIMATE'),
           last_geocode_query = p_query,
           geocode_error = NULL,
           geocode_attempted_at = now(),
           not_on_google_maps = false
     WHERE id = p_location_id
       AND is_verified = false;
  ELSIF p_not_on_maps = true THEN
    UPDATE public.retailer_shop_locations
       SET not_on_google_maps = true,
           last_geocode_query = p_query,
           geocode_error = p_error,
           geocode_attempted_at = now()
     WHERE id = p_location_id
       AND is_verified = false;
  ELSIF p_error IS NOT NULL THEN
    UPDATE public.retailer_shop_locations
       SET geocode_error = p_error,
           last_geocode_query = p_query,
           geocode_attempted_at = now()
     WHERE id = p_location_id
       AND is_verified = false;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_shop_location_suggestion_v2(uuid, double precision, double precision, text, text, boolean, text) TO authenticated;

-- 3. Reset unverified rows that were falsely marked not_on_google_maps by previous buggy queries
UPDATE public.retailer_shop_locations
   SET not_on_google_maps = false,
       geocode_attempted_at = NULL,
       geocode_error = NULL
 WHERE is_verified = false
   AND suggested_lat IS NULL
   AND not_on_google_maps = true;

COMMIT;
