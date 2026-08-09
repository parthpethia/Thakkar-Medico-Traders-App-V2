-- =============================================================================
-- Migration v75: Public Live Order Tracking RPC & Anon Access
--
-- Fixes:
-- 1. Provides public.get_public_order_tracking(p_order_identifier text)
--    SECURITY DEFINER RPC accepting UUID, short ID prefix, or order_number.
-- 2. Grants EXECUTE to anon and authenticated roles.
-- 3. Grants public EXECUTE on get_order_tracking_bundle(uuid) to anon.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_public_order_tracking(p_order_identifier text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_order record;
  v_tracking record;
  v_rider record;
  v_proof record;
  v_items_count int := 0;
  v_items_summary text := '';
  v_clean_id text;
  v_order_uuid uuid;
BEGIN
  IF p_order_identifier IS NULL OR length(trim(p_order_identifier)) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'No order identifier provided');
  END IF;

  v_clean_id := trim(p_order_identifier);

  -- 1. Try finding by exact UUID
  IF v_clean_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT * INTO v_order FROM public.orders WHERE id = v_clean_id::uuid LIMIT 1;
  END IF;

  -- 2. If not found, try by exact order_number (e.g. ORD-9F1E832E or 9F1E832E)
  IF v_order.id IS NULL THEN
    SELECT * INTO v_order FROM public.orders 
    WHERE order_number = v_clean_id 
       OR order_number = 'ORD-' || v_clean_id
       OR order_number ILIKE v_clean_id
    LIMIT 1;
  END IF;

  -- 3. If still not found, try by ID prefix or order_number substring
  IF v_order.id IS NULL THEN
    SELECT * INTO v_order FROM public.orders
    WHERE id::text ILIKE v_clean_id || '%'
       OR order_number ILIKE '%' || v_clean_id || '%'
    ORDER BY created_at DESC
    LIMIT 1;
  END IF;

  IF v_order.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Order not found');
  END IF;

  v_order_uuid := v_order.id;

  -- 4. Calculate items summary
  IF v_order.items IS NOT NULL AND jsonb_typeof(v_order.items) = 'array' THEN
    v_items_count := jsonb_array_length(v_order.items);
  ELSE
    v_items_count := 1;
  END IF;

  -- 5. Fetch live rider tracking
  SELECT
    dt.lat,
    dt.lng,
    dt.heading,
    dt.speed,
    dt.accuracy,
    dt.battery_level,
    dt.is_off_route,
    dt.geofence_arrived,
    dt.total_distance_covered,
    dt.destination_lat,
    dt.destination_lng,
    dt.updated_at
  INTO v_tracking
  FROM public.delivery_tracking dt
  WHERE dt.order_id = v_order_uuid;

  -- 6. Fetch assigned rider profile
  IF v_order.assigned_to IS NOT NULL THEN
    SELECT
      p.id,
      COALESCE(p.name, p.business_name, 'Delivery Partner') AS name,
      p.phone
    INTO v_rider
    FROM public.profiles p
    WHERE p.id = v_order.assigned_to;
  END IF;

  -- 7. Fetch delivery proof if delivered
  SELECT
    dp.photo_url,
    dp.captured_lat,
    dp.captured_lng,
    dp.captured_at,
    dp.notes
  INTO v_proof
  FROM public.delivery_proofs dp
  WHERE dp.order_id = v_order_uuid;

  RETURN jsonb_build_object(
    'success', true,
    'order', jsonb_build_object(
      'id', v_order.id,
      'order_number', COALESCE(v_order.order_number, substring(v_order.id::text, 1, 8)),
      'status', v_order.status,
      'delivery_status', COALESCE(v_order.delivery_status, v_order.status),
      'user_name', COALESCE(v_order.user_name, 'Retailer'),
      'delivery_address', v_order.delivery_address,
      'destination_lat', COALESCE(v_order.destination_lat, v_tracking.destination_lat),
      'destination_lng', COALESCE(v_order.destination_lng, v_tracking.destination_lng),
      'grand_total', v_order.grand_total,
      'payment_mode', v_order.payment_mode,
      'items_count', v_items_count,
      'items', COALESCE(v_order.items, '[]'::jsonb),
      'created_at', v_order.created_at,
      'dispatched_at', v_order.dispatched_at,
      'delivered_at', v_order.delivered_at
    ),
    'tracking', CASE WHEN v_tracking.lat IS NOT NULL THEN jsonb_build_object(
      'lat', v_tracking.lat,
      'lng', v_tracking.lng,
      'heading', COALESCE(v_tracking.heading, 0),
      'speed', COALESCE(v_tracking.speed, 0),
      'accuracy', v_tracking.accuracy,
      'battery_level', v_tracking.battery_level,
      'is_off_route', COALESCE(v_tracking.is_off_route, false),
      'geofence_arrived', COALESCE(v_tracking.geofence_arrived, false),
      'updated_at', v_tracking.updated_at
    ) ELSE NULL END,
    'rider', CASE WHEN v_rider.id IS NOT NULL THEN jsonb_build_object(
      'id', v_rider.id,
      'name', v_rider.name,
      'phone', v_rider.phone
    ) ELSE NULL END,
    'proof', CASE WHEN v_proof.photo_url IS NOT NULL THEN jsonb_build_object(
      'photo_url', v_proof.photo_url,
      'captured_at', v_proof.captured_at,
      'notes', v_proof.notes
    ) ELSE NULL END,
    'warehouse', jsonb_build_object(
      'name', 'Thakkar Medico Warehouse',
      'address', 'Ganjipeth, Nagpur',
      'lat', 21.150167,
      'lng', 79.099140
    )
  );
END;
$$;

-- Grant access to public / anon web tracking
GRANT EXECUTE ON FUNCTION public.get_public_order_tracking(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_order_tracking_bundle(uuid) TO anon, authenticated;

COMMIT;
