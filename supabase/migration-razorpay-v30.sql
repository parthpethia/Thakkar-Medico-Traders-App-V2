-- =============================================================================
-- Thakkar Medico — V30: Razorpay UPI payments
--
-- Run in: Supabase Dashboard → SQL Editor → New query → Run
-- Prerequisites: migration-otp-pod-v29.sql
--
-- Razorpay order creation runs in Edge Function create-razorpay-order
-- (Postgres cannot call Razorpay REST API without pg_net). Set secrets:
--   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Status CHECK — include payment_failed
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
    'picked_up',
    'dispatched',
    'delivered',
    'cancelled',
    'payment_failed'
  ));

-- ---------------------------------------------------------------------------
-- 2. Razorpay payment columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS razorpay_order_id text,
  ADD COLUMN IF NOT EXISTS razorpay_payment_id text,
  ADD COLUMN IF NOT EXISTS payment_captured_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS orders_razorpay_order_id_key
  ON public.orders (razorpay_order_id)
  WHERE razorpay_order_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Status transitions (extends v28)
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
    WHEN OLD.status = 'pending'         AND NEW.status IN ('approved', 'cancelled', 'assigned')             THEN true
    WHEN OLD.status = 'assigned'        AND NEW.status IN ('approved', 'cancelled')                         THEN true
    WHEN OLD.status = 'approved'        AND NEW.status IN ('packed', 'cancelled')                           THEN true
    WHEN OLD.status = 'packed'          AND NEW.status IN ('dispatched', 'cancelled')                       THEN true
    WHEN OLD.status = 'dispatched'      AND NEW.status IN ('delivered', 'cancelled')                        THEN true
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

COMMIT;
