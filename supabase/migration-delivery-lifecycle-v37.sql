-- =============================================================================
-- Thakkar Medico — V37: Delivery lifecycle (assign → accept → pickup → deliver)
-- + driver live locations (admin read)
-- Prerequisites: migration-brand-discovery-v36.sql (or latest applied)
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. status_before_assignment + accepted status
-- ---------------------------------------------------------------------------
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS status_before_assignment text;

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_status_check;

ALTER TABLE public.orders
  ADD CONSTRAINT orders_status_check
  CHECK (status IN (
    'pending_payment',
    'pending',
    'assigned',
    'accepted',
    'approved',
    'packed',
    'picked_up',
    'dispatched',
    'delivered',
    'cancelled',
    'payment_failed',
    'rejected'
  ));

-- ---------------------------------------------------------------------------
-- 2. Status transitions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_order_status_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_valid       boolean := false;
  v_points      int;
  v_item        RECORD;
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  v_valid := CASE
    WHEN OLD.status = 'pending_payment' AND NEW.status IN ('pending', 'cancelled', 'assigned', 'payment_failed') THEN true
    WHEN OLD.status = 'payment_failed'  AND NEW.status IN ('pending_payment', 'cancelled')                  THEN true
    WHEN OLD.status = 'pending'         AND NEW.status IN ('approved', 'cancelled', 'assigned', 'rejected')  THEN true
    WHEN OLD.status = 'approved'        AND NEW.status IN ('packed', 'cancelled', 'assigned')                THEN true
    WHEN OLD.status = 'packed'          AND NEW.status IN ('dispatched', 'cancelled', 'assigned')            THEN true
    WHEN OLD.status = 'assigned'        AND NEW.status IN ('accepted', 'cancelled', 'rejected', 'packed') THEN true
    WHEN OLD.status = 'accepted'        AND NEW.status IN ('picked_up', 'cancelled')                         THEN true
    WHEN OLD.status = 'picked_up'       AND NEW.status IN ('dispatched', 'cancelled')                        THEN true
    WHEN OLD.status = 'dispatched'      AND NEW.status IN ('delivered', 'cancelled')                         THEN true
    ELSE false
  END;

  IF NOT v_valid THEN
    RAISE EXCEPTION 'invalid_transition: % -> %', OLD.status, NEW.status
      USING HINT = format('Cannot move from %s to %s', OLD.status, NEW.status);
  END IF;

  INSERT INTO order_status_events (order_id, from_status, to_status, actor_id)
  VALUES (NEW.id, OLD.status, NEW.status, auth.uid());

  IF NEW.status = 'cancelled' THEN
    PERFORM restore_credit(NEW.id);

    FOR v_item IN
      SELECT product_id, qty
        FROM order_items
       WHERE order_id = NEW.id
    LOOP
      UPDATE products
         SET stock_quantity = stock_quantity + v_item.qty
       WHERE id = v_item.product_id;

      INSERT INTO stock_history (product_id, change, reason)
      VALUES (
        v_item.product_id,
        v_item.qty,
        'Cancelled order restore: ' || NEW.order_number
      );
    END LOOP;
  END IF;

  IF NEW.status = 'rejected' THEN
    PERFORM restore_credit(NEW.id);

    FOR v_item IN
      SELECT product_id, qty
        FROM order_items
       WHERE order_id = NEW.id
    LOOP
      UPDATE products
         SET stock_quantity = stock_quantity + v_item.qty
       WHERE id = v_item.product_id;

      INSERT INTO stock_history (product_id, change, reason)
      VALUES (
        v_item.product_id,
        v_item.qty,
        'Rejected order restore: ' || NEW.order_number
      );
    END LOOP;
  END IF;

  IF NEW.status = 'delivered' THEN
    v_points := FLOOR(NEW.grand_total / 100);
    IF v_points > 0 THEN
      INSERT INTO loyalty_transactions (retailer_id, order_id, points, reason)
      VALUES (NEW.user_id, NEW.id, v_points, 'order_delivered');

      UPDATE profiles
         SET loyalty_points = loyalty_points + v_points
       WHERE id = NEW.user_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Admin assign packed delivery orders to a driver
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assign_order_to_delivery(
  p_order_id uuid,
  p_delivery_profile_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_mode text;
  v_driver_role text;
BEGIN
  IF NOT (SELECT public.current_user_is_admin()) THEN
    RAISE EXCEPTION 'access_denied';
  END IF;

  SELECT status, fulfillment_mode
    INTO v_status, v_mode
    FROM public.orders
   WHERE id = p_order_id;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'order_not_found';
  END IF;

  IF COALESCE(v_mode, 'delivery') <> 'delivery' THEN
    RAISE EXCEPTION 'not_delivery_order';
  END IF;

  IF v_status NOT IN ('pending', 'approved', 'packed') THEN
    RAISE EXCEPTION 'invalid_status_for_assign'
      USING HINT = 'Assign only from pending, approved, or packed';
  END IF;

  SELECT role INTO v_driver_role
    FROM public.profiles
   WHERE id = p_delivery_profile_id;

  IF v_driver_role IS DISTINCT FROM 'delivery' THEN
    RAISE EXCEPTION 'invalid_delivery_profile';
  END IF;

  UPDATE public.orders
     SET status_before_assignment = v_status,
         assigned_to = p_delivery_profile_id,
         assigned_at = now(),
         assigned_by = auth.uid(),
         status = 'assigned'
   WHERE id = p_order_id;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_order_to_delivery(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_order_to_delivery(uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Driver accept / reject
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delivery_accept_order(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_assigned_to uuid;
  v_on_duty boolean;
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

  IF v_status <> 'assigned' THEN
    RAISE EXCEPTION 'invalid_status';
  END IF;

  SELECT is_on_duty INTO v_on_duty FROM public.profiles WHERE id = auth.uid();
  IF NOT COALESCE(v_on_duty, false) THEN
    RAISE EXCEPTION 'off_duty'
      USING HINT = 'Turn on duty before accepting orders';
  END IF;

  UPDATE public.orders
     SET status = 'accepted'
   WHERE id = p_order_id;
END;
$$;

REVOKE ALL ON FUNCTION public.delivery_accept_order(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delivery_accept_order(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.delivery_reject_order(
  p_order_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_assigned_to uuid;
  v_restore text;
BEGIN
  IF NOT (SELECT public.current_user_is_delivery()) THEN
    RAISE EXCEPTION 'access_denied';
  END IF;

  SELECT status, assigned_to, status_before_assignment
    INTO v_status, v_assigned_to, v_restore
    FROM public.orders
   WHERE id = p_order_id;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'order_not_found';
  END IF;

  IF v_assigned_to IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'access_denied';
  END IF;

  IF v_status <> 'assigned' THEN
    RAISE EXCEPTION 'invalid_status';
  END IF;

  v_restore := COALESCE(NULLIF(trim(v_restore), ''), 'packed');

  UPDATE public.orders
     SET status = v_restore,
         assigned_to = NULL,
         assigned_at = NULL,
         assigned_by = NULL,
         status_before_assignment = NULL,
         notes = CASE
           WHEN p_reason IS NOT NULL AND trim(p_reason) <> '' THEN
             COALESCE(notes, '') || E'\n[Driver declined: ' || trim(p_reason) || ']'
           ELSE notes
         END
   WHERE id = p_order_id;
END;
$$;

REVOKE ALL ON FUNCTION public.delivery_reject_order(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delivery_reject_order(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. batch_update_order_status — include accepted lifecycle
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.batch_update_order_status(
  p_order_ids  uuid[],
  p_new_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role       text;
  v_updated    uuid[] := '{}';
  v_failed     jsonb  := '[]'::jsonb;
  v_order_id   uuid;
  v_cur_status text;
  v_valid      boolean;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'delivery') THEN
    RAISE EXCEPTION 'access_denied' USING HINT = 'Only staff can batch-update order status';
  END IF;

  FOREACH v_order_id IN ARRAY p_order_ids
  LOOP
    SELECT status INTO v_cur_status FROM public.orders WHERE id = v_order_id;

    IF v_cur_status IS NULL THEN
      v_failed := v_failed || jsonb_build_object('id', v_order_id, 'reason', 'Order not found');
      CONTINUE;
    END IF;

    v_valid := false;
    IF p_new_status = 'cancelled' THEN
      IF v_cur_status NOT IN ('delivered', 'cancelled') THEN
        v_valid := true;
      END IF;
    ELSIF p_new_status = 'approved' AND v_cur_status IN ('pending', 'assigned') THEN
      v_valid := true;
    ELSIF p_new_status = 'packed' AND v_cur_status = 'approved' THEN
      v_valid := true;
    ELSIF p_new_status = 'picked_up' AND v_cur_status = 'accepted' THEN
      v_valid := true;
    ELSIF p_new_status = 'dispatched' AND v_cur_status IN ('packed', 'picked_up') THEN
      v_valid := true;
    ELSIF p_new_status = 'delivered' AND v_cur_status = 'dispatched' THEN
      v_valid := true;
    END IF;

    IF NOT v_valid THEN
      v_failed := v_failed || jsonb_build_object(
        'id', v_order_id,
        'reason', format('Cannot transition from %s to %s', v_cur_status, p_new_status)
      );
      CONTINUE;
    END IF;

    UPDATE public.orders SET status = p_new_status WHERE id = v_order_id;
    v_updated := array_append(v_updated, v_order_id);
  END LOOP;

  RETURN jsonb_build_object('updated', to_jsonb(v_updated), 'failed', v_failed);
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. driver_locations — admin-only live map data
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.driver_locations (
  profile_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  accuracy_m double precision,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_driver_locations_recorded_at
  ON public.driver_locations (recorded_at DESC);

ALTER TABLE public.driver_locations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "driver_locations_upsert_self" ON public.driver_locations;
CREATE POLICY "driver_locations_upsert_self" ON public.driver_locations
  FOR ALL TO authenticated
  USING (
    profile_id = (SELECT auth.uid())
    AND (SELECT public.current_user_is_delivery())
  )
  WITH CHECK (
    profile_id = (SELECT auth.uid())
    AND (SELECT public.current_user_is_delivery())
  );

DROP POLICY IF EXISTS "driver_locations_select_admin" ON public.driver_locations;
CREATE POLICY "driver_locations_select_admin" ON public.driver_locations
  FOR SELECT TO authenticated
  USING ((SELECT public.current_user_is_admin()));

-- ---------------------------------------------------------------------------
-- 7. List on-duty drivers (admin assign picker)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_delivery_staff(
  p_on_duty_only boolean DEFAULT true
)
RETURNS TABLE (
  id uuid,
  name text,
  phone text,
  is_on_duty boolean,
  current_order_count int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (SELECT public.current_user_is_admin()) THEN
    RAISE EXCEPTION 'access_denied';
  END IF;

  RETURN QUERY
    SELECT
      p.id,
      COALESCE(p.name, p.business_name, 'Delivery') AS name,
      p.phone,
      p.is_on_duty,
      p.current_order_count
    FROM public.profiles p
    WHERE p.role = 'delivery'
      AND (NOT p_on_duty_only OR p.is_on_duty = true)
    ORDER BY p.is_on_duty DESC, p.current_order_count ASC, name ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.list_delivery_staff(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_delivery_staff(boolean) TO authenticated;

COMMIT;
