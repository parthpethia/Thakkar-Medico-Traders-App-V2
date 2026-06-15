-- =============================================================================
-- Thakkar Medico — Ordering System V2 Migration
-- Fixes: schema gaps, transactional order placement, RLS for staff & cancellation
--
-- Run in: Supabase Dashboard → SQL Editor → New query → Run
-- Prerequisites: setup.sql must have been run first
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION 1: SCHEMA CHANGES (tables, columns, constraints, indexes)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1a. order_items — normalized line items (replaces JSONB blob in orders.items)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.order_items (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid        NOT NULL REFERENCES public.orders (id) ON DELETE CASCADE,
  product_id  uuid        NOT NULL REFERENCES public.products (id) ON DELETE RESTRICT,
  qty         integer     NOT NULL CHECK (qty > 0),
  unit_price  numeric     NOT NULL,
  gst_percent numeric     NOT NULL DEFAULT 0,
  line_total  numeric     NOT NULL
);

-- ---------------------------------------------------------------------------
-- 1b. order_status_events — audit trail for every status transition
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.order_status_events (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid        NOT NULL REFERENCES public.orders (id) ON DELETE CASCADE,
  from_status text,
  to_status   text        NOT NULL,
  actor_id    uuid        REFERENCES public.profiles (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 1c. New columns on orders
-- ---------------------------------------------------------------------------
-- idempotency_key prevents duplicate orders from retried requests
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS idempotency_key uuid UNIQUE;

-- created_by tracks who actually placed the order (staff or retailer)
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.profiles (id) ON DELETE SET NULL;

-- cancellation_note for retailer-provided detail beyond the canned reason
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS cancellation_note text;

-- ---------------------------------------------------------------------------
-- 1d. UNIQUE constraint on order_number (prevents collision)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_order_number_unique'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_order_number_unique UNIQUE (order_number);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1e. CHECK constraint on orders.status for valid values only
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_status_check'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_status_check
      CHECK (status IN ('pending','approved','packed','dispatched','delivered','cancelled'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1f. Indexes for common query patterns
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_orders_user_id    ON public.orders (user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status     ON public.orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON public.orders (created_at DESC);
-- order_number indexed via orders_order_number_unique constraint (see v2/v3)

CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON public.order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_order_status_events_order_id ON public.order_status_events (order_id);


-- =============================================================================
-- SECTION 2: RLS FOR NEW TABLES
-- =============================================================================

ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_status_events ENABLE ROW LEVEL SECURITY;

-- order_items: readable by order owner or staff
DROP POLICY IF EXISTS "order_items_select_own" ON public.order_items;
CREATE POLICY "order_items_select_own" ON public.order_items
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_items.order_id AND o.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "order_items_select_staff" ON public.order_items;
CREATE POLICY "order_items_select_staff" ON public.order_items
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role IN ('admin', 'delivery')
    )
  );

-- order_items: insert only via RPC (SECURITY DEFINER), no direct client writes
DROP POLICY IF EXISTS "order_items_insert_rpc" ON public.order_items;
CREATE POLICY "order_items_insert_rpc" ON public.order_items
  FOR INSERT TO authenticated
  WITH CHECK (false);

-- order_status_events: readable by order owner or staff
DROP POLICY IF EXISTS "order_status_events_select_own" ON public.order_status_events;
CREATE POLICY "order_status_events_select_own" ON public.order_status_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_status_events.order_id AND o.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "order_status_events_select_staff" ON public.order_status_events;
CREATE POLICY "order_status_events_select_staff" ON public.order_status_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role IN ('admin', 'delivery')
    )
  );


-- =============================================================================
-- SECTION 3: RLS POLICY FIXES ON orders TABLE
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 3a. orders_insert_staff — delivery/admin can create orders on behalf of retailers
--     Requires created_by = caller's uid and user_id must be a valid retailer
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "orders_insert_staff" ON public.orders;
CREATE POLICY "orders_insert_staff" ON public.orders
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role IN ('admin', 'delivery')
    )
    AND EXISTS (
      SELECT 1 FROM public.profiles r
      WHERE r.id = user_id AND r.role = 'retailer'
    )
  );

