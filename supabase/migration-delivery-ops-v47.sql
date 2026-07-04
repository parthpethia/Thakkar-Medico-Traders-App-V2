-- =============================================================================
-- Thakkar Medico — V47: Delivery Operations (Phase 1)
--
-- Adds:
--   1. delivery_failed order status + delivery_failure_reason column
--   2. Updated enforce_order_status_transition with new transitions
--   3. delivery_report_failed RPC (driver)
--   4. admin_reschedule_failed_order RPC (admin)
--   5. order_item_removals table (packing unavailability audit)
--   6. items_adjusted / adjustment columns on orders
--   7. admin_remove_order_items RPC
--   8. retailer_respond_to_adjustment RPC
--   9. returns table (doorstep rejection / damage)
--  10. report_return_items RPC
--  11. admin_resolve_return RPC
--  12. delivery_proofs photo columns
--
-- Prerequisites: All migrations through v46 must have been applied.
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION 1: delivery_failed status + delivery_failure_reason
-- =============================================================================

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS delivery_failure_reason text;

-- Update status CHECK to include 'delivery_failed'
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
    'rejected',
    'delivery_failed'
  ));


-- =============================================================================
-- SECTION 2: Updated enforce_order_status_transition
-- =============================================================================
-- Adds: dispatched → delivery_failed
--        delivery_failed → assigned | cancelled

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
  v_alloc       jsonb;
  v_batch_id    uuid;
  v_alloc_qty   integer;
BEGIN
  -- Skip if status hasn't changed
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  -- Valid transitions
  v_valid := CASE
    WHEN OLD.status = 'pending_payment' AND NEW.status IN ('pending', 'cancelled', 'assigned', 'payment_failed') THEN true
    WHEN OLD.status = 'payment_failed'  AND NEW.status IN ('pending_payment', 'cancelled', 'pending')           THEN true
    WHEN OLD.status = 'pending'         AND NEW.status IN ('approved', 'cancelled', 'assigned', 'rejected')     THEN true
    WHEN OLD.status = 'approved'        AND NEW.status IN ('packed', 'cancelled', 'assigned')                   THEN true
    WHEN OLD.status = 'packed'          AND NEW.status IN ('dispatched', 'cancelled', 'assigned')               THEN true
    WHEN OLD.status = 'assigned'        AND NEW.status IN ('accepted', 'cancelled', 'rejected', 'packed', 'pending', 'approved') THEN true
    WHEN OLD.status = 'accepted'        AND NEW.status IN ('picked_up', 'cancelled')                            THEN true
    WHEN OLD.status = 'picked_up'       AND NEW.status IN ('dispatched', 'cancelled')                           THEN true
    WHEN OLD.status = 'dispatched'      AND NEW.status IN ('delivered', 'cancelled', 'delivery_failed')         THEN true
    WHEN OLD.status = 'delivery_failed' AND NEW.status IN ('assigned', 'cancelled')                             THEN true
    ELSE false
  END;

  IF NOT v_valid THEN
    RAISE EXCEPTION 'invalid_transition: % -> %', OLD.status, NEW.status
      USING HINT = format('Cannot move from %s to %s', OLD.status, NEW.status);
  END IF;

  -- Log the transition
  INSERT INTO order_status_events (order_id, from_status, to_status, actor_id)
  VALUES (NEW.id, OLD.status, NEW.status, auth.uid());

  -- -----------------------------------------------------------------------
  -- Cancellation: restore credit + restore stock to BATCHES
  -- -----------------------------------------------------------------------
  IF NEW.status = 'cancelled' THEN
    PERFORM restore_credit(NEW.id);

    FOR v_item IN
      SELECT product_id, qty, batch_allocations
        FROM order_items
       WHERE order_id = NEW.id
    LOOP
      IF v_item.batch_allocations IS NOT NULL AND jsonb_array_length(v_item.batch_allocations) > 0 THEN
        FOR v_alloc IN SELECT * FROM jsonb_array_elements(v_item.batch_allocations)
        LOOP
          v_batch_id  := (v_alloc ->> 'batch_id')::uuid;
          v_alloc_qty := (v_alloc ->> 'qty')::integer;

          UPDATE product_batches
             SET quantity = quantity + v_alloc_qty
           WHERE id = v_batch_id;
        END LOOP;
      ELSE
        UPDATE product_batches
           SET quantity = quantity + v_item.qty
         WHERE id = (
           SELECT id FROM product_batches
            WHERE product_id = v_item.product_id
              AND is_active = true
            ORDER BY
              CASE WHEN batch_number = 'LEGACY' THEN 0 ELSE 1 END,
              created_at ASC
            LIMIT 1
         );

        IF NOT FOUND THEN
          INSERT INTO product_batches (product_id, batch_number, quantity)
          VALUES (v_item.product_id, 'LEGACY', v_item.qty);
        END IF;
      END IF;

      INSERT INTO stock_history (product_id, change, reason)
      VALUES (
        v_item.product_id,
        v_item.qty,
        'Cancelled order restore: ' || NEW.order_number
      );
    END LOOP;
  END IF;

  -- -----------------------------------------------------------------------
  -- Rejection: same batch-aware restore logic
  -- -----------------------------------------------------------------------
  IF NEW.status = 'rejected' THEN
    PERFORM restore_credit(NEW.id);

    FOR v_item IN
      SELECT product_id, qty, batch_allocations
        FROM order_items
       WHERE order_id = NEW.id
    LOOP
      IF v_item.batch_allocations IS NOT NULL AND jsonb_array_length(v_item.batch_allocations) > 0 THEN
        FOR v_alloc IN SELECT * FROM jsonb_array_elements(v_item.batch_allocations)
        LOOP
          v_batch_id  := (v_alloc ->> 'batch_id')::uuid;
          v_alloc_qty := (v_alloc ->> 'qty')::integer;

          UPDATE product_batches
             SET quantity = quantity + v_alloc_qty
           WHERE id = v_batch_id;
        END LOOP;
      ELSE
        UPDATE product_batches
           SET quantity = quantity + v_item.qty
         WHERE id = (
           SELECT id FROM product_batches
            WHERE product_id = v_item.product_id
              AND is_active = true
            ORDER BY
              CASE WHEN batch_number = 'LEGACY' THEN 0 ELSE 1 END,
              created_at ASC
            LIMIT 1
         );

        IF NOT FOUND THEN
          INSERT INTO product_batches (product_id, batch_number, quantity)
          VALUES (v_item.product_id, 'LEGACY', v_item.qty);
        END IF;
      END IF;

      INSERT INTO stock_history (product_id, change, reason)
      VALUES (
        v_item.product_id,
        v_item.qty,
        'Rejected order restore: ' || NEW.order_number
      );
    END LOOP;
  END IF;

  -- -----------------------------------------------------------------------
  -- Delivered: accrue loyalty points
  -- -----------------------------------------------------------------------
  IF NEW.status = 'delivered' THEN
    v_points := FLOOR(NEW.grand_total / 100);
    IF v_points > 0 THEN
      INSERT INTO loyalty_transactions (retailer_id, order_id, points, reason, type)
      VALUES (NEW.user_id, NEW.id, v_points, 'order_delivered', 'earned');

      UPDATE profiles
         SET loyalty_points = loyalty_points + v_points
       WHERE id = NEW.user_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


