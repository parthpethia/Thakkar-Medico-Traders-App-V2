-- =============================================================================
-- Thakkar Medico — V65: Live Per-Order Delivery Tracking (Phase 1)
--
-- Adds:
--   1. delivery_tracking table (single row per order, upserted with latest rider GPS)
--   2. delivery_location_history table (GPS ping trail for breadcrumbs)
--   3. Orders table additions: dispatched_at, delivered_at, failed_reason, delivery_status
--   4. RLS policies for delivery_tracking and delivery_location_history
--   5. Supabase Realtime enabled on both tables
--   6. Indexes for fast lookups
--   7. RPC: get_order_tracking_bundle(p_order_id uuid)
--
-- Prerequisites: All migrations through v64 must have been applied.
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION 1: delivery_tracking table (one row per order — latest rider position)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.delivery_tracking (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  rider_id                uuid REFERENCES auth.users(id),
  lat                     double precision NOT NULL,
  lng                     double precision NOT NULL,
  heading                 double precision,           -- compass direction 0-360
  speed                   double precision,           -- m/s from GPS
  accuracy                double precision,           -- GPS accuracy in meters
  battery_level           integer,                    -- rider phone battery %
  is_off_route            boolean DEFAULT false,      -- true if >400m from route
  geofence_arrived        boolean DEFAULT false,      -- true when within 500m of destination
  total_distance_covered  double precision DEFAULT 0, -- meters travelled so far
  updated_at              timestamptz NOT NULL DEFAULT now(),

  -- Enforce exactly one row per order (upsert target)
  CONSTRAINT delivery_tracking_order_unique UNIQUE (order_id)
);

-- Fast lookups
CREATE INDEX IF NOT EXISTS idx_delivery_tracking_order
  ON public.delivery_tracking (order_id);

CREATE INDEX IF NOT EXISTS idx_delivery_tracking_rider
  ON public.delivery_tracking (rider_id)
  WHERE rider_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_delivery_tracking_updated
  ON public.delivery_tracking (updated_at DESC);


-- =============================================================================
-- SECTION 2: delivery_location_history table (GPS breadcrumb trail)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.delivery_location_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  rider_id      uuid REFERENCES auth.users(id),
  lat           double precision NOT NULL,
  lng           double precision NOT NULL,
  heading       double precision,
  speed         double precision,
  recorded_at   timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_delivery_location_history_order_time
  ON public.delivery_location_history (order_id, recorded_at);

-- NOTE on 7-Day Auto-Purge (pg_cron):
-- If pg_cron extension is enabled on your Supabase instance, run:
--   SELECT cron.schedule('purge-delivery-history-7d', '0 3 * * *',
--     $$DELETE FROM public.delivery_location_history WHERE recorded_at < now() - interval '7 days'$$);
-- Otherwise, a periodic maintenance edge function or Supabase Scheduled Function can run the delete query.


-- =============================================================================
-- SECTION 3: Row Level Security for delivery_tracking & history
-- =============================================================================

ALTER TABLE public.delivery_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_location_history ENABLE ROW LEVEL SECURITY;

-- Admin can read all tracking rows
DROP POLICY IF EXISTS "dt_select_admin" ON public.delivery_tracking;
CREATE POLICY "dt_select_admin" ON public.delivery_tracking
  FOR SELECT TO authenticated
  USING ((SELECT public.current_user_is_admin()));

-- Delivery staff can read all tracking rows
DROP POLICY IF EXISTS "dt_select_delivery" ON public.delivery_tracking;
CREATE POLICY "dt_select_delivery" ON public.delivery_tracking
  FOR SELECT TO authenticated
  USING ((SELECT public.current_user_is_delivery()));

-- Rider can upsert only their own rows
DROP POLICY IF EXISTS "dt_insert_self" ON public.delivery_tracking;
CREATE POLICY "dt_insert_self" ON public.delivery_tracking
  FOR INSERT TO authenticated
  WITH CHECK (
    rider_id = (SELECT auth.uid())
    AND (SELECT public.current_user_is_delivery())
  );

