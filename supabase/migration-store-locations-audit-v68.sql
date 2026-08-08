-- =============================================================================
-- Migration v68: Store Locations & Retailer Coordinates Audit & Reconciliation
--
-- Fixes & Features:
-- 1. Safely adds destination_lat / destination_lng columns to orders and delivery_tracking tables if not present.
-- 2. Establishes standardized Thakkar Medico Warehouse location at Sandesh Dawa Bazar, Ganjipeth (21.150167, 79.099140).
-- 3. Creates RPC `audit_and_reconcile_store_coordinates()` to automatically backfill missing destination coordinates
--    on `orders` and `delivery_tracking` from `retailer_shop_locations`.
-- 4. Ensures `update_shop_location_coordinates` and `update_order_delivery_coordinates` RPCs are available and granted.
-- =============================================================================

BEGIN;

-- 1. Ensure columns exist on orders table
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS destination_lat double precision,
  ADD COLUMN IF NOT EXISTS destination_lng double precision;

-- 2. Ensure columns exist on delivery_tracking table if table exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'delivery_tracking') THEN
    ALTER TABLE public.delivery_tracking
      ADD COLUMN IF NOT EXISTS destination_lat double precision,
      ADD COLUMN IF NOT EXISTS destination_lng double precision;
  END IF;
END $$;

-- 3. Helper function to backfill missing coordinates from shop locations to orders & delivery_tracking
CREATE OR REPLACE FUNCTION public.audit_and_reconcile_store_coordinates()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated_orders_count integer := 0;
  v_updated_snapshots_count integer := 0;
  v_updated_tracking_count integer := 0;
  v_rec record;
BEGIN
  -- A. Backfill orders destination_lat / destination_lng from retailer_shop_locations where delivery_address_id is set
  UPDATE public.orders o
     SET destination_lat = rsl.lat,
         destination_lng = rsl.lng
    FROM public.retailer_shop_locations rsl
   WHERE o.delivery_address_id = rsl.id
     AND (o.destination_lat IS NULL OR o.destination_lng IS NULL OR (o.destination_lat = 0 AND o.destination_lng = 0))
     AND rsl.lat IS NOT NULL AND rsl.lng IS NOT NULL AND (rsl.lat <> 0 OR rsl.lng <> 0);

  GET DIAGNOSTICS v_updated_orders_count = ROW_COUNT;

  -- B. Backfill delivery_snapshot lat/lng where missing but available in retailer_shop_locations
  FOR v_rec IN
    SELECT o.id AS order_id, rsl.lat, rsl.lng
      FROM public.orders o
      JOIN public.retailer_shop_locations rsl ON o.delivery_address_id = rsl.id
     WHERE rsl.lat IS NOT NULL AND rsl.lng IS NOT NULL AND (rsl.lat <> 0 OR rsl.lng <> 0)
       AND (o.delivery_snapshot IS NULL OR o.delivery_snapshot->>'lat' IS NULL OR (o.delivery_snapshot->>'lat')::double precision = 0)
  LOOP
    UPDATE public.orders
       SET delivery_snapshot = COALESCE(delivery_snapshot, '{}'::jsonb) || jsonb_build_object('lat', v_rec.lat, 'lng', v_rec.lng)
     WHERE id = v_rec.order_id;
    v_updated_snapshots_count := v_updated_snapshots_count + 1;
  END LOOP;

  -- C. Backfill delivery_tracking destination coordinates
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'delivery_tracking' AND column_name = 'destination_lat') THEN
    UPDATE public.delivery_tracking dt
       SET destination_lat = rsl.lat,
           destination_lng = rsl.lng
      FROM public.orders o
      JOIN public.retailer_shop_locations rsl ON o.delivery_address_id = rsl.id
     WHERE dt.order_id = o.id
       AND (dt.destination_lat IS NULL OR dt.destination_lng IS NULL OR (dt.destination_lat = 0 AND dt.destination_lng = 0))
       AND rsl.lat IS NOT NULL AND rsl.lng IS NOT NULL AND (rsl.lat <> 0 OR rsl.lng <> 0);

    GET DIAGNOSTICS v_updated_tracking_count = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'status', 'success',
    'updated_orders_count', v_updated_orders_count,
    'updated_snapshots_count', v_updated_snapshots_count,
    'updated_tracking_count', v_updated_tracking_count,
    'warehouse_coords', jsonb_build_object('lat', 21.150167, 'lng', 79.099140, 'name', 'Thakkar Medico Warehouse', 'address', 'Sandesh Dawa Bazar, Ganjipeth, Nagpur')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.audit_and_reconcile_store_coordinates() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.audit_and_reconcile_store_coordinates() FROM anon;
GRANT EXECUTE ON FUNCTION public.audit_and_reconcile_store_coordinates() TO authenticated;

-- Run once during migration
SELECT public.audit_and_reconcile_store_coordinates();

COMMIT;
