-- =============================================================================
-- Thakkar Medico — V62: Enterprise B2B Delivery Distribution System
--
-- Adds:
--   1.  driver_location_history table (GPS breadcrumb trail)
--   2.  delivery_events table (comprehensive audit log)
--   3.  vehicles table (fleet registry)
--   4.  delivery_manifests table (grouped dispatch)
--   5.  delivery_collections table (payment collection tracking)
--   6.  delivery_reconciliations table (shift-end cash reconciliation)
--   7.  Enhanced driver_locations with speed/heading/ETA
--   8.  Enhanced delivery_proofs with receiver details + GPS
--   9.  Enhanced orders with manifest/SLA/priority
--  10.  Enhanced profiles with vehicle assignment
--  11.  create_delivery_manifest RPC
--  12.  verify_manifest_dispatch RPC
--  13.  record_delivery_collection RPC
--  14.  reconcile_driver_shift RPC
--  15.  Expanded delivery failure reasons
--
-- Prerequisites: All migrations through v61 must have been applied.
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION 1: Enhanced driver_locations (speed, heading, ETA)
-- =============================================================================

ALTER TABLE public.driver_locations
  ADD COLUMN IF NOT EXISTS speed real,
  ADD COLUMN IF NOT EXISTS heading real,
  ADD COLUMN IF NOT EXISTS altitude double precision,
  ADD COLUMN IF NOT EXISTS eta_next_stop_s integer,
  ADD COLUMN IF NOT EXISTS current_order_id uuid;


-- =============================================================================
-- SECTION 2: driver_location_history (GPS breadcrumb trail)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.driver_location_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  lat           double precision NOT NULL,
  lng           double precision NOT NULL,
  speed         real,
  heading       real,
  altitude      double precision,
  accuracy_m    double precision,
  recorded_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dlh_profile_recorded
  ON public.driver_location_history (profile_id, recorded_at DESC);

-- Auto-cleanup: rows older than 30 days (run via cron or pg_cron)
-- DELETE FROM driver_location_history WHERE recorded_at < now() - interval '30 days';

ALTER TABLE public.driver_location_history ENABLE ROW LEVEL SECURITY;

-- Drivers insert their own location history
DROP POLICY IF EXISTS "dlh_insert_self" ON public.driver_location_history;
CREATE POLICY "dlh_insert_self" ON public.driver_location_history
  FOR INSERT TO authenticated
  WITH CHECK (
    profile_id = (SELECT auth.uid())
    AND (SELECT public.current_user_is_delivery())
  );

-- Admin reads all location history
DROP POLICY IF EXISTS "dlh_select_admin" ON public.driver_location_history;
CREATE POLICY "dlh_select_admin" ON public.driver_location_history
  FOR SELECT TO authenticated
  USING ((SELECT public.current_user_is_admin()));

-- Drivers can read their own history
DROP POLICY IF EXISTS "dlh_select_self" ON public.driver_location_history;
CREATE POLICY "dlh_select_self" ON public.driver_location_history
  FOR SELECT TO authenticated
  USING (
    profile_id = (SELECT auth.uid())
    AND (SELECT public.current_user_is_delivery())
  );


