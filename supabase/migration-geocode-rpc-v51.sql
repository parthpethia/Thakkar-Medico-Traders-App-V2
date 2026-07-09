-- =============================================================================
-- Thakkar Medico — V51: RPC Functions for client-side Geocoding updates
--
-- Run in: Supabase Dashboard → SQL Editor → New query → Run
-- =============================================================================

BEGIN;

-- 1. RPC function to update shop location coordinates
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
  UPDATE public.retailer_shop_locations
     SET lat = p_lat,
         lng = p_lng,
         updated_at = now()
   WHERE id = p_location_id;
END;
$$;

REVOKE ALL ON FUNCTION public.update_shop_location_coordinates(uuid, double precision, double precision) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_shop_location_coordinates(uuid, double precision, double precision) FROM anon;
GRANT EXECUTE ON FUNCTION public.update_shop_location_coordinates(uuid, double precision, double precision) TO authenticated;


-- 2. RPC function to update order delivery snapshot coordinates
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
DECLARE
  v_snap jsonb;
BEGIN
  SELECT delivery_snapshot INTO v_snap
    FROM public.orders
   WHERE id = p_order_id;

  IF v_snap IS NOT NULL AND v_snap <> 'null'::jsonb THEN
    v_snap := v_snap || jsonb_build_object('lat', p_lat, 'lng', p_lng);
    UPDATE public.orders
       SET delivery_snapshot = v_snap
     WHERE id = p_order_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.update_order_delivery_coordinates(uuid, double precision, double precision) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_order_delivery_coordinates(uuid, double precision, double precision) FROM anon;
GRANT EXECUTE ON FUNCTION public.update_order_delivery_coordinates(uuid, double precision, double precision) TO authenticated;

COMMIT;
