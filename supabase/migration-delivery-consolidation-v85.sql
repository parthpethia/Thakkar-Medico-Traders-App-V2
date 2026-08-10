-- =============================================================================
-- Thakkar Medico — V85: Delivery Subsystem Architectural Consolidation (P2)
--
-- 1. ITEM 7: Drops confirmed dead RPCs:
--    - audit_and_reconcile_store_coordinates()
--    - apply_shop_location_suggestion(uuid, float8, float8, text, bool) [v1]
--    - verify_delivery_otp(uuid, text) [superseded by Photo POD]
-- 2. ITEM 8: Drops redundant index on delivery_tracking (idx_delivery_tracking_order).
-- 3. ITEM 9: Staged verification_state enum consolidation on retailer_shop_locations.
--    - Creates public.location_verification_state ENUM.
--    - Adds verification_state column with non-breaking bi-directional sync trigger.
-- 4. ITEM 10: Creates canonical public.resolve_order_destination_coordinates(uuid) RPC
--    as the single authoritative source of truth for drop pin resolution across
--    rider app, admin dashboard, and customer live tracking.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- SECTION 1: Drop Confirmed Dead / Superseded RPCs & Redundant Index
-- -----------------------------------------------------------------------------

-- Dead RPC 1: One-time backfill from v68
DROP FUNCTION IF EXISTS public.audit_and_reconcile_store_coordinates();

-- Dead RPC 2: Geocoding suggestion v1 (superseded by v2 with 7 parameters)
DROP FUNCTION IF EXISTS public.apply_shop_location_suggestion(uuid, double precision, double precision, text, boolean);

-- Dead RPC 3: OTP verification (superseded by Photo Proof of Delivery)
DROP FUNCTION IF EXISTS public.verify_delivery_otp(uuid, text);

-- Redundant index on delivery_tracking (already enforced by unique constraint)
DROP INDEX IF EXISTS public.idx_delivery_tracking_order;

-- -----------------------------------------------------------------------------
-- SECTION 2: Staged verification_state Enum for retailer_shop_locations
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'location_verification_state') THEN
    CREATE TYPE public.location_verification_state AS ENUM (
      'unverified',           -- Raw coordinate entered at signup / order placement
      'auto_suggested',       -- Geocoding cache or Photon/Nominatim suggestion available
      'admin_verified',       -- Manually verified by ops team
      'locked',               -- Verified and locked against automated edits
      'needs_reverification'  -- Drift detected by post-delivery trigger or geofence miss
    );
  END IF;
END $$;

-- Add verification_state column alongside existing booleans
ALTER TABLE public.retailer_shop_locations
  ADD COLUMN IF NOT EXISTS verification_state public.location_verification_state NOT NULL DEFAULT 'unverified';

-- Backfill verification_state from existing boolean combinations
UPDATE public.retailer_shop_locations
   SET verification_state = CASE
     WHEN is_locked_by_admin = true THEN 'locked'::public.location_verification_state
     WHEN needs_reverification = true THEN 'needs_reverification'::public.location_verification_state
     WHEN is_verified = true THEN 'admin_verified'::public.location_verification_state
     WHEN suggested_lat IS NOT NULL AND suggested_lat != 0 THEN 'auto_suggested'::public.location_verification_state
     ELSE 'unverified'::public.location_verification_state
   END
 WHERE verification_state = 'unverified';

-- Bi-directional synchronization trigger for safe transition period
CREATE OR REPLACE FUNCTION public.sync_shop_location_verification_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- If verification_state was updated, sync boolean columns
  IF TG_OP = 'UPDATE' AND (NEW.verification_state IS DISTINCT FROM OLD.verification_state) THEN
    IF NEW.verification_state = 'locked' THEN
      NEW.is_locked_by_admin := true;
      NEW.is_verified := true;
      NEW.needs_reverification := false;
    ELSIF NEW.verification_state = 'admin_verified' THEN
      NEW.is_verified := true;
      NEW.is_locked_by_admin := false;
      NEW.needs_reverification := false;
    ELSIF NEW.verification_state = 'needs_reverification' THEN
      NEW.needs_reverification := true;
      NEW.is_verified := false;
    ELSIF NEW.verification_state = 'auto_suggested' THEN
      NEW.is_verified := false;
      NEW.needs_reverification := false;
    ELSIF NEW.verification_state = 'unverified' THEN
      NEW.is_verified := false;
      NEW.is_locked_by_admin := false;
      NEW.needs_reverification := false;
    END IF;
  -- If booleans were updated, sync verification_state enum
  ELSE
    IF NEW.is_locked_by_admin = true THEN
      NEW.verification_state := 'locked';
    ELSIF NEW.needs_reverification = true THEN
      NEW.verification_state := 'needs_reverification';
    ELSIF NEW.is_verified = true THEN
      NEW.verification_state := 'admin_verified';
    ELSIF NEW.suggested_lat IS NOT NULL AND NEW.suggested_lat != 0 THEN
      NEW.verification_state := 'auto_suggested';
    ELSE
      NEW.verification_state := 'unverified';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_shop_location_verification_state ON public.retailer_shop_locations;