-- =============================================================================
-- SECTION 3: delivery_events (comprehensive audit log)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.delivery_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  manifest_id   uuid,  -- FK added after manifest table creation
  event_type    text NOT NULL CHECK (event_type IN (
    'assigned', 'accepted', 'rejected', 'picked_up', 'dispatched',
    'arrived_at_stop', 'delivery_attempted', 'delivered', 'delivery_failed',
    'collection_recorded', 'return_reported',
    'manifest_created', 'manifest_completed',
    'dispatch_verified', 'photo_uploaded', 'otp_verified',
    'gps_ping', 'status_changed', 'exception_reported',
    'vehicle_assigned', 'shift_started', 'shift_ended',
    'reconciliation_submitted', 'reconciliation_approved'
  )),
  actor_id      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  actor_role     text,
  metadata      jsonb DEFAULT '{}'::jsonb,
  gps_lat       double precision,
  gps_lng       double precision,
  gps_accuracy_m double precision,
  recorded_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_delivery_events_order
  ON public.delivery_events (order_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_delivery_events_manifest
  ON public.delivery_events (manifest_id, recorded_at DESC)
  WHERE manifest_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_delivery_events_actor
  ON public.delivery_events (actor_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_delivery_events_type
  ON public.delivery_events (event_type, recorded_at DESC);

ALTER TABLE public.delivery_events ENABLE ROW LEVEL SECURITY;

-- Admin can read all events
DROP POLICY IF EXISTS "de_select_admin" ON public.delivery_events;
CREATE POLICY "de_select_admin" ON public.delivery_events
  FOR SELECT TO authenticated
  USING ((SELECT public.current_user_is_admin()));

-- Drivers can read events for their assigned orders
DROP POLICY IF EXISTS "de_select_delivery" ON public.delivery_events;
CREATE POLICY "de_select_delivery" ON public.delivery_events
  FOR SELECT TO authenticated
  USING (
    (SELECT public.current_user_is_delivery())
    AND (
      actor_id = (SELECT auth.uid())
      OR EXISTS (
        SELECT 1 FROM public.orders o
        WHERE o.id = delivery_events.order_id
          AND o.assigned_to = (SELECT auth.uid())
      )
    )
  );

-- Any authenticated user can insert events (controlled by RPC)
DROP POLICY IF EXISTS "de_insert_authenticated" ON public.delivery_events;
CREATE POLICY "de_insert_authenticated" ON public.delivery_events
  FOR INSERT TO authenticated
  WITH CHECK (actor_id = (SELECT auth.uid()));


-- =============================================================================
-- SECTION 4: vehicles table (fleet registry)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.vehicles (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_no   text NOT NULL UNIQUE,
  vehicle_type      text NOT NULL DEFAULT 'two_wheeler' CHECK (vehicle_type IN (
    'two_wheeler', 'three_wheeler', 'four_wheeler', 'van', 'truck'
  )),
  make_model        text,
  is_active         boolean NOT NULL DEFAULT true,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;

-- All authenticated can read vehicles
DROP POLICY IF EXISTS "vehicles_select_all" ON public.vehicles;
CREATE POLICY "vehicles_select_all" ON public.vehicles
  FOR SELECT TO authenticated
  USING (true);

-- Only admin can manage vehicles
DROP POLICY IF EXISTS "vehicles_admin_all" ON public.vehicles;
CREATE POLICY "vehicles_admin_all" ON public.vehicles
  FOR ALL TO authenticated
  USING ((SELECT public.current_user_is_admin()))
  WITH CHECK ((SELECT public.current_user_is_admin()));


-- =============================================================================
-- SECTION 5: Enhanced profiles (vehicle assignment)
-- =============================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS assigned_vehicle_id uuid REFERENCES public.vehicles(id) ON DELETE SET NULL;


-- =============================================================================
-- SECTION 6: delivery_manifests table (grouped dispatch)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.delivery_manifests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manifest_number text NOT NULL UNIQUE,
  driver_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  vehicle_id      uuid REFERENCES public.vehicles(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'created' CHECK (status IN (
    'created', 'dispatch_verified', 'in_progress', 'completed', 'cancelled'
  )),
  total_orders    integer NOT NULL DEFAULT 0,
  total_value     numeric NOT NULL DEFAULT 0,
  total_collected numeric NOT NULL DEFAULT 0,
  dispatched_at   timestamptz,
  completed_at    timestamptz,
  created_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_manifests_driver
  ON public.delivery_manifests (driver_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_manifests_status
  ON public.delivery_manifests (status)
  WHERE status NOT IN ('completed', 'cancelled');

ALTER TABLE public.delivery_manifests ENABLE ROW LEVEL SECURITY;

-- Admin full access
DROP POLICY IF EXISTS "manifests_admin_all" ON public.delivery_manifests;
CREATE POLICY "manifests_admin_all" ON public.delivery_manifests
  FOR ALL TO authenticated
  USING ((SELECT public.current_user_is_admin()))
  WITH CHECK ((SELECT public.current_user_is_admin()));

-- Drivers read their own manifests
DROP POLICY IF EXISTS "manifests_select_driver" ON public.delivery_manifests;
CREATE POLICY "manifests_select_driver" ON public.delivery_manifests
  FOR SELECT TO authenticated
  USING (
    driver_id = (SELECT auth.uid())
    AND (SELECT public.current_user_is_delivery())
  );

-- Drivers can update their manifest status (dispatch verify, complete)
DROP POLICY IF EXISTS "manifests_update_driver" ON public.delivery_manifests;
CREATE POLICY "manifests_update_driver" ON public.delivery_manifests
  FOR UPDATE TO authenticated
  USING (
    driver_id = (SELECT auth.uid())
    AND (SELECT public.current_user_is_delivery())
  )
  WITH CHECK (
    driver_id = (SELECT auth.uid())
    AND (SELECT public.current_user_is_delivery())
  );

-- Now add the FK from delivery_events.manifest_id
ALTER TABLE public.delivery_events
  ADD CONSTRAINT delivery_events_manifest_fk
  FOREIGN KEY (manifest_id) REFERENCES public.delivery_manifests(id)
  ON DELETE SET NULL
  NOT VALID;


-- =============================================================================
-- SECTION 7: Enhanced orders (manifest, SLA, priority)
-- =============================================================================

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS manifest_id uuid REFERENCES public.delivery_manifests(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sla_deadline timestamptz,
  ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 3),
  ADD COLUMN IF NOT EXISTS dispatch_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS dispatch_verified_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_orders_manifest
  ON public.orders (manifest_id)
  WHERE manifest_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_sla_deadline
  ON public.orders (sla_deadline)
  WHERE status NOT IN ('delivered', 'cancelled', 'rejected', 'delivery_failed');

CREATE INDEX IF NOT EXISTS idx_orders_priority
  ON public.orders (priority, created_at)
  WHERE status NOT IN ('delivered', 'cancelled', 'rejected', 'delivery_failed');


-- =============================================================================
-- SECTION 8: Enhanced delivery_proofs (receiver + GPS)
-- =============================================================================

ALTER TABLE public.delivery_proofs
  ADD COLUMN IF NOT EXISTS receiver_name text,
  ADD COLUMN IF NOT EXISTS receiver_phone text,
  ADD COLUMN IF NOT EXISTS gps_lat double precision,
  ADD COLUMN IF NOT EXISTS gps_lng double precision,
  ADD COLUMN IF NOT EXISTS gps_accuracy_m double precision,
  ADD COLUMN IF NOT EXISTS delivered_at_gps timestamptz;


-- =============================================================================
-- SECTION 9: delivery_collections table (payment tracking)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.delivery_collections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  manifest_id     uuid REFERENCES public.delivery_manifests(id) ON DELETE SET NULL,
  method          text NOT NULL CHECK (method IN (
    'cash', 'upi', 'cheque', 'credit', 'neft', 'prepaid'
  )),
  amount          numeric NOT NULL CHECK (amount >= 0),
  reference_no    text,
  bank_name       text,
  collected_by    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  collected_at    timestamptz NOT NULL DEFAULT now(),
  verified_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  verified_at     timestamptz,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'verified', 'disputed', 'refunded'
  )),
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_collections_order
  ON public.delivery_collections (order_id);

CREATE INDEX IF NOT EXISTS idx_collections_manifest
  ON public.delivery_collections (manifest_id)
  WHERE manifest_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_collections_collector
  ON public.delivery_collections (collected_by, collected_at DESC);

CREATE INDEX IF NOT EXISTS idx_collections_status
  ON public.delivery_collections (status)
  WHERE status = 'pending';

ALTER TABLE public.delivery_collections ENABLE ROW LEVEL SECURITY;

-- Admin full access
DROP POLICY IF EXISTS "collections_admin_all" ON public.delivery_collections;
CREATE POLICY "collections_admin_all" ON public.delivery_collections
  FOR ALL TO authenticated
  USING ((SELECT public.current_user_is_admin()))
  WITH CHECK ((SELECT public.current_user_is_admin()));

-- Drivers insert collections for their assigned orders
DROP POLICY IF EXISTS "collections_insert_driver" ON public.delivery_collections;
CREATE POLICY "collections_insert_driver" ON public.delivery_collections
  FOR INSERT TO authenticated
  WITH CHECK (
    collected_by = (SELECT auth.uid())
    AND (SELECT public.current_user_is_delivery())
  );

-- Drivers read their own collections
DROP POLICY IF EXISTS "collections_select_driver" ON public.delivery_collections;
CREATE POLICY "collections_select_driver" ON public.delivery_collections
  FOR SELECT TO authenticated
  USING (
    collected_by = (SELECT auth.uid())
    AND (SELECT public.current_user_is_delivery())
  );


-- =============================================================================
-- SECTION 10: delivery_reconciliations table
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.delivery_reconciliations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id         uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  manifest_id       uuid REFERENCES public.delivery_manifests(id) ON DELETE SET NULL,
  shift_date        date NOT NULL DEFAULT CURRENT_DATE,
  expected_cash     numeric NOT NULL DEFAULT 0,
  actual_cash       numeric NOT NULL DEFAULT 0,
  discrepancy       numeric GENERATED ALWAYS AS (actual_cash - expected_cash) STORED,
  expected_upi      numeric NOT NULL DEFAULT 0,
  expected_cheque   numeric NOT NULL DEFAULT 0,
  total_collections numeric NOT NULL DEFAULT 0,
  total_orders      integer NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'approved', 'disputed', 'resolved'
  )),
  driver_notes      text,
  admin_notes       text,
  reconciled_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reconciled_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reconciliations_driver
  ON public.delivery_reconciliations (driver_id, shift_date DESC);

CREATE INDEX IF NOT EXISTS idx_reconciliations_status
  ON public.delivery_reconciliations (status)
  WHERE status IN ('pending', 'disputed');

ALTER TABLE public.delivery_reconciliations ENABLE ROW LEVEL SECURITY;

-- Admin full access
DROP POLICY IF EXISTS "recon_admin_all" ON public.delivery_reconciliations;
CREATE POLICY "recon_admin_all" ON public.delivery_reconciliations
  FOR ALL TO authenticated
  USING ((SELECT public.current_user_is_admin()))
  WITH CHECK ((SELECT public.current_user_is_admin()));

-- Drivers read their own reconciliations
DROP POLICY IF EXISTS "recon_select_driver" ON public.delivery_reconciliations;
CREATE POLICY "recon_select_driver" ON public.delivery_reconciliations
  FOR SELECT TO authenticated
  USING (
    driver_id = (SELECT auth.uid())
    AND (SELECT public.current_user_is_delivery())
  );


-- =============================================================================
-- SECTION 11: Expanded delivery failure reasons
-- =============================================================================

-- Update the delivery_report_failed RPC to accept more reasons
CREATE OR REPLACE FUNCTION public.delivery_report_failed(
  p_order_id uuid,
  p_reason   text,
  p_notes    text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status      text;
  v_assigned_to uuid;
BEGIN
  IF NOT (SELECT public.current_user_is_delivery()) THEN
    RAISE EXCEPTION 'access_denied';
  END IF;

  SELECT status, assigned_to
    INTO v_status, v_assigned_to
    FROM public.orders
   WHERE id = p_order_id;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'order_not_found';
  END IF;

  IF v_assigned_to IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'access_denied';
  END IF;

  IF v_status <> 'dispatched' THEN
    RAISE EXCEPTION 'invalid_status'
      USING HINT = format('Order must be dispatched to report failure, currently %s', v_status);
  END IF;

  -- Expanded enterprise failure reasons
  IF p_reason IS NULL OR p_reason NOT IN (
    'shop_closed', 'retailer_unreachable', 'wrong_address',
    'refused_delivery', 'partial_delivery', 'damaged_goods',
    'expired_products', 'payment_dispute', 'other'
  ) THEN
    RAISE EXCEPTION 'invalid_reason'
      USING HINT = 'Valid reasons: shop_closed, retailer_unreachable, wrong_address, refused_delivery, partial_delivery, damaged_goods, expired_products, payment_dispute, other';
  END IF;

  -- Require notes for "other" reason
  IF p_reason = 'other' AND (p_notes IS NULL OR trim(p_notes) = '') THEN
    RAISE EXCEPTION 'notes_required'
      USING HINT = 'Notes are required when reason is "other"';
  END IF;

  UPDATE public.orders
     SET status = 'delivery_failed',
         delivery_failure_reason = p_reason,
         notes = CASE
           WHEN p_notes IS NOT NULL AND trim(p_notes) <> '' THEN
             COALESCE(notes, '') || E'\n[Delivery failed: ' || trim(p_notes) || ']'
           ELSE notes
         END
   WHERE id = p_order_id;

  -- Log audit event
  INSERT INTO public.delivery_events (order_id, event_type, actor_id, actor_role, metadata)
  VALUES (
    p_order_id, 'delivery_failed', auth.uid(), 'delivery',
    jsonb_build_object('reason', p_reason, 'notes', COALESCE(p_notes, ''))
  );
END;
$$;

REVOKE ALL ON FUNCTION public.delivery_report_failed(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delivery_report_failed(uuid, text, text) TO authenticated;


-- =============================================================================
-- SECTION 12: create_delivery_manifest RPC
-- =============================================================================

CREATE OR REPLACE FUNCTION public.create_delivery_manifest(
  p_driver_id    uuid,
  p_order_ids    uuid[],
  p_vehicle_id   uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_manifest_id     uuid;
  v_manifest_number text;
  v_driver_role     text;
  v_total_value     numeric := 0;
  v_total_orders    integer := 0;
  v_order_id        uuid;
  v_order_status    text;
  v_sla_hours       integer;
  v_priority        integer;
BEGIN
  -- Admin only
  IF NOT (SELECT public.current_user_is_admin()) THEN
    RAISE EXCEPTION 'access_denied';
  END IF;

  -- Validate driver
  SELECT role INTO v_driver_role FROM public.profiles WHERE id = p_driver_id;
  IF v_driver_role IS DISTINCT FROM 'delivery' THEN
    RAISE EXCEPTION 'invalid_delivery_profile';
  END IF;

  -- Validate vehicle if provided
  IF p_vehicle_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.vehicles WHERE id = p_vehicle_id AND is_active = true) THEN
      RAISE EXCEPTION 'vehicle_not_found_or_inactive';
    END IF;

    -- Assign vehicle to driver profile
    UPDATE public.profiles SET assigned_vehicle_id = p_vehicle_id WHERE id = p_driver_id;
  END IF;

  -- Generate manifest number: MF-YYYYMMDD-XXXX
  v_manifest_number := 'MF-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(
    (SELECT COALESCE(COUNT(*)::int + 1, 1) FROM public.delivery_manifests
     WHERE created_at::date = CURRENT_DATE)::text, 4, '0'
  );

  -- Create manifest
  v_manifest_id := gen_random_uuid();
  INSERT INTO public.delivery_manifests (id, manifest_number, driver_id, vehicle_id, created_by)
  VALUES (v_manifest_id, v_manifest_number, p_driver_id, p_vehicle_id, auth.uid());

  -- Assign orders to manifest and set SLA
  FOREACH v_order_id IN ARRAY p_order_ids
  LOOP
    SELECT status, priority INTO v_order_status, v_priority
      FROM public.orders WHERE id = v_order_id;

    IF v_order_status IS NULL THEN
      CONTINUE;
    END IF;

    -- Determine SLA based on priority
    v_sla_hours := CASE
      WHEN v_priority = 1 THEN 2   -- Urgent: 2 hours
      WHEN v_priority = 2 THEN 3   -- High: 3 hours
      ELSE 4                        -- Normal: 4 hours
    END;

    -- Update order with manifest and SLA
    UPDATE public.orders
       SET manifest_id = v_manifest_id,
           sla_deadline = COALESCE(sla_deadline, now() + (v_sla_hours || ' hours')::interval)
     WHERE id = v_order_id;

    -- If not already assigned, assign to driver
    IF v_order_status IN ('pending', 'approved', 'packed') THEN
      PERFORM public.assign_order_to_delivery(v_order_id, p_driver_id);
    END IF;

    -- Accumulate totals
    SELECT grand_total INTO v_total_value
      FROM public.orders WHERE id = v_order_id;
    v_total_orders := v_total_orders + 1;
  END LOOP;

  -- Update manifest totals
  UPDATE public.delivery_manifests
     SET total_orders = v_total_orders,
         total_value = (
           SELECT COALESCE(SUM(grand_total), 0)
             FROM public.orders WHERE manifest_id = v_manifest_id
         )
   WHERE id = v_manifest_id;

  -- Log audit event
  INSERT INTO public.delivery_events (manifest_id, event_type, actor_id, actor_role, metadata)
  VALUES (
    v_manifest_id, 'manifest_created', auth.uid(), 'admin',
    jsonb_build_object(
      'manifest_number', v_manifest_number,
      'driver_id', p_driver_id,
      'order_count', v_total_orders,
      'vehicle_id', p_vehicle_id
    )
  );

  RETURN jsonb_build_object(
    'manifest_id', v_manifest_id,
    'manifest_number', v_manifest_number,
    'total_orders', v_total_orders,
    'total_value', v_total_value
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_delivery_manifest(uuid, uuid[], uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_delivery_manifest(uuid, uuid[], uuid) TO authenticated;


-- =============================================================================
-- SECTION 13: verify_manifest_dispatch RPC
-- =============================================================================

CREATE OR REPLACE FUNCTION public.verify_manifest_dispatch(
  p_manifest_id    uuid,
  p_verified_items jsonb DEFAULT '[]'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_manifest RECORD;
BEGIN
  IF NOT (SELECT public.current_user_is_delivery()) THEN
    RAISE EXCEPTION 'access_denied';
  END IF;

  SELECT id, driver_id, status
    INTO v_manifest
    FROM public.delivery_manifests
   WHERE id = p_manifest_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'manifest_not_found';
  END IF;

  IF v_manifest.driver_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'access_denied';
  END IF;

  IF v_manifest.status NOT IN ('created') THEN
    RAISE EXCEPTION 'invalid_status'
      USING HINT = format('Manifest must be in created status, currently %s', v_manifest.status);
  END IF;

  -- Mark manifest as dispatch verified
  UPDATE public.delivery_manifests
     SET status = 'dispatch_verified',
         dispatched_at = now(),
         updated_at = now()
   WHERE id = p_manifest_id;

  -- Mark all orders in manifest as dispatch verified
  UPDATE public.orders
     SET dispatch_verified_at = now(),
         dispatch_verified_by = auth.uid()
   WHERE manifest_id = p_manifest_id
     AND dispatch_verified_at IS NULL;

  -- Log audit event
  INSERT INTO public.delivery_events (manifest_id, event_type, actor_id, actor_role, metadata)
  VALUES (
    p_manifest_id, 'dispatch_verified', auth.uid(), 'delivery',
    jsonb_build_object('verified_items', p_verified_items)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.verify_manifest_dispatch(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_manifest_dispatch(uuid, jsonb) TO authenticated;


-- =============================================================================
-- SECTION 14: record_delivery_collection RPC
-- =============================================================================

CREATE OR REPLACE FUNCTION public.record_delivery_collection(
  p_order_id     uuid,
  p_method       text,
  p_amount       numeric,
  p_reference_no text DEFAULT NULL,
  p_bank_name    text DEFAULT NULL,
  p_notes        text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order         RECORD;
  v_collection_id uuid;
BEGIN
  IF NOT (SELECT public.current_user_is_delivery()) THEN
    RAISE EXCEPTION 'access_denied';
  END IF;

  SELECT id, assigned_to, status, manifest_id, grand_total
    INTO v_order
    FROM public.orders
   WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_not_found';
  END IF;

  IF v_order.assigned_to IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'access_denied';
  END IF;

  -- Validate method
  IF p_method NOT IN ('cash', 'upi', 'cheque', 'credit', 'neft', 'prepaid') THEN
    RAISE EXCEPTION 'invalid_method'
      USING HINT = 'Valid methods: cash, upi, cheque, credit, neft, prepaid';
  END IF;

  -- Validate amount
  IF p_amount IS NULL OR p_amount < 0 THEN
    RAISE EXCEPTION 'invalid_amount';
  END IF;

  -- Require reference for non-cash methods
  IF p_method IN ('upi', 'cheque', 'neft') AND (p_reference_no IS NULL OR trim(p_reference_no) = '') THEN
    RAISE EXCEPTION 'reference_required'
      USING HINT = format('Reference number is required for %s payments', p_method);
  END IF;

  -- Require bank name for cheque
  IF p_method = 'cheque' AND (p_bank_name IS NULL OR trim(p_bank_name) = '') THEN
    RAISE EXCEPTION 'bank_name_required'
      USING HINT = 'Bank name is required for cheque payments';
  END IF;

  -- Insert collection record
  v_collection_id := gen_random_uuid();
  INSERT INTO public.delivery_collections (
    id, order_id, manifest_id, method, amount,
    reference_no, bank_name, collected_by, notes
  ) VALUES (
    v_collection_id, p_order_id, v_order.manifest_id, p_method, p_amount,
    p_reference_no, p_bank_name, auth.uid(), p_notes
  );

  -- Update manifest total_collected if manifest exists
  IF v_order.manifest_id IS NOT NULL THEN
    UPDATE public.delivery_manifests
       SET total_collected = (
         SELECT COALESCE(SUM(amount), 0)
           FROM public.delivery_collections
          WHERE manifest_id = v_order.manifest_id
            AND status <> 'refunded'
       ),
       updated_at = now()
     WHERE id = v_order.manifest_id;
  END IF;

  -- Log audit event
  INSERT INTO public.delivery_events (order_id, manifest_id, event_type, actor_id, actor_role, metadata)
  VALUES (
    p_order_id, v_order.manifest_id, 'collection_recorded', auth.uid(), 'delivery',
    jsonb_build_object(
      'method', p_method,
      'amount', p_amount,
      'reference_no', COALESCE(p_reference_no, ''),
      'collection_id', v_collection_id
    )
  );

  RETURN v_collection_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_delivery_collection(uuid, text, numeric, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_delivery_collection(uuid, text, numeric, text, text, text) TO authenticated;


-- =============================================================================
-- SECTION 15: reconcile_driver_shift RPC
-- =============================================================================

CREATE OR REPLACE FUNCTION public.reconcile_driver_shift(
  p_driver_id   uuid,
  p_actual_cash numeric,
  p_manifest_id uuid DEFAULT NULL,
  p_admin_notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_recon_id       uuid;
  v_expected_cash  numeric;
  v_expected_upi   numeric;
  v_expected_cheque numeric;
  v_total_coll     numeric;
  v_total_orders   integer;
  v_manifest_filter text;
BEGIN
  IF NOT (SELECT public.current_user_is_admin()) THEN
    RAISE EXCEPTION 'access_denied';
  END IF;

  -- Calculate expected amounts from collections
  IF p_manifest_id IS NOT NULL THEN
    SELECT
      COALESCE(SUM(CASE WHEN method = 'cash' THEN amount ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN method = 'upi' THEN amount ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN method = 'cheque' THEN amount ELSE 0 END), 0),
      COALESCE(SUM(amount), 0),
      COUNT(DISTINCT order_id)
    INTO v_expected_cash, v_expected_upi, v_expected_cheque, v_total_coll, v_total_orders
    FROM public.delivery_collections
    WHERE manifest_id = p_manifest_id
      AND collected_by = p_driver_id
      AND status <> 'refunded';
  ELSE
    -- Per-shift: all collections for today
    SELECT
      COALESCE(SUM(CASE WHEN method = 'cash' THEN amount ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN method = 'upi' THEN amount ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN method = 'cheque' THEN amount ELSE 0 END), 0),
      COALESCE(SUM(amount), 0),
      COUNT(DISTINCT order_id)
    INTO v_expected_cash, v_expected_upi, v_expected_cheque, v_total_coll, v_total_orders
    FROM public.delivery_collections
    WHERE collected_by = p_driver_id
      AND collected_at::date = CURRENT_DATE
      AND status <> 'refunded';
  END IF;

  v_recon_id := gen_random_uuid();
  INSERT INTO public.delivery_reconciliations (
    id, driver_id, manifest_id, shift_date,
    expected_cash, actual_cash,
    expected_upi, expected_cheque,
    total_collections, total_orders,
    admin_notes, reconciled_by, reconciled_at,
    status
  ) VALUES (
    v_recon_id, p_driver_id, p_manifest_id, CURRENT_DATE,
    v_expected_cash, p_actual_cash,
    v_expected_upi, v_expected_cheque,
    v_total_coll, v_total_orders,
    p_admin_notes, auth.uid(), now(),
    CASE
      WHEN ABS(p_actual_cash - v_expected_cash) <= 1 THEN 'approved'  -- ±₹1 tolerance
      ELSE 'pending'
    END
  );

  -- Log audit event
  INSERT INTO public.delivery_events (event_type, actor_id, actor_role, manifest_id, metadata)
  VALUES (
    CASE
      WHEN ABS(p_actual_cash - v_expected_cash) <= 1 THEN 'reconciliation_approved'
      ELSE 'reconciliation_submitted'
    END,
    auth.uid(), 'admin', p_manifest_id,
    jsonb_build_object(
      'driver_id', p_driver_id,
      'expected_cash', v_expected_cash,
      'actual_cash', p_actual_cash,
      'discrepancy', p_actual_cash - v_expected_cash,
      'total_collections', v_total_coll
    )
  );

  RETURN v_recon_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_driver_shift(uuid, numeric, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reconcile_driver_shift(uuid, numeric, uuid, text) TO authenticated;


-- =============================================================================
-- SECTION 16: Grant necessary permissions
-- =============================================================================

GRANT SELECT ON public.driver_location_history TO authenticated;
GRANT SELECT, INSERT ON public.delivery_events TO authenticated;
GRANT SELECT ON public.vehicles TO authenticated;
GRANT SELECT ON public.delivery_manifests TO authenticated;
GRANT SELECT ON public.delivery_collections TO authenticated;
GRANT SELECT ON public.delivery_reconciliations TO authenticated;


COMMIT;
