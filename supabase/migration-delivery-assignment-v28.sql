-- =============================================================================
-- Thakkar Medico — V28: Delivery person assignment on orders
--
-- Run in: Supabase Dashboard → SQL Editor → New query → Run
-- Prerequisites: migration-stock-restore-on-cancel-v27.sql
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Assignment columns on orders
-- ---------------------------------------------------------------------------
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS assigned_to uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz,
  ADD COLUMN IF NOT EXISTS assigned_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_orders_assigned_to ON public.orders(assigned_to);

-- ---------------------------------------------------------------------------
-- 2. Status CHECK — include 'assigned'
-- ---------------------------------------------------------------------------
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_status_check;

ALTER TABLE public.orders
  ADD CONSTRAINT orders_status_check
  CHECK (status IN (
    'pending_payment',
    'pending',
    'assigned',
    'approved',
    'packed',
    'dispatched',
    'delivered',
    'cancelled'
  ));

-- ---------------------------------------------------------------------------
-- 3. Status transitions (extends v27 — stock restore on cancel unchanged)
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
    WHEN OLD.status = 'pending_payment' AND NEW.status IN ('pending', 'cancelled', 'assigned') THEN true
    WHEN OLD.status = 'pending'         AND NEW.status IN ('approved', 'cancelled', 'assigned') THEN true
    WHEN OLD.status = 'assigned'        AND NEW.status IN ('approved', 'cancelled')            THEN true
    WHEN OLD.status = 'approved'        AND NEW.status IN ('packed', 'cancelled')                THEN true
    WHEN OLD.status = 'packed'          AND NEW.status IN ('dispatched', 'cancelled')            THEN true
    WHEN OLD.status = 'dispatched'      AND NEW.status IN ('delivered', 'cancelled')             THEN true
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
-- 4. Role helpers for RLS
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_user_is_delivery()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND role = 'delivery'
  );
$$;

REVOKE ALL ON FUNCTION public.current_user_is_delivery() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_user_is_delivery() TO authenticated;

-- Only admins may change assignment columns
CREATE OR REPLACE FUNCTION public.enforce_order_assignment_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (
    OLD.assigned_to IS DISTINCT FROM NEW.assigned_to
    OR OLD.assigned_at IS DISTINCT FROM NEW.assigned_at
    OR OLD.assigned_by IS DISTINCT FROM NEW.assigned_by
  ) AND NOT (SELECT public.current_user_is_admin()) THEN
    RAISE EXCEPTION 'assignment_update_denied'
      USING HINT = 'Only admins can assign or reassign delivery staff';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_order_assignment_fields ON public.orders;
CREATE TRIGGER trg_enforce_order_assignment_fields
  BEFORE UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_order_assignment_fields();

-- ---------------------------------------------------------------------------
-- 5. RLS — delivery sees only orders assigned to them; admin sees all
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "orders_select" ON public.orders;
CREATE POLICY "orders_select" ON public.orders
  FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR (SELECT public.current_user_is_admin())
    OR (
      (SELECT public.current_user_is_delivery())
      AND assigned_to = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "orders_update" ON public.orders;
CREATE POLICY "orders_update" ON public.orders
  FOR UPDATE TO authenticated
  USING (
    (SELECT public.current_user_is_admin())
    OR (
      (SELECT public.current_user_is_delivery())
      AND assigned_to = (SELECT auth.uid())
    )
    OR (
      (SELECT auth.uid()) = user_id
      AND status = ANY (ARRAY['pending'::text, 'approved'::text])
    )
  )
  WITH CHECK (
    (SELECT public.current_user_is_admin())
    OR (
      (SELECT public.current_user_is_delivery())
      AND assigned_to = (SELECT auth.uid())
    )
    OR (
      (SELECT auth.uid()) = user_id
      AND status = ANY (ARRAY['pending'::text, 'approved'::text])
    )
  );

-- Explicit admin assignment policy (documents intent; permissive OR with orders_update)
DROP POLICY IF EXISTS "orders_assign_admin" ON public.orders;
CREATE POLICY "orders_assign_admin" ON public.orders
  FOR UPDATE TO authenticated
  USING ((SELECT public.current_user_is_admin()))
  WITH CHECK ((SELECT public.current_user_is_admin()));

-- ---------------------------------------------------------------------------
-- 6. SECURITY DEFINER RPCs must mirror assignment visibility for delivery
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_orders_page(
  p_role        text,
  p_user_id     uuid,
  p_status      text           DEFAULT NULL,
  p_cursor      timestamptz    DEFAULT NULL,
  p_cursor_id   uuid           DEFAULT NULL,
  p_page_size   int            DEFAULT 20,
  p_from_date   timestamptz    DEFAULT NULL,
  p_to_date     timestamptz    DEFAULT NULL,
  p_area        text           DEFAULT NULL
)
RETURNS SETOF public.orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
    SELECT o.*
      FROM public.orders o
      LEFT JOIN public.profiles prof ON prof.id = o.user_id
     WHERE
       (
         p_role = 'admin'
         OR (p_role = 'delivery' AND o.assigned_to = auth.uid())
         OR (p_role NOT IN ('admin', 'delivery') AND o.user_id = p_user_id)
       )
       AND (p_status IS NULL OR o.status = p_status)
       AND (p_from_date IS NULL OR o.created_at >= p_from_date)
       AND (p_to_date   IS NULL OR o.created_at <= p_to_date)
       AND (p_area IS NULL OR COALESCE(prof.area, 'Unassigned') = p_area)
       AND (
         p_cursor IS NULL
         OR (o.created_at, o.id) < (p_cursor, p_cursor_id)
       )
     ORDER BY o.created_at DESC, o.id DESC
     LIMIT p_page_size;
END;
$$;

REVOKE ALL ON FUNCTION public.get_orders_page(text, uuid, text, timestamptz, uuid, int, timestamptz, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_orders_page(text, uuid, text, timestamptz, uuid, int, timestamptz, timestamptz, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_delivery_summary(
  p_date date DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  area           text,
  pending_count  int,
  approved_count int,
  total_orders   int,
  retailer_names text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'delivery') THEN
    RAISE EXCEPTION 'access_denied' USING HINT = 'Only staff can access delivery summary';
  END IF;

  RETURN QUERY
    SELECT
      COALESCE(p.area, 'Unassigned') AS area,
      COUNT(*) FILTER (WHERE o.status IN ('pending', 'assigned'))::int AS pending_count,
      COUNT(*) FILTER (WHERE o.status IN ('approved', 'packed'))::int AS approved_count,
      COUNT(*)::int AS total_orders,
      ARRAY_AGG(DISTINCT COALESCE(p.name, p.business_name, 'Unknown')) AS retailer_names
    FROM public.orders o
    JOIN public.profiles p ON p.id = o.user_id
    WHERE o.fulfillment_mode = 'delivery'
      AND o.status IN ('pending', 'assigned', 'approved', 'packed')
      AND DATE(o.created_at) = p_date
      AND (v_role = 'admin' OR o.assigned_to = auth.uid())
    GROUP BY COALESCE(p.area, 'Unassigned')
    ORDER BY total_orders DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_delivery_summary(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_delivery_summary(date) TO authenticated;

-- Batch approve: pending (legacy) or assigned
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
    ELSIF p_new_status = 'dispatched' AND v_cur_status = 'packed' THEN
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

REVOKE ALL ON FUNCTION public.batch_update_order_status(uuid[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.batch_update_order_status(uuid[], text) TO authenticated;

COMMIT;