DROP POLICY IF EXISTS "dt_update_self" ON public.delivery_tracking;
CREATE POLICY "dt_update_self" ON public.delivery_tracking
  FOR UPDATE TO authenticated
  USING (
    rider_id = (SELECT auth.uid())
    AND (SELECT public.current_user_is_delivery())
  )
  WITH CHECK (
    rider_id = (SELECT auth.uid())
    AND (SELECT public.current_user_is_delivery())
  );

-- Location History RLS
DROP POLICY IF EXISTS "dlh_select_admin" ON public.delivery_location_history;
CREATE POLICY "dlh_select_admin" ON public.delivery_location_history
  FOR SELECT TO authenticated
  USING ((SELECT public.current_user_is_admin()));

DROP POLICY IF EXISTS "dlh_select_delivery" ON public.delivery_location_history;
CREATE POLICY "dlh_select_delivery" ON public.delivery_location_history
  FOR SELECT TO authenticated
  USING ((SELECT public.current_user_is_delivery()));

DROP POLICY IF EXISTS "dlh_insert_self" ON public.delivery_location_history;
CREATE POLICY "dlh_insert_self" ON public.delivery_location_history
  FOR INSERT TO authenticated
  WITH CHECK (
    rider_id = (SELECT auth.uid())
    AND (SELECT public.current_user_is_delivery())
  );


-- =============================================================================
-- SECTION 4: Enable Supabase Realtime (Idempotent)
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'delivery_tracking'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.delivery_tracking;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'delivery_location_history'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.delivery_location_history;
  END IF;
END $$;


-- =============================================================================
-- SECTION 5: Orders table additions for delivery lifecycle
-- =============================================================================

-- dispatched_at: when rider was dispatched with the order
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS dispatched_at timestamptz;

-- delivered_at: when delivery was completed
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz;

-- failed_reason: reason if delivery failed
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS failed_reason text;

-- delivery_status: parallel delivery-specific status tracking
-- Allowed values: 'pending', 'dispatched', 'in_transit', 'arriving_soon', 'signal_lost', 'delivered', 'failed'
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS delivery_status text DEFAULT 'pending';

-- Enforce CHECK constraint on delivery_status
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_delivery_status_check'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_delivery_status_check
      CHECK (delivery_status IN ('pending', 'dispatched', 'in_transit', 'arriving_soon', 'signal_lost', 'delivered', 'failed'));
  END IF;
END $$;

-- Index for filtering by delivery_status
CREATE INDEX IF NOT EXISTS idx_orders_delivery_status
  ON public.orders (delivery_status)
  WHERE delivery_status IS NOT NULL
    AND delivery_status NOT IN ('delivered', 'failed');


-- =============================================================================
-- SECTION 6: RPC get_order_tracking_bundle
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

  -- 5. Construct single bundle JSON
  v_result := jsonb_build_object(
    'order', row_to_json(v_order),
    'tracking', CASE WHEN v_tracking.id IS NOT NULL THEN row_to_json(v_tracking) ELSE NULL END,
    'history', v_history,
    'rider', CASE WHEN v_rider.id IS NOT NULL THEN jsonb_build_object(
      'id', v_rider.id,
      'name', v_rider.name,
      'phone', v_rider.phone
    ) ELSE NULL END,
    'timeline', jsonb_build_object(
      'placed_at', v_order.created_at,
      'confirmed_at', COALESCE(v_order.assigned_at, v_order.created_at),
      'dispatched_at', v_order.dispatched_at,
      'delivered_at', v_order.delivered_at,
      'failed_at', CASE WHEN v_order.delivery_status = 'failed' OR v_order.status = 'delivery_failed' THEN v_order.delivered_at ELSE NULL END
    )
  );

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_order_tracking_bundle(uuid) TO authenticated;

COMMIT;
