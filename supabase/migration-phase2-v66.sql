-- =============================================================================
-- Thakkar Medico — V66: Live Delivery Tracking (Phase 2)
--
-- Adds:
--   1. delivery_proofs table (photo URL, coordinates, timestamp, notes)
--   2. Storage bucket 'delivery-proofs' configuration and policies
--   3. orders table addition: failed_at timestamptz
--   4. RPC: get_active_order_for_rider(p_rider_id uuid)
--   5. RPC extension: get_order_tracking_bundle(p_order_id uuid) with proof join
--   6. Public read policy on delivery_tracking for active/completed orders
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION 1: delivery_proofs table (safe create + alter for existing schemas)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.delivery_proofs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_proofs_order_unique UNIQUE (order_id)
);

-- Ensure all Phase 2 columns exist even if table was created in an earlier migration
ALTER TABLE public.delivery_proofs
  ADD COLUMN IF NOT EXISTS rider_id uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS photo_url text,
  ADD COLUMN IF NOT EXISTS captured_lat double precision,
  ADD COLUMN IF NOT EXISTS captured_lng double precision,
  ADD COLUMN IF NOT EXISTS captured_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS notes text;

-- Ensure unique constraint on order_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'delivery_proofs_order_unique'
  ) THEN
    ALTER TABLE public.delivery_proofs ADD CONSTRAINT delivery_proofs_order_unique UNIQUE (order_id);
  END IF;
EXCEPTION
  WHEN duplicate_table OR duplicate_object OR others THEN
    NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_delivery_proofs_order
  ON public.delivery_proofs (order_id);

CREATE INDEX IF NOT EXISTS idx_delivery_proofs_rider
  ON public.delivery_proofs (rider_id)
  WHERE rider_id IS NOT NULL;

-- Enable RLS
ALTER TABLE public.delivery_proofs ENABLE ROW LEVEL SECURITY;

-- Admin can read all proofs
DROP POLICY IF EXISTS "dp_select_admin" ON public.delivery_proofs;
CREATE POLICY "dp_select_admin" ON public.delivery_proofs
  FOR SELECT TO authenticated
  USING ((SELECT public.current_user_is_admin()));

-- Delivery drivers can read all proofs
DROP POLICY IF EXISTS "dp_select_delivery" ON public.delivery_proofs;
CREATE POLICY "dp_select_delivery" ON public.delivery_proofs
  FOR SELECT TO authenticated
  USING ((SELECT public.current_user_is_delivery()));

-- Rider can insert proof for assigned order
DROP POLICY IF EXISTS "dp_insert_rider" ON public.delivery_proofs;
CREATE POLICY "dp_insert_rider" ON public.delivery_proofs
  FOR INSERT TO authenticated
  WITH CHECK (
    rider_id = (SELECT auth.uid())
    AND (SELECT public.current_user_is_delivery())
  );

-- Rider can update own proof row (e.g. for retrying or adding notes)
DROP POLICY IF EXISTS "dp_update_rider" ON public.delivery_proofs;
CREATE POLICY "dp_update_rider" ON public.delivery_proofs
  FOR UPDATE TO authenticated
  USING (
    rider_id = (SELECT auth.uid())
    AND (SELECT public.current_user_is_delivery())
  )
  WITH CHECK (
    rider_id = (SELECT auth.uid())
    AND (SELECT public.current_user_is_delivery())
  );


-- =============================================================================
-- SECTION 2: Storage Bucket 'delivery-proofs'
-- =============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'delivery-proofs',
  'delivery-proofs',
  true, -- public URLs enabled for direct image rendering
  5242880, -- 5 MB max size
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = true,
  file_size_limit = 5242880,
  allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];

-- Storage upload policy for authenticated delivery drivers
DROP POLICY IF EXISTS "dp_storage_upload_delivery" ON storage.objects;
CREATE POLICY "dp_storage_upload_delivery" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'delivery-proofs'
  );

DROP POLICY IF EXISTS "dp_storage_update_delivery" ON storage.objects;
CREATE POLICY "dp_storage_update_delivery" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'delivery-proofs'
  )
  WITH CHECK (
    bucket_id = 'delivery-proofs'
  );

