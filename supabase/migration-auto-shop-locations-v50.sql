-- =============================================================================
-- Thakkar Medico — V50: Auto-create Default Shop Delivery Location
--
-- Run in: Supabase Dashboard → SQL Editor → New query → Run
-- =============================================================================

BEGIN;

-- 1. Create the auto-creation trigger function
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
        'admin',
        false,
        true,          -- Marked as verified
        true,          -- Set as default delivery stop
        false,
        'main_shop',   -- Set branch label as main_shop
        COALESCE(NULLIF(trim(NEW.business_name), ''), 'Main Shop'),
        NEW.gstin,
        0.0,           -- Default lat coordinate
        0.0,           -- Default lng coordinate
        trim(NEW.address) || ', ' || trim(NEW.city) || ', ' || trim(NEW.state) || ' ' || trim(NEW.pincode),
        'N/A',         -- Default shop no
        'N/A',         -- Default building
        trim(NEW.address), -- Default street
        'N/A',         -- Default landmark
        COALESCE(NULLIF(trim(NEW.area), ''), 'N/A'),
        COALESCE(NULLIF(trim(NEW.city), ''), 'N/A'),
        COALESCE(NULLIF(trim(NEW.state), ''), ''),
        COALESCE(NULLIF(trim(NEW.pincode), ''), 'N/A'),
        COALESCE(NULLIF(trim(NEW.name), ''), 'Owner'), -- Stop owner is account owner
        COALESCE(NULLIF(trim(NEW.phone), ''), 'N/A')   -- Stop contact is account phone number
      )
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- 2. Bind the trigger to public.profiles table
DROP TRIGGER IF EXISTS trg_create_default_shop_location ON public.profiles;
CREATE TRIGGER trg_create_default_shop_location
  AFTER INSERT OR UPDATE OF address, city, state, pincode ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.create_default_shop_location_for_retailer();

-- 3. Backfill existing retailers who have addresses but no shop locations
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
SELECT 
  p.id,
  'admin',
  false,
  true,
  true,
  false,
  'main_shop',
  COALESCE(NULLIF(trim(p.business_name), ''), 'Main Shop'),
  p.gstin,
  0.0,
  0.0,
  trim(p.address) || ', ' || trim(p.city) || ', ' || trim(p.state) || ' ' || trim(p.pincode),
  'N/A',
  'N/A',
  trim(p.address),
  'N/A',
  COALESCE(NULLIF(trim(p.area), ''), 'N/A'),
  COALESCE(NULLIF(trim(p.city), ''), 'N/A'),
  COALESCE(NULLIF(trim(p.state), ''), ''),
  COALESCE(NULLIF(trim(p.pincode), ''), 'N/A'),
  COALESCE(NULLIF(trim(p.name), ''), 'Owner'),
  COALESCE(NULLIF(trim(p.phone), ''), 'N/A')
FROM public.profiles p
WHERE p.role = 'retailer'
  AND p.address IS NOT NULL 
  AND p.address != ''
  AND NOT EXISTS (
    SELECT 1 FROM public.retailer_shop_locations l
    WHERE l.retailer_account_id = p.id
  )
ON CONFLICT DO NOTHING;

COMMIT;
