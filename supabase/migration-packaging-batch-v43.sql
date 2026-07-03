-- =============================================================================
-- Thakkar Medico — V43: Product Packaging Levels + Batch/Expiry Tracking
--
-- Adds:
--   A. product_packaging_levels — multi-level packaging (strip, box, case, etc.)
--   B. product_batches — batch/expiry tracking with cost_price (internal only)
--   C. Trigger to derive products.stock_quantity from SUM(product_batches.quantity)
--   D. LEGACY backfill — migrate existing stock_quantity into a LEGACY batch
--   E. batch_allocations on order_items, rewrite place_order (9-arg, FEFO),
--      fix enforce_order_status_transition cancel/reject to restore batches
--
-- Run in: Supabase Dashboard → SQL Editor → New query → Run (STAGING ONLY)
-- Prerequisites: All migrations through v42 must have been applied
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION A: product_packaging_levels
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.product_packaging_levels (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id     uuid        NOT NULL REFERENCES public.products (id) ON DELETE CASCADE,
  level_name     text        NOT NULL,          -- e.g. 'strip', 'box', 'case'
  units_per_level integer    NOT NULL DEFAULT 1 CHECK (units_per_level > 0),
  is_base        boolean     NOT NULL DEFAULT false,
  min_order_qty  integer     NOT NULL DEFAULT 1 CHECK (min_order_qty >= 1),
  increment_step integer     NOT NULL DEFAULT 1 CHECK (increment_step >= 1),
  display_order  integer     NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Each product may only have one base packaging level
CREATE UNIQUE INDEX IF NOT EXISTS idx_packaging_one_base_per_product
  ON public.product_packaging_levels (product_id) WHERE is_base = true;

-- Each (product, level_name) must be unique
CREATE UNIQUE INDEX IF NOT EXISTS idx_packaging_product_level_name
  ON public.product_packaging_levels (product_id, level_name);

-- Lookup index
CREATE INDEX IF NOT EXISTS idx_packaging_product_id
  ON public.product_packaging_levels (product_id);

-- RLS
ALTER TABLE public.product_packaging_levels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "packaging_levels_select" ON public.product_packaging_levels;
CREATE POLICY "packaging_levels_select" ON public.product_packaging_levels
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "packaging_levels_admin_write" ON public.product_packaging_levels;
CREATE POLICY "packaging_levels_admin_write" ON public.product_packaging_levels
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );


