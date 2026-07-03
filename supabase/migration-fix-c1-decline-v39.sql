-- =============================================================================
-- Thakkar Medico — V39: Fix C1 — driver decline from pending / approved
--
-- Bug: assign_order_to_delivery allows assignment from pending, approved, or
-- packed, saving the source status in status_before_assignment. When a driver
-- declines, delivery_reject_order restores the order to that saved status.
-- But enforce_order_status_transition only allowed assigned → packed (plus
-- accepted / cancelled / rejected). assigned → pending and assigned → approved
-- were missing, so decline raised "invalid_transition" for orders that were
-- assigned directly from pending or approved.
--
-- Fix: add 'pending' and 'approved' to the assigned WHEN clause.
-- Everything else in the function body is unchanged from V37.
--
-- Run in: Supabase Dashboard → SQL Editor → New query → Run
-- Prerequisites: migration-search-products-update-v38.sql (or latest applied)
-- =============================================================================

BEGIN;

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
    -- FIX C1: added 'pending' and 'approved' so driver decline can restore the
    -- original status_before_assignment (which may be pending or approved, not
    -- only packed).
    WHEN OLD.status = 'assigned'        AND NEW.status IN ('accepted', 'cancelled', 'rejected', 'packed', 'pending', 'approved') THEN true
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

COMMIT;