-- Storage read policy for all authenticated and public users (for thumbnail display)
DROP POLICY IF EXISTS "dp_storage_read_all" ON storage.objects;
CREATE POLICY "dp_storage_read_all" ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'delivery-proofs');


-- =============================================================================
-- SECTION 3: Orders table additions
-- =============================================================================

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS failed_at timestamptz;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS failed_reason text;


-- =============================================================================
-- SECTION 4: Public SELECT policy on delivery_tracking
-- =============================================================================

-- Allow anonymous & public web tracker to view active / completed delivery location
DROP POLICY IF EXISTS "dt_select_public_active" ON public.delivery_tracking;
CREATE POLICY "dt_select_public_active" ON public.delivery_tracking
  FOR SELECT TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = delivery_tracking.order_id
        AND (o.delivery_status IS NOT NULL AND o.delivery_status != 'pending')
    )
  );


-- =============================================================================
-- SECTION 5: RPC get_active_order_for_rider(p_rider_id uuid)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_active_order_for_rider(p_rider_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_order record;
  v_rider record;
  v_items_count int := 0;
  v_items_total numeric := 0;
  v_snapshot jsonb;
  v_result jsonb;
BEGIN
  -- 1. Look for the single active order assigned to this rider
  -- Active delivery_status: dispatched, in_transit, arriving_soon
  -- Fallback active status: assigned, accepted, picked_up, dispatched
  SELECT
    o.id,
    o.order_number,
    o.user_id,
    o.user_name,
    o.user_phone,
    o.status,
    o.delivery_status,
    o.items,
    o.subtotal,
    o.gst,
    o.grand_total,
    o.delivery_address,
    o.delivery_type,
    o.fulfillment_mode,
    o.payment_mode,
    o.notes,
    o.assigned_to,
    o.assigned_at,
    o.dispatched_at,
    o.created_at,
    o.delivery_snapshot
  INTO v_order
  FROM public.orders o
  WHERE o.assigned_to = p_rider_id
    AND (
      o.delivery_status IN ('dispatched', 'in_transit', 'arriving_soon')
      OR (
        (o.delivery_status IS NULL OR o.delivery_status = 'pending')
        AND o.status IN ('assigned', 'accepted', 'picked_up', 'dispatched')
      )
    )
    AND o.status NOT IN ('delivered', 'cancelled', 'rejected', 'delivery_failed')
    AND (o.delivery_status IS NULL OR o.delivery_status NOT IN ('delivered', 'failed'))
  ORDER BY COALESCE(o.dispatched_at, o.assigned_at, o.created_at) DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- 2. Extract rider profile details
  SELECT
    p.id,
    COALESCE(p.name, p.business_name, 'Delivery Partner') AS name,
    p.phone
  INTO v_rider
  FROM public.profiles p
  WHERE p.id = p_rider_id;

  -- 3. Calculate items count and total
  IF v_order.items IS NOT NULL AND jsonb_typeof(v_order.items) = 'array' THEN
    v_items_count := jsonb_array_length(v_order.items);
  ELSE
    v_items_count := 1;
  END IF;
  v_items_total := COALESCE(v_order.grand_total, v_order.subtotal, 0);

  -- 4. Construct delivery snapshot
  v_snapshot := COALESCE(
    v_order.delivery_snapshot,
    jsonb_build_object(
      'shop_name', v_order.user_name,
      'full_address', v_order.delivery_address,
      'receiver_name', v_order.user_name,
      'receiver_phone', v_order.user_phone,
      'landmark', '',
      'best_delivery_window', ''
    )
  );

  -- 5. Construct response object
  v_result := jsonb_build_object(
    'order', row_to_json(v_order),
    'delivery_snapshot', v_snapshot,
    'items_summary', jsonb_build_object(
      'count', v_items_count,
      'total', v_items_total,
      'items', COALESCE(v_order.items, '[]'::jsonb)
    ),
    'rider_name', COALESCE(v_rider.name, 'Delivery Partner'),
    'rider_phone', COALESCE(v_rider.phone, '')
  );

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_active_order_for_rider(uuid) TO authenticated;


-- =============================================================================
-- SECTION 6: Extend get_order_tracking_bundle with delivery_proofs
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_order_tracking_bundle(p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_order record;
  v_tracking record;
  v_history jsonb;
  v_rider record;
  v_proof record;
  v_result jsonb;
BEGIN
  -- 1. Fetch order
  SELECT
    o.id,
    o.order_number,
    o.user_id,
    o.user_name,
    o.user_phone,
    o.status,
    o.delivery_status,
    o.items,
    o.subtotal,
    o.gst,
    o.grand_total,
    o.delivery_address,
    o.delivery_type,
    o.fulfillment_mode,
    o.payment_mode,
    o.notes,
    o.assigned_to,
    o.assigned_at,
    o.dispatched_at,
    o.delivered_at,
    o.failed_at,
    o.failed_reason,
    o.created_at,
    o.delivery_snapshot
  INTO v_order
  FROM public.orders o
  WHERE o.id = p_order_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Order not found');
  END IF;

  -- 2. Fetch current tracking row
  SELECT
    dt.id,
    dt.order_id,
    dt.rider_id,
    dt.lat,
    dt.lng,
    dt.heading,
    dt.speed,
    dt.accuracy,
    dt.battery_level,
    dt.is_off_route,
    dt.geofence_arrived,
    dt.total_distance_covered,
    dt.updated_at
  INTO v_tracking
  FROM public.delivery_tracking dt
  WHERE dt.order_id = p_order_id;

  -- 3. Fetch last 50 location history points ordered chronologically
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'lat', h.lat,
        'lng', h.lng,
        'heading', h.heading,
        'speed', h.speed,
        'recorded_at', h.recorded_at
      ) ORDER BY h.recorded_at ASC
    ),
    '[]'::jsonb
  )
  INTO v_history
  FROM (
    SELECT lat, lng, heading, speed, recorded_at
    FROM public.delivery_location_history
    WHERE order_id = p_order_id
    ORDER BY recorded_at DESC
    LIMIT 50
  ) h;

  -- 4. Fetch rider profile if assigned
  IF v_order.assigned_to IS NOT NULL THEN
    SELECT
      p.id,
      COALESCE(p.name, p.business_name, 'Delivery Partner') AS name,
      p.phone
    INTO v_rider
    FROM public.profiles p
    WHERE p.id = v_order.assigned_to;
  END IF;

  -- 5. Fetch delivery proof if present
  SELECT
    dp.id,
    dp.photo_url,
    dp.captured_lat,
    dp.captured_lng,
    dp.captured_at,
    dp.notes
  INTO v_proof
  FROM public.delivery_proofs dp
  WHERE dp.order_id = p_order_id;

  -- 6. Construct single bundle JSON
  v_result := jsonb_build_object(
    'order', row_to_json(v_order),
    'tracking', CASE WHEN v_tracking.id IS NOT NULL THEN row_to_json(v_tracking) ELSE NULL END,
    'history', v_history,
    'rider', CASE WHEN v_rider.id IS NOT NULL THEN jsonb_build_object(
      'id', v_rider.id,
      'name', v_rider.name,
      'phone', v_rider.phone
    ) ELSE NULL END,
    'proof', CASE WHEN v_proof.id IS NOT NULL THEN jsonb_build_object(
      'id', v_proof.id,
      'photo_url', v_proof.photo_url,
      'captured_lat', v_proof.captured_lat,
      'captured_lng', v_proof.captured_lng,
      'captured_at', v_proof.captured_at,
      'notes', v_proof.notes
    ) ELSE NULL END,
    'timeline', jsonb_build_object(
      'placed_at', v_order.created_at,
      'confirmed_at', COALESCE(v_order.assigned_at, v_order.created_at),
      'dispatched_at', v_order.dispatched_at,
      'delivered_at', v_order.delivered_at,
      'failed_at', CASE WHEN v_order.delivery_status = 'failed' OR v_order.status = 'delivery_failed' THEN COALESCE(v_order.failed_at, v_order.delivered_at) ELSE NULL END
    )
  );

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_order_tracking_bundle(uuid) TO authenticated;

COMMIT;