-- ---------------------------------------------------------------------------
-- 3b. orders_update_own_cancel — retailers can request cancellation on their
--     own orders, but only when the order is still pending or approved
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "orders_update_own_cancel" ON public.orders;
CREATE POLICY "orders_update_own_cancel" ON public.orders
  FOR UPDATE TO authenticated
  USING (
    auth.uid() = user_id
    AND status IN ('pending', 'approved')
  )
  WITH CHECK (
    auth.uid() = user_id
    AND status IN ('pending', 'approved')
  );

-- ---------------------------------------------------------------------------
-- 3c. orders_insert_own — verify existing policy is correct for retailers
--     (re-create to ensure created_by is also set for self-placed orders)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "orders_insert_own" ON public.orders;
CREATE POLICY "orders_insert_own" ON public.orders
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    AND (created_by IS NULL OR created_by = auth.uid())
  );


-- =============================================================================
-- SECTION 4: place_order RPC — transactional, idempotent order placement
-- =============================================================================

CREATE OR REPLACE FUNCTION public.place_order(
  p_retailer_id      uuid,
  p_items            jsonb,    -- array of {"product_id": uuid, "qty": int}
  p_address          text,
  p_idempotency_key  uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER          -- bypasses RLS so the function can touch all tables
SET search_path = public
AS $$
DECLARE
  v_caller_id        uuid    := auth.uid();
  v_caller_role      text;
  v_is_self_order    boolean;
  v_retailer_approved boolean;
  v_order_id         uuid;
  v_order_number     text;
  v_existing_order   jsonb;
  v_gst_enabled      boolean;
  v_subtotal         numeric := 0;
  v_gst_total        numeric := 0;
  v_grand_total      numeric := 0;
  v_item             jsonb;
  v_product_id       uuid;
  v_qty              integer;
  v_unit_price       numeric;
  v_gst_pct          numeric;
  v_stock            integer;
  v_line_total       numeric;
  v_line_gst         numeric;
  v_retailer_name    text;
  v_retailer_phone   text;
BEGIN
  -- -----------------------------------------------------------------------
  -- Step 1: Idempotency — return existing order if this key was already used
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
  -- Step 2: Verify the caller is authorized
  -- -----------------------------------------------------------------------
  SELECT role INTO v_caller_role
    FROM profiles
   WHERE id = v_caller_id;

  v_is_self_order := (v_caller_id = p_retailer_id);

  IF NOT v_is_self_order AND v_caller_role NOT IN ('admin', 'delivery') THEN
    RAISE EXCEPTION 'not_authorized'
      USING HINT = 'Only the retailer themselves or staff can place orders';
  END IF;

  -- Retailer must be approved
  SELECT approved, COALESCE(name, business_name, 'Retailer'), COALESCE(phone, '')
    INTO v_retailer_approved, v_retailer_name, v_retailer_phone
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
  -- Step 3: Read GST setting
  -- -----------------------------------------------------------------------
  SELECT COALESCE(s.gst_enabled, true)
    INTO v_gst_enabled
    FROM settings s
   LIMIT 1;

  -- -----------------------------------------------------------------------
  -- Step 4: Lock product rows and validate stock
  -- -----------------------------------------------------------------------
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (v_item ->> 'product_id')::uuid;
    v_qty        := (v_item ->> 'qty')::integer;

    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'invalid_quantity'
        USING HINT = 'Each item must have qty > 0';
    END IF;

    -- Lock the product row to prevent concurrent stock modification
    SELECT selling_price, gst_percent, stock_quantity
      INTO v_unit_price, v_gst_pct, v_stock
      FROM products
     WHERE id = v_product_id
       FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'product_not_found'
        USING HINT = format('Product %s does not exist', v_product_id);
    END IF;

    IF v_stock < v_qty THEN
      RAISE EXCEPTION 'insufficient_stock'
        USING HINT = format('Product %s: requested %s but only %s in stock', v_product_id, v_qty, v_stock);
    END IF;

    -- Server-side total computation — GST only if enabled
    IF v_gst_enabled THEN
      v_line_gst := ROUND((v_unit_price * v_qty * v_gst_pct) / 100, 2);
    ELSE
      v_line_gst := 0;
    END IF;

    v_line_total := ROUND(v_unit_price * v_qty, 2) + v_line_gst;
    v_subtotal   := v_subtotal + ROUND(v_unit_price * v_qty, 2);
    v_gst_total  := v_gst_total + v_line_gst;
  END LOOP;

  v_grand_total := v_subtotal + v_gst_total;

  -- -----------------------------------------------------------------------
  -- Step 5: Create the order with a UUID-based order number
  -- -----------------------------------------------------------------------
  v_order_id     := gen_random_uuid();
  v_order_number := 'ORD-' || UPPER(SUBSTRING(v_order_id::text FROM 1 FOR 8));

  INSERT INTO orders (
    id, order_number, user_id, user_name, user_phone,
    items, subtotal, gst, grand_total,
    delivery_address, delivery_type, payment_mode,
    status, idempotency_key, created_by
  ) VALUES (
    v_order_id, v_order_number, p_retailer_id, v_retailer_name, v_retailer_phone,
    p_items, v_subtotal, v_gst_total, v_grand_total,
    p_address, 'delivery', 'cod',
    'pending', p_idempotency_key, v_caller_id
  );

  -- -----------------------------------------------------------------------
  -- Step 6: Insert normalized order_items + decrement stock + log history
  -- -----------------------------------------------------------------------
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (v_item ->> 'product_id')::uuid;
    v_qty        := (v_item ->> 'qty')::integer;

    SELECT selling_price, gst_percent INTO v_unit_price, v_gst_pct
      FROM products WHERE id = v_product_id;

    IF v_gst_enabled THEN
      v_line_gst := ROUND((v_unit_price * v_qty * v_gst_pct) / 100, 2);
    ELSE
      v_line_gst := 0;
    END IF;
    v_line_total := ROUND(v_unit_price * v_qty, 2) + v_line_gst;

    -- 6a. Normalized line item
    INSERT INTO order_items (order_id, product_id, qty, unit_price, gst_percent, line_total)
    VALUES (v_order_id, v_product_id, v_qty, v_unit_price, v_gst_pct, v_line_total);

    -- 6b. Decrement stock
    UPDATE products
       SET stock_quantity = stock_quantity - v_qty
     WHERE id = v_product_id;

    -- 6c. Audit trail for stock change
    INSERT INTO stock_history (product_id, change, reason)
    VALUES (v_product_id, -v_qty, 'Order ' || v_order_number);
  END LOOP;

  -- -----------------------------------------------------------------------
  -- Step 7: Clear the retailer's cart (only for self-placed orders)
  -- -----------------------------------------------------------------------
  DELETE FROM cart_items WHERE user_id = p_retailer_id;

  -- -----------------------------------------------------------------------
  -- Step 8: Log the initial status event
  -- -----------------------------------------------------------------------
  INSERT INTO order_status_events (order_id, from_status, to_status, actor_id)
  VALUES (v_order_id, NULL, 'pending', v_caller_id);

  -- -----------------------------------------------------------------------
  -- Done — return the new order's identifiers
  -- -----------------------------------------------------------------------
  RETURN jsonb_build_object(
    'order_id',     v_order_id,
    'order_number', v_order_number,
    'already_exists', false
  );
END;
$$;

-- Grant execute to authenticated users (RPC enforces its own authorization)
REVOKE ALL ON FUNCTION public.place_order(uuid, jsonb, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.place_order(uuid, jsonb, text, uuid) TO authenticated;

COMMIT;