CREATE TRIGGER trg_sync_shop_location_verification_state
  BEFORE INSERT OR UPDATE ON public.retailer_shop_locations
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_shop_location_verification_state();

-- -----------------------------------------------------------------------------
-- SECTION 3: Canonical Master resolve_order_destination_coordinates RPC
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_order_destination_coordinates(p_order_id uuid)
RETURNS TABLE (
  lat double precision,
  lng double precision,
  address text,
  shop_name text,
  is_verified boolean,
  resolution_source text
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order           public.orders%ROWTYPE;
  v_shop            public.retailer_shop_locations%ROWTYPE;
  v_tracking        public.delivery_tracking%ROWTYPE;
  v_is_active       boolean := true;
  v_snap_lat        double precision := NULL;
  v_snap_lng        double precision := NULL;
  v_res_lat         double precision := NULL;
  v_res_lng         double precision := NULL;
  v_res_addr        text := '';
  v_res_name        text := 'Retailer Shop';
  v_res_verified    boolean := false;
  v_res_source      text := 'unresolved';
BEGIN
  IF p_order_id IS NULL THEN
    RETURN;
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id LIMIT 1;
  IF v_order.id IS NULL THEN
    RETURN;
  END IF;

  -- Active vs Terminal status
  v_is_active := (v_order.delivered_at IS NULL AND
                  COALESCE(v_order.delivery_status, v_order.status, '') NOT IN ('delivered', 'cancelled', 'failed', 'delivery_failed', 'returned'));

  -- Extract snapshot coordinates if available
  IF v_order.delivery_snapshot IS NOT NULL AND v_order.delivery_snapshot <> 'null'::jsonb THEN
    BEGIN
      v_snap_lat := NULLIF((v_order.delivery_snapshot->>'lat'), '')::double precision;
      v_snap_lng := NULLIF((v_order.delivery_snapshot->>'lng'), '')::double precision;
      IF v_snap_lat IS NULL OR v_snap_lng IS NULL THEN
        v_snap_lat := NULLIF((v_order.delivery_snapshot->>'latitude'), '')::double precision;
        v_snap_lng := NULLIF((v_order.delivery_snapshot->>'longitude'), '')::double precision;
      END IF;
      IF v_snap_lat = 0 AND v_snap_lng = 0 THEN
        v_snap_lat := NULL;
        v_snap_lng := NULL;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_snap_lat := NULL;
      v_snap_lng := NULL;
    END;
  END IF;

  -- 1. Historical / Delivered Orders: Snapshot is Layer 1 immutable truth
  IF NOT v_is_active AND v_snap_lat IS NOT NULL AND v_snap_lng IS NOT NULL THEN
    v_res_lat := v_snap_lat;
    v_res_lng := v_snap_lng;
    v_res_verified := false;
    v_res_name := COALESCE(v_order.delivery_snapshot->>'shop_name', v_order.user_name, 'Retailer Shop');
    v_res_addr := COALESCE(v_order.delivery_snapshot->>'full_address', v_order.delivery_address, '');
    v_res_source := 'historical_snapshot';
  END IF;

  -- 2. Active in-flight order with explicit shop ID: ONLY trust verified shop pin
  IF v_res_lat IS NULL AND v_is_active AND v_order.delivery_address_id IS NOT NULL THEN
    SELECT * INTO v_shop FROM public.retailer_shop_locations WHERE id = v_order.delivery_address_id LIMIT 1;
    IF v_shop.id IS NOT NULL AND v_shop.lat IS NOT NULL AND v_shop.lng IS NOT NULL AND (v_shop.lat != 0 OR v_shop.lng != 0) THEN
      IF v_shop.is_verified = true OR v_shop.verification_state IN ('admin_verified', 'locked') THEN
        v_res_lat := v_shop.lat;
        v_res_lng := v_shop.lng;
        v_res_verified := true;
        v_res_name := v_shop.shop_name;
        v_res_addr := COALESCE(v_shop.formatted_address, NULLIF(concat_ws(', ', NULLIF(trim(v_shop.street), ''), NULLIF(trim(v_shop.area), ''), NULLIF(trim(v_shop.city), ''), NULLIF(trim(v_shop.pincode), '')), ''), v_order.delivery_address, '');
        v_res_source := 'verified_shop_location';
      END IF;
    END IF;
  END IF;

  -- 3. Active in-flight order: check user's verified default shop location
  IF v_res_lat IS NULL AND v_is_active AND v_order.user_id IS NOT NULL THEN
    SELECT * INTO v_shop
      FROM public.retailer_shop_locations
     WHERE retailer_account_id = v_order.user_id
       AND (is_verified = true OR verification_state IN ('admin_verified', 'locked'))
       AND lat != 0 AND lng != 0
     ORDER BY is_default DESC, updated_at DESC
     LIMIT 1;

    IF v_shop.id IS NOT NULL THEN
      v_res_lat := v_shop.lat;
      v_res_lng := v_shop.lng;
      v_res_verified := true;
      v_res_name := v_shop.shop_name;
      v_res_addr := COALESCE(v_shop.formatted_address, NULLIF(concat_ws(', ', NULLIF(trim(v_shop.street), ''), NULLIF(trim(v_shop.area), ''), NULLIF(trim(v_shop.city), ''), NULLIF(trim(v_shop.pincode), '')), ''), v_order.delivery_address, '');
      v_res_source := 'verified_user_default';
    END IF;
  END IF;

  -- 4. Fallback to delivery_snapshot coordinates
  IF v_res_lat IS NULL AND v_snap_lat IS NOT NULL AND v_snap_lng IS NOT NULL THEN
    v_res_lat := v_snap_lat;
    v_res_lng := v_snap_lng;
    v_res_verified := false;
    v_res_name := COALESCE(v_order.delivery_snapshot->>'shop_name', v_order.user_name, 'Retailer Shop');
    v_res_addr := COALESCE(v_order.delivery_snapshot->>'full_address', v_order.delivery_address, '');
    v_res_source := 'active_snapshot';
  END IF;

  -- 5. Fallback to unverified shop location if coordinates exist
  IF v_res_lat IS NULL AND v_order.delivery_address_id IS NOT NULL THEN
    SELECT * INTO v_shop FROM public.retailer_shop_locations WHERE id = v_order.delivery_address_id LIMIT 1;
    IF v_shop.id IS NOT NULL AND v_shop.lat IS NOT NULL AND v_shop.lng IS NOT NULL AND (v_shop.lat != 0 OR v_shop.lng != 0) THEN
      v_res_lat := v_shop.lat;
      v_res_lng := v_shop.lng;
      v_res_verified := false;
      v_res_name := v_shop.shop_name;
      v_res_addr := COALESCE(v_shop.formatted_address, NULLIF(concat_ws(', ', NULLIF(trim(v_shop.street), ''), NULLIF(trim(v_shop.area), ''), NULLIF(trim(v_shop.city), ''), NULLIF(trim(v_shop.pincode), '')), ''), v_order.delivery_address, '');
      v_res_source := 'unverified_shop_location';
    END IF;
  END IF;

  -- 6. Fallback to destination_lat on orders or delivery_tracking
  IF v_res_lat IS NULL THEN
    SELECT * INTO v_tracking FROM public.delivery_tracking WHERE order_id = v_order.id LIMIT 1;
    IF v_order.destination_lat IS NOT NULL AND v_order.destination_lng IS NOT NULL AND (v_order.destination_lat != 0 OR v_order.destination_lng != 0) THEN
      v_res_lat := v_order.destination_lat;
      v_res_lng := v_order.destination_lng;
      v_res_source := 'orders_destination_lat';
    ELSIF v_tracking.destination_lat IS NOT NULL AND v_tracking.destination_lng IS NOT NULL AND (v_tracking.destination_lat != 0 OR v_tracking.destination_lng != 0) THEN
      v_res_lat := v_tracking.destination_lat;
      v_res_lng := v_tracking.destination_lng;
      v_res_source := 'delivery_tracking_destination_lat';
    END IF;
    v_res_name := COALESCE(v_order.user_name, 'Retailer Shop');
    v_res_addr := COALESCE(v_order.delivery_address, 'Nagpur, Maharashtra');
  END IF;

  -- 7. Deterministic centroid fallback near warehouse
  IF v_res_lat IS NULL OR v_res_lng IS NULL OR (v_res_lat = 0 AND v_res_lng = 0) THEN
    v_res_lat := 21.150167;
    v_res_lng := 79.099140;
    v_res_name := COALESCE(v_order.user_name, 'Retailer Shop');
    v_res_addr := COALESCE(v_order.delivery_address, 'Nagpur, Maharashtra');
    v_res_source := 'warehouse_centroid_fallback';
  END IF;

  lat := v_res_lat;
  lng := v_res_lng;
  address := v_res_addr;
  shop_name := v_res_name;
  is_verified := v_res_verified;
  resolution_source := v_res_source;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_order_destination_coordinates(uuid) TO anon, authenticated;

COMMIT;
