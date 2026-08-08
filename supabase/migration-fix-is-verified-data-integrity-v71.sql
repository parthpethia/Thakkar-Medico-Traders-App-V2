-- =============================================================================
-- Migration v71: Fix is_verified Data Integrity, Trigger Defaults, and Stats
--
-- Fixes:
-- 1. Resets is_verified = false for all rows in public.retailer_shop_locations
--    where verified_by IS NULL (i.e., rows never verified by human admin in the portal).
-- 2. Updates create_default_shop_location_for_retailer() trigger to insert
--    is_verified = false by default instead of true.
-- 3. Ensures get_address_correction_stats() accurately calculates genuine verified,
--    fallback-flagged, and needs_reverification counts.
-- =============================================================================

BEGIN;

-- 1. Corrective reset: Only rows with a non-null verified_by / verified_at were genuine human reviews
UPDATE public.retailer_shop_locations
   SET is_verified = false
 WHERE verified_by IS NULL;

-- 2. Update the auto-creation trigger function to set is_verified = false
CREATE OR REPLACE FUNCTION public.create_default_shop_location_for_retailer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only run for retailer role, and if they have an address
  IF NEW.role = 'retailer' AND NEW.address IS NOT NULL AND NEW.address != '' THEN
    -- Check if they already have any shop location registered
    IF NOT EXISTS (
      SELECT 1 FROM public.retailer_shop_locations 
      WHERE retailer_account_id = NEW.id
    ) THEN
      INSERT INTO public.retailer_shop_locations (
        retailer_account_id,
        added_by,
        is_locked_by_admin,
        is_verified,
        is_default,
        visible_to_group,
        branch_label,
        shop_name,
        gstin,
        lat,
        lng,
        formatted_address,
        shop_no,
        building,
        street,
        landmark,
        area,
        city,
        state,
        pincode,
        receiver_name,
        receiver_phone
      )
      VALUES (
        NEW.id,
        'system',
        false,
        false,         -- Unverified until confirmed by admin in Address Correction Portal
        true,          -- Set as default delivery stop
        false,
        'main_shop',   -- Set branch label as main_shop
        COALESCE(NULLIF(trim(NEW.business_name), ''), 'Main Shop'),
        NEW.gstin,
        0.0,           -- Default lat coordinate (indicates unverified / fallback)
        0.0,           -- Default lng coordinate
        trim(NEW.address) || ', ' || trim(NEW.city) || ', ' || trim(NEW.state) || ' ' || trim(NEW.pincode),
        'N/A',         -- Default shop no
        'N/A',         -- Default building
        trim(NEW.address), -- Default street
        'N/A',         -- Default landmark
        COALESCE(NULLIF(trim(NEW.area), ''), 'N/A'),
        COALESCE(NULLIF(trim(NEW.city), ''), 'N/A'),
        COALESCE(NULLIF(trim(NEW.state), ''), 'Maharashtra'),
        COALESCE(NULLIF(trim(NEW.pincode), ''), 'N/A'),
        COALESCE(NULLIF(trim(NEW.name), ''), 'Owner'),
        COALESCE(NULLIF(trim(NEW.phone), ''), 'N/A')
      )
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- 3. Robust Stats RPC with fallback coordinate detection
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
     AND (is_verified = false OR verified_by IS NULL);

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

COMMIT;
