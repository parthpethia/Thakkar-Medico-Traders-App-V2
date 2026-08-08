-- =============================================================================
-- Migration v73: Permanent Lock & Defense-in-Depth for Verified Locations
--
-- Features:
-- 1. Creates public.is_admin() helper function.
-- 2. Enforces RLS policies on public.retailer_shop_locations so non-admins
--    cannot modify verified or locked rows, or alter verification flags.
-- 3. Adds BEFORE UPDATE trigger trg_protect_verified_location to prevent
--    bypasses via SECURITY DEFINER RPCs.
-- 4. Creates unlock_shop_location_for_editing RPC for explicit admin unlocks.
-- =============================================================================

BEGIN;

-- 1. Helper function: is_admin()
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, anon;

-- 2. RLS Enforcement on retailer_shop_locations
ALTER TABLE public.retailer_shop_locations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "retailer_shop_locations_update" ON public.retailer_shop_locations;
DROP POLICY IF EXISTS "retailer_shop_locations_update_staff" ON public.retailer_shop_locations;
DROP POLICY IF EXISTS "retailer_shop_locations_update_admin" ON public.retailer_shop_locations;
DROP POLICY IF EXISTS "retailer_shop_locations_update_retailer" ON public.retailer_shop_locations;

-- Admin UPDATE policy: Admins can update any row (verified or unverified)
CREATE POLICY "retailer_shop_locations_update_admin"
ON public.retailer_shop_locations
FOR UPDATE
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

-- Retailer / Non-admin UPDATE policy: Can only update unverified & unlocked rows owned by self
-- Non-admins cannot alter verification columns (is_verified, verified_by, verified_at, is_locked_by_admin)
CREATE POLICY "retailer_shop_locations_update_retailer"
ON public.retailer_shop_locations
FOR UPDATE
TO authenticated
USING (
  (NOT public.is_admin())
  AND is_verified = false
  AND is_locked_by_admin = false
  AND retailer_account_id = auth.uid()
)
WITH CHECK (
  (NOT public.is_admin())
  AND is_verified = false
  AND is_locked_by_admin = false
  AND verified_by IS NULL
  AND verified_at IS NULL
  AND retailer_account_id = auth.uid()
);

-- 3. Trigger-level defense in depth: trg_protect_verified_location
CREATE OR REPLACE FUNCTION public.fn_protect_verified_location()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- If currently stored row is verified, reject any coordinate or address edits by non-admins
  IF OLD.is_verified = true THEN
    IF (
      NEW.lat IS DISTINCT FROM OLD.lat OR
      NEW.lng IS DISTINCT FROM OLD.lng OR
      NEW.formatted_address IS DISTINCT FROM OLD.formatted_address OR
      NEW.shop_no IS DISTINCT FROM OLD.shop_no OR
      NEW.building IS DISTINCT FROM OLD.building OR
      NEW.street IS DISTINCT FROM OLD.street OR
      NEW.landmark IS DISTINCT FROM OLD.landmark OR
      NEW.area IS DISTINCT FROM OLD.area OR
      NEW.city IS DISTINCT FROM OLD.city OR
      NEW.pincode IS DISTINCT FROM OLD.pincode
    ) THEN
      IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'This retailer shop location has been verified by our team and is locked against modifications.';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_verified_location ON public.retailer_shop_locations;
CREATE TRIGGER trg_protect_verified_location
  BEFORE UPDATE ON public.retailer_shop_locations
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_protect_verified_location();

-- 4. Explicit Unlock RPC for Admin Address Correction Portal
CREATE OR REPLACE FUNCTION public.unlock_shop_location_for_editing(
  p_location_id uuid,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_loc record;
  v_admin_id uuid;
  v_notes text;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only administrators can unlock verified shop locations.';
  END IF;

  v_admin_id := auth.uid();

  SELECT * INTO v_loc
    FROM public.retailer_shop_locations
   WHERE id = p_location_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shop location not found.';
  END IF;

  v_notes := 'Unlocked for re-edit: ' || COALESCE(nullif(trim(p_reason), ''), 'Admin requested change');

  -- Reset verification state to allow re-editing
  UPDATE public.retailer_shop_locations
     SET is_verified = false,
         is_locked_by_admin = false,
         verified_by = null,
         verified_at = null,
         flag_reason = 'admin_unlock'
   WHERE id = p_location_id;

  -- Log audit record in location_corrections
  INSERT INTO public.location_corrections (
    shop_location_id,
    retailer_account_id,
    corrected_by,
    old_lat,
    old_lng,
    new_lat,
    new_lng,
    distance_moved_meters,
    old_address,
    new_address,
    notes,
    created_at
  ) VALUES (
    p_location_id,
    v_loc.retailer_account_id,
    v_admin_id,
    v_loc.lat,
    v_loc.lng,
    v_loc.lat,
    v_loc.lng,
    0,
    jsonb_build_object(
      'shop_name', v_loc.shop_name,
      'shop_no', v_loc.shop_no,
      'building', v_loc.building,
      'street', v_loc.street,
      'landmark', v_loc.landmark,
      'area', v_loc.area,
      'city', v_loc.city,
      'pincode', v_loc.pincode,
      'formatted_address', v_loc.formatted_address
    ),
    jsonb_build_object(
      'shop_name', v_loc.shop_name,
      'shop_no', v_loc.shop_no,
      'building', v_loc.building,
      'street', v_loc.street,
      'landmark', v_loc.landmark,
      'area', v_loc.area,
      'city', v_loc.city,
      'pincode', v_loc.pincode,
      'formatted_address', v_loc.formatted_address
    ),
    v_notes,
    now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.unlock_shop_location_for_editing(uuid, text) TO authenticated;

COMMIT;