-- =============================================================================
-- SECTION B: product_batches
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.product_batches (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id   uuid        NOT NULL REFERENCES public.products (id) ON DELETE CASCADE,
  batch_number text        NOT NULL DEFAULT 'LEGACY',
  expiry_date  date,                          -- NULL for LEGACY batches
  cost_price   numeric,                       -- internal only, never exposed to retailers
  quantity     integer     NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  is_active    boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_batches_product_active
  ON public.product_batches (product_id, is_active);

CREATE INDEX IF NOT EXISTS idx_batches_product_expiry
  ON public.product_batches (product_id, expiry_date ASC NULLS LAST);

CREATE UNIQUE INDEX IF NOT EXISTS idx_batches_product_batch_number
  ON public.product_batches (product_id, batch_number);

-- RLS
ALTER TABLE public.product_batches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "batches_select" ON public.product_batches;
CREATE POLICY "batches_select" ON public.product_batches
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "batches_admin_write" ON public.product_batches;
CREATE POLICY "batches_admin_write" ON public.product_batches
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.batches_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_batches_updated_at ON public.product_batches;
CREATE TRIGGER trg_batches_updated_at
  BEFORE UPDATE ON public.product_batches
  FOR EACH ROW
  EXECUTE FUNCTION public.batches_set_updated_at();


-- =============================================================================
-- SECTION C: Trigger — products.stock_quantity derived from product_batches
-- =============================================================================

CREATE OR REPLACE FUNCTION public.sync_product_stock_from_batches()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product_id uuid;
BEGIN
  -- Determine which product was affected
  v_product_id := COALESCE(NEW.product_id, OLD.product_id);

  UPDATE products
     SET stock_quantity = COALESCE((
           SELECT SUM(quantity)
             FROM product_batches
            WHERE product_id = v_product_id
              AND is_active = true
         ), 0)
   WHERE id = v_product_id;

  RETURN NULL;  -- AFTER trigger, return value is ignored
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_stock_from_batches ON public.product_batches;
CREATE TRIGGER trg_sync_stock_from_batches
  AFTER INSERT OR UPDATE OR DELETE ON public.product_batches
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_product_stock_from_batches();


-- =============================================================================
-- SECTION D: LEGACY backfill
-- =============================================================================
-- For every product with stock_quantity > 0 that has no batches yet,
-- create a single LEGACY batch so the trigger-derived stock stays correct.

INSERT INTO public.product_batches (product_id, batch_number, quantity)
SELECT p.id, 'LEGACY', p.stock_quantity
  FROM public.products p
 WHERE p.stock_quantity > 0
   AND NOT EXISTS (
     SELECT 1 FROM public.product_batches pb WHERE pb.product_id = p.id
   );


-- =============================================================================
-- SECTION E: batch_allocations on order_items, rewrite place_order (9-arg),
--            fix enforce_order_status_transition
-- =============================================================================

-- E1. Add batch_allocations column to order_items
ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS batch_allocations jsonb;

COMMENT ON COLUMN public.order_items.batch_allocations IS
  'Array of {"batch_id": uuid, "qty": int} — records which batches were drawn from. NULL for pre-v43 orders.';


-- ---------------------------------------------------------------------------
-- E2. Drop old place_order (8-arg) and create new 9-arg version
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.place_order(uuid, jsonb, text, uuid, text, int, text, jsonb);

CREATE OR REPLACE FUNCTION public.place_order(
  p_retailer_id      uuid,
  p_items            jsonb,          -- [{"product_id": uuid, "qty": int, "packaging_level_id"?: uuid, "units_per_level"?: int}]
  p_address          text,
  p_idempotency_key  uuid,
  p_payment_mode     text    DEFAULT 'cod',
  p_redeem_points    int     DEFAULT 0,
  p_fulfillment_mode text    DEFAULT 'delivery',
  p_delivery         jsonb   DEFAULT NULL,
  p_notes            text    DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id         uuid    := auth.uid();
  v_caller_role       text;
  v_is_self_order     boolean;
  v_retailer_approved boolean;
  v_order_id          uuid;
  v_order_number      text;
  v_existing_order    jsonb;
  v_gst_enabled       boolean;
  v_subtotal          numeric := 0;
  v_gst_total         numeric := 0;
  v_grand_total       numeric := 0;
  v_item              jsonb;
  v_product_id        uuid;
  v_qty               integer;
  v_base_qty          integer;
  v_units_per_level   integer;
  v_unit_price        numeric;
  v_gst_pct           numeric;
  v_stock             integer;
  v_line_total        numeric;
  v_line_gst          numeric;
  v_retailer_name     text;
  v_retailer_phone    text;
  v_credit_limit      numeric;
  v_credit_used       numeric;
  v_initial_status    text := 'pending';
  v_discount          numeric := 0;
  v_redemption_rate   numeric;
  v_max_pct           numeric;
  v_max_discount      numeric;
  v_retailer_points   int;
  v_pickup_enabled    boolean;
  v_delivery_text     text;
  v_delivery_id       uuid;
  v_delivery_snapshot jsonb;
  -- Batch allocation vars
  v_batch             RECORD;
  v_remaining         integer;
  v_take              integer;
  v_allocations       jsonb;
BEGIN
  -- -----------------------------------------------------------------------
  -- Step 1: Payment mode validation
  -- -----------------------------------------------------------------------
  IF p_payment_mode NOT IN ('cod', 'credit', 'upi') THEN
    RAISE EXCEPTION 'invalid_payment_mode'
      USING HINT = 'Payment mode must be cod, credit, or upi';
  END IF;

  IF p_payment_mode = 'upi' THEN
    v_initial_status := 'pending_payment';
  END IF;

  -- -----------------------------------------------------------------------
  -- Step 2: Fulfillment mode validation
  -- -----------------------------------------------------------------------
  IF p_fulfillment_mode NOT IN ('delivery', 'pickup') THEN
    RAISE EXCEPTION 'invalid_fulfillment_mode'
      USING HINT = 'Fulfillment mode must be delivery or pickup';
  END IF;

  IF p_fulfillment_mode = 'pickup' THEN
    SELECT COALESCE(s.pickup_enabled, false)
      INTO v_pickup_enabled
      FROM settings s LIMIT 1;
    IF NOT v_pickup_enabled THEN
      RAISE EXCEPTION 'pickup_not_enabled'
        USING HINT = 'Pickup mode is not currently enabled';
    END IF;
  END IF;

  -- -----------------------------------------------------------------------
  -- Step 3: Idempotency check
  -- -----------------------------------------------------------------------
  SELECT jsonb_build_object('order_id', id, 'order_number', order_number, 'already_exists', true)
    INTO v_existing_order
    FROM orders
   WHERE idempotency_key = p_idempotency_key
   LIMIT 1;

  IF v_existing_order IS NOT NULL THEN
    RETURN v_existing_order;
  END IF;

  -- -----------------------------------------------------------------------
  -- Step 4: Authorization
  -- -----------------------------------------------------------------------
  SELECT role INTO v_caller_role
    FROM profiles
   WHERE id = v_caller_id;

  v_is_self_order := (v_caller_id = p_retailer_id);

  IF NOT v_is_self_order AND v_caller_role NOT IN ('admin', 'delivery') THEN
    RAISE EXCEPTION 'not_authorized'
      USING HINT = 'Only the retailer themselves or staff can place orders';
  END IF;

  SELECT approved, COALESCE(name, business_name, 'Retailer'), COALESCE(phone, ''),
         credit_limit, credit_used, loyalty_points
    INTO v_retailer_approved, v_retailer_name, v_retailer_phone,
         v_credit_limit, v_credit_used, v_retailer_points
    FROM profiles
   WHERE id = p_retailer_id AND role = 'retailer';

  IF v_retailer_approved IS NULL THEN
    RAISE EXCEPTION 'not_approved'
      USING HINT = 'Retailer not found or is not a retailer role';
  END IF;

  IF NOT v_retailer_approved THEN
    RAISE EXCEPTION 'not_approved'
      USING HINT = 'Retailer account is pending approval';
  END IF;

  -- -----------------------------------------------------------------------
  -- Step 5: Delivery address resolution
  -- -----------------------------------------------------------------------
  IF p_fulfillment_mode = 'delivery' THEN
    IF p_delivery IS NOT NULL AND p_delivery <> 'null'::jsonb THEN
      v_delivery_text := NULLIF(trim(COALESCE(p_delivery->>'full_address', '')), '');
      v_delivery_id := NULLIF(p_delivery->>'delivery_address_id', '')::uuid;
      v_delivery_snapshot := p_delivery;

      IF v_delivery_text IS NULL THEN
        RAISE EXCEPTION 'delivery_address_required'
          USING HINT = 'Please select a delivery shop location';
      END IF;

      IF v_delivery_id IS NOT NULL THEN
        IF NOT EXISTS (
          SELECT 1 FROM public.retailer_shop_locations
           WHERE id = v_delivery_id
             AND retailer_account_id = p_retailer_id
        ) THEN
          RAISE EXCEPTION 'invalid_delivery_address'
            USING HINT = 'Delivery location does not belong to this retailer';
        END IF;
      END IF;
    ELSIF p_address IS NULL OR trim(p_address) = '' THEN
      RAISE EXCEPTION 'delivery_address_required'
        USING HINT = 'Please select a delivery shop location';
    ELSE
      v_delivery_text := trim(p_address);
      v_delivery_id := NULL;
      v_delivery_snapshot := NULL;
    END IF;
  END IF;

  -- -----------------------------------------------------------------------
  -- Step 6: Settings
  -- -----------------------------------------------------------------------
  SELECT COALESCE(s.gst_enabled, true),
         COALESCE(s.loyalty_redemption_rate, 0.5),
         COALESCE(s.max_redemption_percent, 20)
    INTO v_gst_enabled, v_redemption_rate, v_max_pct
    FROM settings s
   LIMIT 1;

  -- -----------------------------------------------------------------------
  -- Step 7: Validate stock + compute totals (first pass)
  -- -----------------------------------------------------------------------
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (v_item ->> 'product_id')::uuid;
    v_qty        := (v_item ->> 'qty')::integer;

    -- If packaging level provided, compute base-unit qty
    v_units_per_level := COALESCE((v_item ->> 'units_per_level')::integer, 1);
    IF v_units_per_level < 1 THEN v_units_per_level := 1; END IF;
    v_base_qty := v_qty * v_units_per_level;

    IF v_base_qty IS NULL OR v_base_qty <= 0 THEN
      RAISE EXCEPTION 'invalid_quantity'
        USING HINT = 'Each item must have qty > 0';
    END IF;

    SELECT selling_price, gst_percent, stock_quantity
      INTO v_unit_price, v_gst_pct, v_stock
      FROM products
     WHERE id = v_product_id
       FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'product_not_found'
        USING HINT = format('Product %s does not exist', v_product_id);
    END IF;

    IF v_stock < v_base_qty THEN
      RAISE EXCEPTION 'insufficient_stock'
        USING HINT = format('Product %s: requested %s but only %s in stock', v_product_id, v_base_qty, v_stock);
    END IF;

    IF v_gst_enabled THEN
      v_line_gst := ROUND((v_unit_price * v_base_qty * v_gst_pct) / 100, 2);
    ELSE
      v_line_gst := 0;
    END IF;

    v_line_total := ROUND(v_unit_price * v_base_qty, 2) + v_line_gst;
    v_subtotal   := v_subtotal + ROUND(v_unit_price * v_base_qty, 2);
    v_gst_total  := v_gst_total + v_line_gst;
  END LOOP;

  v_grand_total := v_subtotal + v_gst_total;

  -- -----------------------------------------------------------------------
  -- Step 8: Loyalty redemption
  -- -----------------------------------------------------------------------
  IF p_redeem_points > 0 THEN
    IF v_retailer_points < p_redeem_points THEN
      RAISE EXCEPTION 'insufficient_points'
        USING HINT = format('Have %s points but tried to redeem %s', v_retailer_points, p_redeem_points);
    END IF;

    v_discount := ROUND(p_redeem_points * v_redemption_rate, 2);
    v_max_discount := ROUND(v_grand_total * v_max_pct / 100, 2);

    IF v_discount > v_max_discount THEN
      RAISE EXCEPTION 'redemption_limit_exceeded'
        USING HINT = format('Discount %s exceeds max %s%% of order value %s', v_discount, v_max_pct, v_grand_total);
    END IF;

    v_grand_total := v_grand_total - v_discount;

    UPDATE profiles
       SET loyalty_points = loyalty_points - p_redeem_points
     WHERE id = p_retailer_id;
  END IF;

  -- -----------------------------------------------------------------------
  -- Step 9: Credit check
  -- -----------------------------------------------------------------------
  IF p_payment_mode = 'credit' THEN
    IF (v_credit_used + v_grand_total) > v_credit_limit THEN
      RAISE EXCEPTION 'credit_limit_exceeded'
        USING HINT = format('Credit used %s + order %s exceeds limit %s',
                            v_credit_used, v_grand_total, v_credit_limit);
    END IF;
  END IF;

  -- -----------------------------------------------------------------------
  -- Step 10: Create the order
  -- -----------------------------------------------------------------------
  v_order_id     := gen_random_uuid();
  v_order_number := 'ORD-' || UPPER(SUBSTRING(v_order_id::text FROM 1 FOR 8));

  INSERT INTO orders (
    id, order_number, user_id, user_name, user_phone,
    items, subtotal, gst, grand_total,
    delivery_address, delivery_address_id, delivery_snapshot,
    delivery_type, payment_mode,
    fulfillment_mode, discount_amount,
    notes,
    status, idempotency_key, created_by
  ) VALUES (
    v_order_id, v_order_number, p_retailer_id, v_retailer_name, v_retailer_phone,
    p_items, v_subtotal, v_gst_total, v_grand_total,
    CASE WHEN p_fulfillment_mode = 'pickup' THEN NULL ELSE v_delivery_text END,
    CASE WHEN p_fulfillment_mode = 'pickup' THEN NULL ELSE v_delivery_id END,
    CASE WHEN p_fulfillment_mode = 'pickup' THEN NULL ELSE v_delivery_snapshot END,
    p_fulfillment_mode, p_payment_mode,
    p_fulfillment_mode, v_discount,
    NULLIF(trim(COALESCE(p_notes, '')), ''),
    v_initial_status, p_idempotency_key, v_caller_id
  );

  -- -----------------------------------------------------------------------
  -- Step 11: Credit update
  -- -----------------------------------------------------------------------
  IF p_payment_mode = 'credit' THEN
    UPDATE profiles
       SET credit_used = credit_used + v_grand_total
     WHERE id = p_retailer_id;
  END IF;

  -- -----------------------------------------------------------------------
  -- Step 12: Loyalty transaction log
  -- -----------------------------------------------------------------------
  IF p_redeem_points > 0 THEN
    INSERT INTO loyalty_transactions (retailer_id, order_id, points, reason, type)
    VALUES (p_retailer_id, v_order_id, -p_redeem_points, 'redeemed_at_checkout', 'redeemed');
  END IF;

  -- -----------------------------------------------------------------------
  -- Step 13: Insert order_items + FEFO batch allocation + stock history
  -- -----------------------------------------------------------------------
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id      := (v_item ->> 'product_id')::uuid;
    v_qty             := (v_item ->> 'qty')::integer;
    v_units_per_level := COALESCE((v_item ->> 'units_per_level')::integer, 1);
    IF v_units_per_level < 1 THEN v_units_per_level := 1; END IF;
    v_base_qty        := v_qty * v_units_per_level;

    SELECT selling_price, gst_percent INTO v_unit_price, v_gst_pct
      FROM products WHERE id = v_product_id;

    IF v_gst_enabled THEN
      v_line_gst := ROUND((v_unit_price * v_base_qty * v_gst_pct) / 100, 2);
    ELSE
      v_line_gst := 0;
    END IF;
    v_line_total := ROUND(v_unit_price * v_base_qty, 2) + v_line_gst;

    -- FEFO batch allocation
    v_remaining    := v_base_qty;
    v_allocations  := '[]'::jsonb;

    FOR v_batch IN
      SELECT id AS batch_id, quantity AS batch_qty
        FROM product_batches
       WHERE product_id = v_product_id
         AND is_active = true
         AND quantity > 0
       ORDER BY expiry_date ASC NULLS LAST, created_at ASC
       FOR UPDATE
    LOOP
      EXIT WHEN v_remaining <= 0;

      v_take := LEAST(v_remaining, v_batch.batch_qty);

      UPDATE product_batches
         SET quantity = quantity - v_take
       WHERE id = v_batch.batch_id;

      v_allocations := v_allocations || jsonb_build_array(
        jsonb_build_object('batch_id', v_batch.batch_id, 'qty', v_take)
      );

      v_remaining := v_remaining - v_take;
    END LOOP;

    IF v_remaining > 0 THEN
      -- Should not happen because we checked stock above, but guard anyway
      RAISE EXCEPTION 'insufficient_stock'
        USING HINT = format('FEFO allocation failed for product %s: %s units unallocated', v_product_id, v_remaining);
    END IF;

    -- Insert order_item with batch_allocations
    INSERT INTO order_items (order_id, product_id, qty, unit_price, gst_percent, line_total, batch_allocations)
    VALUES (v_order_id, v_product_id, v_base_qty, v_unit_price, v_gst_pct, v_line_total, v_allocations);

    -- Stock history audit (products.stock_quantity is updated by trigger)
    INSERT INTO stock_history (product_id, change, reason)
    VALUES (v_product_id, -v_base_qty, 'Order ' || v_order_number);
  END LOOP;

  -- -----------------------------------------------------------------------
  -- Step 14: Clear the retailer's cart
  -- -----------------------------------------------------------------------
  DELETE FROM cart_items WHERE user_id = p_retailer_id;

  -- -----------------------------------------------------------------------
  -- Step 15: Log initial status event
  -- -----------------------------------------------------------------------
  INSERT INTO order_status_events (order_id, from_status, to_status, actor_id)
  VALUES (v_order_id, NULL, v_initial_status, v_caller_id);

  -- -----------------------------------------------------------------------
  -- Done
  -- -----------------------------------------------------------------------
  RETURN jsonb_build_object(
    'order_id',        v_order_id,
    'order_number',    v_order_number,
    'already_exists',  false,
    'discount_amount', v_discount,
    'grand_total',     v_grand_total
  );
END;
$$;

REVOKE ALL ON FUNCTION public.place_order(uuid, jsonb, text, uuid, text, int, text, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.place_order(uuid, jsonb, text, uuid, text, int, text, jsonb, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.place_order(uuid, jsonb, text, uuid, text, int, text, jsonb, text) TO authenticated;


-- ---------------------------------------------------------------------------
-- E3. Fix enforce_order_status_transition — batch-aware cancel/reject restore
-- ---------------------------------------------------------------------------
-- CRITICAL FIX: Previously wrote directly to products.stock_quantity, which
-- the new trigger would immediately overwrite. Now restores stock into the
-- original product_batches using order_items.batch_allocations.

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
    WHEN OLD.status = 'payment_failed'  AND NEW.status IN ('pending_payment', 'cancelled')                  THEN true
    WHEN OLD.status = 'pending'         AND NEW.status IN ('approved', 'cancelled', 'assigned', 'rejected')  THEN true
    WHEN OLD.status = 'approved'        AND NEW.status IN ('packed', 'cancelled', 'assigned')                THEN true
    WHEN OLD.status = 'packed'          AND NEW.status IN ('dispatched', 'cancelled', 'assigned')            THEN true
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

  -- Log the transition
  INSERT INTO order_status_events (order_id, from_status, to_status, actor_id)
  VALUES (NEW.id, OLD.status, NEW.status, auth.uid());

  -- -----------------------------------------------------------------------
  -- Cancellation: restore credit + restore stock to BATCHES (not products)
  -- -----------------------------------------------------------------------
  IF NEW.status = 'cancelled' THEN
    PERFORM restore_credit(NEW.id);

    FOR v_item IN
      SELECT product_id, qty, batch_allocations
        FROM order_items
       WHERE order_id = NEW.id
    LOOP
      IF v_item.batch_allocations IS NOT NULL AND jsonb_array_length(v_item.batch_allocations) > 0 THEN
        -- Restore stock to the specific batches that were allocated
        FOR v_alloc IN SELECT * FROM jsonb_array_elements(v_item.batch_allocations)
        LOOP
          v_batch_id  := (v_alloc ->> 'batch_id')::uuid;
          v_alloc_qty := (v_alloc ->> 'qty')::integer;

          UPDATE product_batches
             SET quantity = quantity + v_alloc_qty
           WHERE id = v_batch_id;
          -- products.stock_quantity is updated automatically by the trigger
        END LOOP;
      ELSE
        -- Pre-v43 orders: no batch_allocations recorded.
        -- Credit the LEGACY batch (or first active batch) for this product.
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

        -- If no batch exists at all, fall back to direct update (edge case)
        IF NOT FOUND THEN
          INSERT INTO product_batches (product_id, batch_number, quantity)
          VALUES (v_item.product_id, 'LEGACY', v_item.qty);
        END IF;
      END IF;

      -- Audit trail for the stock restore
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