-- =============================================================================
-- SECTION 3: delivery_report_failed RPC
-- =============================================================================

CREATE OR REPLACE FUNCTION public.delivery_report_failed(
  p_order_id uuid,
  p_reason   text
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
  -- Only delivery drivers can call this
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

  -- Must be assigned to this driver
  IF v_assigned_to IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'access_denied';
  END IF;

  -- Must be in dispatched status
  IF v_status <> 'dispatched' THEN
    RAISE EXCEPTION 'invalid_status'
      USING HINT = format('Order must be dispatched to report failure, currently %s', v_status);
  END IF;

  -- Validate reason
  IF p_reason IS NULL OR p_reason NOT IN ('shop_closed', 'retailer_unreachable', 'wrong_address', 'other') THEN
    RAISE EXCEPTION 'invalid_reason'
      USING HINT = 'Reason must be one of: shop_closed, retailer_unreachable, wrong_address, other';
  END IF;

  -- Transition to delivery_failed
  UPDATE public.orders
     SET status = 'delivery_failed',
         delivery_failure_reason = p_reason
   WHERE id = p_order_id;
END;
$$;

REVOKE ALL ON FUNCTION public.delivery_report_failed(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delivery_report_failed(uuid, text) TO authenticated;


-- =============================================================================
-- SECTION 4: admin_reschedule_failed_order RPC
-- =============================================================================

CREATE OR REPLACE FUNCTION public.admin_reschedule_failed_order(
  p_order_id            uuid,
  p_delivery_profile_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status      text;
  v_driver_role text;
BEGIN
  IF NOT (SELECT public.current_user_is_admin()) THEN
    RAISE EXCEPTION 'access_denied';
  END IF;

  SELECT status INTO v_status
    FROM public.orders
   WHERE id = p_order_id;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'order_not_found';
  END IF;

  IF v_status <> 'delivery_failed' THEN
    RAISE EXCEPTION 'invalid_status'
      USING HINT = format('Order must be delivery_failed to reschedule, currently %s', v_status);
  END IF;

  -- Validate the target driver
  SELECT role INTO v_driver_role
    FROM public.profiles
   WHERE id = p_delivery_profile_id;

  IF v_driver_role IS DISTINCT FROM 'delivery' THEN
    RAISE EXCEPTION 'invalid_delivery_profile';
  END IF;

  -- Reschedule: assign to driver, keep stock allocated
  UPDATE public.orders
     SET status_before_assignment = 'delivery_failed',
         assigned_to = p_delivery_profile_id,
         assigned_at = now(),
         assigned_by = auth.uid(),
         status = 'assigned',
         delivery_failure_reason = NULL
   WHERE id = p_order_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_reschedule_failed_order(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_reschedule_failed_order(uuid, uuid) TO authenticated;


-- =============================================================================
-- SECTION 5: order_item_removals table
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.order_item_removals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES public.products(id),
  original_qty integer NOT NULL,
  reason       text NOT NULL DEFAULT 'unavailable',
  removed_by   uuid REFERENCES public.profiles(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_item_removals_order_id
  ON public.order_item_removals (order_id);

CREATE INDEX IF NOT EXISTS idx_order_item_removals_product_id
  ON public.order_item_removals (product_id);

ALTER TABLE public.order_item_removals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "order_item_removals_select_admin" ON public.order_item_removals;
CREATE POLICY "order_item_removals_select_admin" ON public.order_item_removals
  FOR SELECT TO authenticated
  USING ((SELECT public.current_user_is_admin()));

DROP POLICY IF EXISTS "order_item_removals_select_own" ON public.order_item_removals;
CREATE POLICY "order_item_removals_select_own" ON public.order_item_removals
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_item_removals.order_id
        AND o.user_id = (SELECT auth.uid())
    )
  );


-- =============================================================================
-- SECTION 6: Adjustment columns on orders
-- =============================================================================

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS items_adjusted boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS adjustment_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS original_grand_total numeric;


-- =============================================================================
-- SECTION 7: admin_remove_order_items RPC
-- =============================================================================

CREATE OR REPLACE FUNCTION public.admin_remove_order_items(
  p_order_id          uuid,
  p_removed_product_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order           RECORD;
  v_item            RECORD;
  v_alloc           jsonb;
  v_batch_id        uuid;
  v_alloc_qty       integer;
  v_product_id      uuid;
  v_gst_enabled     boolean;
  v_new_subtotal    numeric := 0;
  v_new_gst         numeric := 0;
  v_new_grand_total numeric := 0;
  v_remaining_item  RECORD;
  v_removed_names   text[] := '{}';
  v_product_name    text;
  v_old_grand_total numeric;
  v_credit_diff     numeric;
BEGIN
  -- Admin only
  IF NOT (SELECT public.current_user_is_admin()) THEN
    RAISE EXCEPTION 'access_denied';
  END IF;

  -- Fetch order
  SELECT id, order_number, status, grand_total, payment_mode, user_id,
         items_adjusted, original_grand_total
    INTO v_order
    FROM public.orders
   WHERE id = p_order_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_not_found';
  END IF;

  -- Only allow removal before dispatch
  IF v_order.status NOT IN ('pending', 'approved', 'packed', 'assigned', 'accepted') THEN
    RAISE EXCEPTION 'invalid_status'
      USING HINT = format('Cannot remove items from order in %s status', v_order.status);
  END IF;

  -- Must have items to remove
  IF array_length(p_removed_product_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'no_items_specified';
  END IF;

  -- Save original grand total on first adjustment
  v_old_grand_total := COALESCE(v_order.original_grand_total, v_order.grand_total);

  -- Settings
  SELECT COALESCE(s.gst_enabled, true)
    INTO v_gst_enabled
    FROM settings s LIMIT 1;

  -- Process each removed product
  FOREACH v_product_id IN ARRAY p_removed_product_ids
  LOOP
    -- Find the order_item
    SELECT oi.product_id, oi.qty, oi.batch_allocations
      INTO v_item
      FROM order_items oi
     WHERE oi.order_id = p_order_id
       AND oi.product_id = v_product_id;

    IF NOT FOUND THEN
      CONTINUE;  -- Skip if product not in this order
    END IF;

    -- Get product name for notification
    SELECT name INTO v_product_name FROM products WHERE id = v_product_id;
    v_removed_names := array_append(v_removed_names, COALESCE(v_product_name, 'Unknown'));

    -- Log the removal for analytics
    INSERT INTO order_item_removals (order_id, product_id, original_qty, reason, removed_by)
    VALUES (p_order_id, v_product_id, v_item.qty, 'unavailable', auth.uid());

    -- Restore batch allocations
    IF v_item.batch_allocations IS NOT NULL AND jsonb_array_length(v_item.batch_allocations) > 0 THEN
      FOR v_alloc IN SELECT * FROM jsonb_array_elements(v_item.batch_allocations)
      LOOP
        v_batch_id  := (v_alloc ->> 'batch_id')::uuid;
        v_alloc_qty := (v_alloc ->> 'qty')::integer;

        UPDATE product_batches
           SET quantity = quantity + v_alloc_qty
         WHERE id = v_batch_id;
      END LOOP;
    ELSE
      -- Pre-v43 fallback
      UPDATE product_batches
         SET quantity = quantity + v_item.qty
       WHERE id = (
         SELECT id FROM product_batches
          WHERE product_id = v_item.product_id
            AND is_active = true
          ORDER BY
            CASE WHEN batch_number = 'LEGACY' THEN 0 ELSE 1 END,
            created_at ASC
          LIMIT 1
       );

      IF NOT FOUND THEN
        INSERT INTO product_batches (product_id, batch_number, quantity)
        VALUES (v_item.product_id, 'LEGACY', v_item.qty);
      END IF;
    END IF;

    -- Stock history
    INSERT INTO stock_history (product_id, change, reason)
    VALUES (v_product_id, v_item.qty, 'Item removed from order: ' || v_order.order_number);

    -- Delete the order_item
    DELETE FROM order_items WHERE order_id = p_order_id AND product_id = v_product_id;
  END LOOP;

  -- Check at least one item remains
  IF NOT EXISTS (SELECT 1 FROM order_items WHERE order_id = p_order_id) THEN
    RAISE EXCEPTION 'cannot_remove_all_items'
      USING HINT = 'At least one item must remain. Cancel the order instead.';
  END IF;

  -- Recompute totals from remaining order_items
  FOR v_remaining_item IN
    SELECT unit_price, qty, gst_percent
      FROM order_items
     WHERE order_id = p_order_id
  LOOP
    v_new_subtotal := v_new_subtotal + ROUND(v_remaining_item.unit_price * v_remaining_item.qty, 2);
    IF v_gst_enabled THEN
      v_new_gst := v_new_gst + ROUND(
        (v_remaining_item.unit_price * v_remaining_item.qty * v_remaining_item.gst_percent) / 100, 2
      );
    END IF;
  END LOOP;

  v_new_grand_total := v_new_subtotal + v_new_gst;

  -- If credit order, adjust credit_used by the difference
  IF v_order.payment_mode = 'credit' THEN
    v_credit_diff := v_order.grand_total - v_new_grand_total;
    IF v_credit_diff > 0 THEN
      UPDATE profiles
         SET credit_used = GREATEST(credit_used - v_credit_diff, 0)
       WHERE id = v_order.user_id;
    END IF;
  END IF;

  -- Update order totals and mark as adjusted
  UPDATE public.orders
     SET subtotal = v_new_subtotal,
         gst = v_new_gst,
         grand_total = v_new_grand_total,
         items_adjusted = true,
         original_grand_total = v_old_grand_total,
         adjustment_accepted_at = NULL
   WHERE id = p_order_id;

  -- Update the items JSONB snapshot to match remaining order_items
  UPDATE public.orders
     SET items = (
       SELECT COALESCE(jsonb_agg(
         jsonb_build_object(
           'product_id', oi.product_id,
           'qty', oi.qty,
           'units_per_level', 1
         )
       ), '[]'::jsonb)
       FROM order_items oi
       WHERE oi.order_id = p_order_id
     )
   WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'order_id', p_order_id,
    'new_subtotal', v_new_subtotal,
    'new_gst', v_new_gst,
    'new_grand_total', v_new_grand_total,
    'original_grand_total', v_old_grand_total,
    'removed_items', to_jsonb(v_removed_names)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_remove_order_items(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_remove_order_items(uuid, uuid[]) TO authenticated;


-- =============================================================================
-- SECTION 8: retailer_respond_to_adjustment RPC
-- =============================================================================

CREATE OR REPLACE FUNCTION public.retailer_respond_to_adjustment(
  p_order_id uuid,
  p_accept   boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order RECORD;
BEGIN
  SELECT id, user_id, items_adjusted, adjustment_accepted_at, status
    INTO v_order
    FROM public.orders
   WHERE id = p_order_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_not_found';
  END IF;

  -- Must be the order owner
  IF v_order.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'access_denied';
  END IF;

  -- Must have been adjusted and not yet responded to
  IF NOT COALESCE(v_order.items_adjusted, false) THEN
    RAISE EXCEPTION 'not_adjusted'
      USING HINT = 'This order has not been adjusted';
  END IF;

  IF v_order.adjustment_accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'already_responded'
      USING HINT = 'You have already responded to this adjustment';
  END IF;

  IF p_accept THEN
    -- Accept: mark as accepted, order continues in pipeline
    UPDATE public.orders
       SET adjustment_accepted_at = now()
     WHERE id = p_order_id;
  ELSE
    -- Decline: cancel the order (triggers stock restore + credit restore via trigger)
    UPDATE public.orders
       SET status = 'cancelled',
           cancellation_reason = 'Retailer declined item adjustment'
     WHERE id = p_order_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.retailer_respond_to_adjustment(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.retailer_respond_to_adjustment(uuid, boolean) TO authenticated;


-- =============================================================================
-- SECTION 9: returns table
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.returns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  product_id      uuid NOT NULL REFERENCES public.products(id),
  quantity        integer NOT NULL CHECK (quantity > 0),
  reason          text NOT NULL CHECK (reason IN ('damaged', 'wrong_item', 'rejected', 'expired', 'other')),
  reason_detail   text,
  reported_by     uuid REFERENCES public.profiles(id),
  reported_at     timestamptz NOT NULL DEFAULT now(),
  resolution      text DEFAULT 'pending' CHECK (resolution IN ('refund', 'replace', 'credit_note', 'pending')),
  resolution_notes text,
  resolved_by     uuid REFERENCES public.profiles(id),
  resolved_at     timestamptz,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'disputed')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_returns_order_id ON public.returns(order_id);
CREATE INDEX IF NOT EXISTS idx_returns_status ON public.returns(status);
CREATE INDEX IF NOT EXISTS idx_returns_product_id ON public.returns(product_id);

ALTER TABLE public.returns ENABLE ROW LEVEL SECURITY;

-- Admin can read/write all returns
DROP POLICY IF EXISTS "returns_admin_all" ON public.returns;
CREATE POLICY "returns_admin_all" ON public.returns
  FOR ALL TO authenticated
  USING ((SELECT public.current_user_is_admin()));

-- Delivery driver can read returns for orders assigned to them
DROP POLICY IF EXISTS "returns_select_delivery" ON public.returns;
CREATE POLICY "returns_select_delivery" ON public.returns
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = returns.order_id
        AND o.assigned_to = (SELECT auth.uid())
    )
  );

-- Retailer can read returns for their orders
DROP POLICY IF EXISTS "returns_select_own" ON public.returns;
CREATE POLICY "returns_select_own" ON public.returns
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = returns.order_id
        AND o.user_id = (SELECT auth.uid())
    )
  );


-- =============================================================================
-- SECTION 10: report_return_items RPC
-- =============================================================================

CREATE OR REPLACE FUNCTION public.report_return_items(
  p_order_id uuid,
  p_items    jsonb   -- [{"product_id": uuid, "quantity": int, "reason": text, "reason_detail"?: text}]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order       RECORD;
  v_caller_id   uuid := auth.uid();
  v_caller_role text;
  v_item        jsonb;
  v_product_id  uuid;
  v_quantity    integer;
  v_reason      text;
  v_detail      text;
  v_return_ids  uuid[] := '{}';
  v_return_id   uuid;
  v_order_item_qty integer;
BEGIN
  -- Fetch caller role
  SELECT role INTO v_caller_role FROM profiles WHERE id = v_caller_id;

  -- Fetch order
  SELECT id, user_id, assigned_to, status
    INTO v_order
    FROM public.orders
   WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_not_found';
  END IF;

  -- Authorization: must be assigned driver OR order owner
  IF v_caller_role = 'delivery' THEN
    IF v_order.assigned_to IS DISTINCT FROM v_caller_id THEN
      RAISE EXCEPTION 'access_denied';
    END IF;
  ELSIF v_caller_role = 'retailer' THEN
    IF v_order.user_id IS DISTINCT FROM v_caller_id THEN
      RAISE EXCEPTION 'access_denied';
    END IF;
  ELSIF v_caller_role <> 'admin' THEN
    RAISE EXCEPTION 'access_denied';
  END IF;

  -- Status must be dispatched or delivered
  IF v_order.status NOT IN ('dispatched', 'delivered') THEN
    RAISE EXCEPTION 'invalid_status'
      USING HINT = format('Can only report returns for dispatched or delivered orders, currently %s', v_order.status);
  END IF;

  -- Validate items array
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'no_items_specified';
  END IF;

  -- Process each return item
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (v_item ->> 'product_id')::uuid;
    v_quantity   := (v_item ->> 'quantity')::integer;
    v_reason     := v_item ->> 'reason';
    v_detail     := v_item ->> 'reason_detail';

    -- Validate reason
    IF v_reason NOT IN ('damaged', 'wrong_item', 'rejected', 'expired', 'other') THEN
      RAISE EXCEPTION 'invalid_reason'
        USING HINT = format('Invalid reason: %s', v_reason);
    END IF;

    -- Validate product is in this order
    SELECT qty INTO v_order_item_qty
      FROM order_items
     WHERE order_id = p_order_id
       AND product_id = v_product_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'product_not_in_order'
        USING HINT = format('Product %s is not in this order', v_product_id);
    END IF;

    -- Validate quantity
    IF v_quantity IS NULL OR v_quantity <= 0 OR v_quantity > v_order_item_qty THEN
      RAISE EXCEPTION 'invalid_quantity'
        USING HINT = format('Return quantity must be between 1 and %s', v_order_item_qty);
    END IF;

    -- Insert return record
    v_return_id := gen_random_uuid();
    INSERT INTO public.returns (
      id, order_id, product_id, quantity, reason, reason_detail, reported_by
    ) VALUES (
      v_return_id, p_order_id, v_product_id, v_quantity, v_reason, v_detail, v_caller_id
    );

    v_return_ids := array_append(v_return_ids, v_return_id);
  END LOOP;

  RETURN jsonb_build_object(
    'return_ids', to_jsonb(v_return_ids),
    'count', array_length(v_return_ids, 1)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.report_return_items(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.report_return_items(uuid, jsonb) TO authenticated;


-- =============================================================================
-- SECTION 11: admin_resolve_return RPC
-- =============================================================================

CREATE OR REPLACE FUNCTION public.admin_resolve_return(
  p_return_id  uuid,
  p_resolution text,
  p_notes      text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (SELECT public.current_user_is_admin()) THEN
    RAISE EXCEPTION 'access_denied';
  END IF;

  IF p_resolution NOT IN ('refund', 'replace', 'credit_note') THEN
    RAISE EXCEPTION 'invalid_resolution'
      USING HINT = 'Resolution must be one of: refund, replace, credit_note';
  END IF;

  UPDATE public.returns
     SET resolution = p_resolution,
         resolution_notes = p_notes,
         resolved_by = auth.uid(),
         resolved_at = now(),
         status = 'resolved'
   WHERE id = p_return_id
     AND status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_not_found_or_already_resolved';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_resolve_return(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_resolve_return(uuid, text, text) TO authenticated;


-- =============================================================================
-- SECTION 12: delivery_proofs photo columns
-- =============================================================================

ALTER TABLE public.delivery_proofs
  ADD COLUMN IF NOT EXISTS photo_url text,
  ADD COLUMN IF NOT EXISTS photo_uploaded_at timestamptz;


-- =============================================================================
-- SECTION 13: Storage bucket for delivery photos (manual step note)
-- =============================================================================
-- NOTE: Supabase Storage buckets cannot be created via SQL migrations.
-- You must create the 'delivery-photos' bucket manually in the Supabase dashboard:
--   Storage → New bucket → Name: "delivery-photos" → Public: No
--
-- Then add these storage policies in the dashboard:
--   1. INSERT policy for delivery drivers: ((bucket_id = 'delivery-photos'::text))
--   2. SELECT policy for admin: ((bucket_id = 'delivery-photos'::text))
--   3. SELECT policy for order owners: via RPC or edge function


COMMIT;
