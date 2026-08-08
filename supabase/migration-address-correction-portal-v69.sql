-- =============================================================================
-- Migration v69: Address Correction Portal & Location Audit Trail
--
-- Features:
-- 1. Adds verification & Google Maps flags to public.retailer_shop_locations:
--    - not_on_google_maps (boolean DEFAULT false)
--    - verified_by (uuid REFERENCES auth.users)
--    - verified_at (timestamptz)
-- 2. Creates public.location_corrections audit table to record all manual
--    pin adjustments, address corrections, notes, and distances moved.
-- 3. Enables RLS and creates indexes for high-performance dashboard queue lookups.
-- 4. Creates RPC get_address_correction_stats() for instant dashboard stats.
-- =============================================================================

BEGIN;

-- 1. Extend retailer_shop_locations with verification metadata
ALTER TABLE public.retailer_shop_locations
  ADD COLUMN IF NOT EXISTS not_on_google_maps boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS verified_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz;

-- 2. Create location_corrections audit trail table
CREATE TABLE IF NOT EXISTS public.location_corrections (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_location_id        uuid NOT NULL REFERENCES public.retailer_shop_locations(id) ON DELETE CASCADE,
  retailer_account_id     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  corrected_by            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  old_lat                 double precision,
  old_lng                 double precision,
  new_lat                 double precision NOT NULL,
  new_lng                 double precision NOT NULL,
  distance_moved_meters   double precision,
  old_address             jsonb,
  new_address             jsonb,
  notes                   text,
  not_on_google_maps      boolean NOT NULL DEFAULT false,
  created_at              timestamptz NOT NULL DEFAULT now()
);

-- 3. Create indexes for quick lookups & analytics
CREATE INDEX IF NOT EXISTS idx_location_corrections_shop
  ON public.location_corrections (shop_location_id);

CREATE INDEX IF NOT EXISTS idx_location_corrections_retailer
  ON public.location_corrections (retailer_account_id);

CREATE INDEX IF NOT EXISTS idx_location_corrections_created
  ON public.location_corrections (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_shop_locations_verified
  ON public.retailer_shop_locations (is_verified);

-- 4. Enable Row Level Security
ALTER TABLE public.location_corrections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "location_corrections_select" ON public.location_corrections;
CREATE POLICY "location_corrections_select" ON public.location_corrections
  FOR SELECT TO authenticated
  USING ((SELECT public.current_user_is_staff()));

DROP POLICY IF EXISTS "location_corrections_insert" ON public.location_corrections;
CREATE POLICY "location_corrections_insert" ON public.location_corrections
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.current_user_is_staff()));

DROP POLICY IF EXISTS "location_corrections_all_admin" ON public.location_corrections;
CREATE POLICY "location_corrections_all_admin" ON public.location_corrections
  FOR ALL TO authenticated
  USING ((SELECT public.current_user_is_admin()))
  WITH CHECK ((SELECT public.current_user_is_admin()));

-- 5. Stats Helper RPC
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
  v_pct numeric := 0;
BEGIN
  -- Total retailer shop locations
  SELECT count(*) INTO v_total FROM public.retailer_shop_locations;

  -- Verified count
  SELECT count(*) INTO v_verified FROM public.retailer_shop_locations WHERE is_verified = true;

  IF v_total > 0 THEN
    v_pct := round((v_verified::numeric / v_total::numeric) * 100, 1);
  END IF;

  -- Corrections made today (midnight onwards UTC/local)
  SELECT count(*) INTO v_today
    FROM public.location_corrections
   WHERE created_at >= date_trunc('day', now());

  -- Corrections made this week (Monday midnight onwards)
  SELECT count(*) INTO v_this_week
    FROM public.location_corrections
   WHERE created_at >= date_trunc('week', now());

  -- Fallback flagged locations (unverified AND within ~200m of Sandesh Dawa Bazar warehouse (21.150167, 79.099140) OR lat=0,lng=0)
  -- 0.002 degrees roughly ~220m in Nagpur latitude/longitude
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

  RETURN jsonb_build_object(
    'total_locations', v_total,
    'verified_locations', v_verified,
    'verified_percentage', v_pct,
    'corrections_today', v_today,
    'corrections_this_week', v_this_week,
    'fallback_flagged', v_fallback
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_address_correction_stats() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_address_correction_stats() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_address_correction_stats() TO authenticated;

COMMIT;
