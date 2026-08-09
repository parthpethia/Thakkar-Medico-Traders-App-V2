-- =============================================================================
-- Migration v75: Public Live Order Tracking RPC, Table Column Fixes & Anon Access
--
-- Fixes:
-- 1. Adds missing columns (is_off_route, geofence_arrived, total_distance_covered,
--    destination_lat, destination_lng, battery_level, speed, heading, accuracy)
--    to public.delivery_tracking using safe ADD COLUMN IF NOT EXISTS.
-- 2. Provides public.get_public_order_tracking(p_order_identifier text)
--    SECURITY DEFINER RPC accepting UUID, short ID prefix, or order_number.
-- 3. Updates get_order_tracking_bundle(uuid) to be safe and grant to anon.
-- 4. Grants EXECUTE to anon and authenticated roles.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Ensure all columns exist on public.delivery_tracking
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.delivery_tracking (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  rider_id                uuid REFERENCES auth.users(id),
  lat                     double precision NOT NULL,
  lng                     double precision NOT NULL,
  CONSTRAINT delivery_tracking_order_unique UNIQUE (order_id)
);

ALTER TABLE public.delivery_tracking
  ADD COLUMN IF NOT EXISTS heading double precision DEFAULT 0,
  ADD COLUMN IF NOT EXISTS speed double precision DEFAULT 0,
  ADD COLUMN IF NOT EXISTS accuracy double precision,
  ADD COLUMN IF NOT EXISTS battery_level integer,
  ADD COLUMN IF NOT EXISTS is_off_route boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS geofence_arrived boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS total_distance_covered double precision DEFAULT 0,
  ADD COLUMN IF NOT EXISTS destination_lat double precision,
  ADD COLUMN IF NOT EXISTS destination_lng double precision,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- -----------------------------------------------------------------------------
-- 2. Ensure delivery_proofs table exists
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.delivery_proofs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_proofs_order_unique UNIQUE (order_id)
);

ALTER TABLE public.delivery_proofs
  ADD COLUMN IF NOT EXISTS rider_id uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS photo_url text,
  ADD COLUMN IF NOT EXISTS captured_lat double precision,
  ADD COLUMN IF NOT EXISTS captured_lng double precision,
  ADD COLUMN IF NOT EXISTS captured_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS notes text;

-- -----------------------------------------------------------------------------
-- 3. Public RPC: get_public_order_tracking
-- -----------------------------------------------------------------------------
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
  v_clean_id text;
  v_order_uuid uuid;
BEGIN
  IF p_order_identifier IS NULL OR length(trim(p_order_identifier)) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'No order identifier provided');
  END IF;

  v_clean_id := trim(p_order_identifier);

  -- A. Try finding by exact UUID
  IF v_clean_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT * INTO v_order FROM public.orders WHERE id = v_clean_id::uuid LIMIT 1;
  END IF;

  -- B. Try by order_number (e.g. ORD-6677B8E7, 6677B8E7, etc.)
  IF v_order.id IS NULL THEN
    SELECT * INTO v_order FROM public.orders 
    WHERE order_number = v_clean_id 
       OR order_number = 'ORD-' || v_clean_id
       OR order_number ILIKE v_clean_id
    LIMIT 1;
  END IF;

  -- C. Try by ID prefix or order_number substring
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

  -- Count items
  IF v_order.items IS NOT NULL AND jsonb_typeof(v_order.items) = 'array' THEN
    v_items_count := jsonb_array_length(v_order.items);
  ELSE
    v_items_count := 1;
  END IF;

  -- Fetch live rider tracking
  SELECT
    dt.lat,
    dt.lng,
    COALESCE(dt.heading, 0) AS heading,
    COALESCE(dt.speed, 0) AS speed,
    dt.accuracy,
    dt.battery_level,
    COALESCE(dt.is_off_route, false) AS is_off_route,
    COALESCE(dt.geofence_arrived, false) AS geofence_arrived,
    dt.destination_lat,
    dt.destination_lng,
    dt.updated_at
  INTO v_tracking
  FROM public.delivery_tracking dt
  WHERE dt.order_id = v_order_uuid;

  -- Fetch assigned rider profile
  IF v_order.assigned_to IS NOT NULL THEN
    SELECT
      p.id,
      COALESCE(p.name, p.business_name, 'Delivery Partner') AS name,
      p.phone
    INTO v_rider
    FROM public.profiles p
    WHERE p.id = v_order.assigned_to;
  END IF;

  -- Fetch delivery proof
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
      'user_name', COALESCE(v_order.user_name, 'Retailer Shop'),
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
      'heading', v_tracking.heading,
      'speed', v_tracking.speed,
      'accuracy', v_tracking.accuracy,
      'battery_level', v_tracking.battery_level,
      'is_off_route', v_tracking.is_off_route,
      'geofence_arrived', v_tracking.geofence_arrived,
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

-- -----------------------------------------------------------------------------
-- 4. Update get_order_tracking_bundle to be resilient
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_order_tracking_bundle(p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_bundle jsonb;
BEGIN
  v_bundle := public.get_public_order_tracking(p_order_id::text);
  IF (v_bundle->>'success')::boolean = false THEN
    RETURN jsonb_build_object('error', 'Order not found');
  END IF;
  RETURN jsonb_build_object(
    'order', v_bundle->'order',
    'tracking', v_bundle->'tracking',
    'history', '[]'::jsonb,
    'rider', v_bundle->'rider',
    'proof', v_bundle->'proof',
    'timeline', jsonb_build_object(
      'placed_at', v_bundle->'order'->>'created_at',
      'confirmed_at', v_bundle->'order'->>'created_at',
      'dispatched_at', v_bundle->'order'->>'dispatched_at',
      'delivered_at', v_bundle->'order'->>'delivered_at',
      'failed_at', NULL
    )
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. Permissions
-- -----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.get_public_order_tracking(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_order_tracking_bundle(uuid) TO anon, authenticated;

COMMIT;
