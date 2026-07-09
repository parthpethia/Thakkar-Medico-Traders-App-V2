-- =============================================================================
-- Thakkar Medico — V49: Fix Product Search Pagination & Delivery Field Orders
--
-- 1. Recreates public.search_products to use standard OFFSET pagination
--    for the empty query case instead of the broken keyset-UUID comparison.
-- 2. Updates orders RLS policies to allow delivery partners to select/update
--    orders they created in the field (created_by = auth.uid()).
-- 3. Recreates public.get_orders_page to return orders where o.assigned_to = auth.uid()
--    OR o.created_by = auth.uid() when p_role = 'delivery'.
-- 4. Updates public.edit_order_items to ensure delivery partners can only
--    edit orders assigned to or created by them.
-- 5. Recreates public.place_order to automatically set assigned_to = v_caller_id
--    when the order is created by a delivery user (v_caller_role = 'delivery').
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. search_products
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.search_products(text, int, int, text, boolean);

CREATE OR REPLACE FUNCTION public.search_products(
  p_query              text    DEFAULT NULL,
  p_cursor             int     DEFAULT NULL,
  p_page_size          int     DEFAULT 20,
  p_category           text    DEFAULT NULL,
  p_hide_out_of_stock  boolean DEFAULT true
)
RETURNS TABLE (
  id              uuid,
  name            text,
  company         text,
  category        text,
  sku             text,
  pack_size       text,
  image           text,
  mrp             numeric,
  selling_price   numeric,
  gst_percent     numeric,
  stock_quantity  int,
  is_active       boolean,
  created_at      timestamptz,
  unit            text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_query IS NULL OR trim(p_query) = '' THEN
    -- No search term: return all active products ordered by name with offset pagination
    RETURN QUERY
      SELECT p.id, p.name, p.company, p.category, p.sku, p.pack_size, p.image,
             p.mrp, p.selling_price, p.gst_percent, p.stock_quantity, p.is_active, p.created_at,
             p.pack_size AS unit
        FROM public.products p
       WHERE p.is_active = true
         AND (NOT p_hide_out_of_stock OR p.stock_quantity > 0)
         AND (p_category IS NULL OR p.category = p_category)
       ORDER BY p.name ASC
       LIMIT p_page_size
       OFFSET COALESCE(p_cursor, 0);
  ELSE
    -- Full-text search with ts_rank scoring
    RETURN QUERY
      SELECT p.id, p.name, p.company, p.category, p.sku, p.pack_size, p.image,
             p.mrp, p.selling_price, p.gst_percent, p.stock_quantity, p.is_active, p.created_at,
             p.pack_size AS unit
        FROM public.products p
       WHERE p.is_active = true
         AND (NOT p_hide_out_of_stock OR p.stock_quantity > 0)
         AND (p_category IS NULL OR p.category = p_category)
         AND p.search_vector @@ plainto_tsquery('english', p_query)
       ORDER BY ts_rank(p.search_vector, plainto_tsquery('english', p_query)) DESC,
                p.name ASC
       LIMIT p_page_size
       OFFSET COALESCE(p_cursor, 0);
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.search_products(text, int, int, text, boolean) TO authenticated;


-- ---------------------------------------------------------------------------
-- 2. get_orders_page
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_orders_page(text, uuid, text, timestamptz, uuid, int, timestamptz, timestamptz, text);

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
         OR (p_role = 'delivery' AND (o.assigned_to = auth.uid() OR o.created_by = auth.uid()))
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

GRANT EXECUTE ON FUNCTION public.get_orders_page(text, uuid, text, timestamptz, uuid, int, timestamptz, timestamptz, text) TO authenticated;


-- ---------------------------------------------------------------------------
-- 3. orders RLS Policies
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "orders_select" ON public.orders;
CREATE POLICY "orders_select" ON public.orders
  FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR (SELECT public.current_user_is_admin())
    OR (
      (SELECT public.current_user_is_delivery())
      AND (assigned_to = (SELECT auth.uid()) OR created_by = (SELECT auth.uid()))
    )
  );

DROP POLICY IF EXISTS "orders_update" ON public.orders;
CREATE POLICY "orders_update" ON public.orders
  FOR UPDATE TO authenticated
  USING (
    (SELECT public.current_user_is_admin())
    OR (
      (SELECT public.current_user_is_delivery())
      AND (assigned_to = (SELECT auth.uid()) OR created_by = (SELECT auth.uid()))
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
      AND (assigned_to = (SELECT auth.uid()) OR created_by = (SELECT auth.uid()))
    )
    OR (
      (SELECT auth.uid()) = user_id
      AND status = ANY (ARRAY['pending'::text, 'approved'::text])
    )
  );


-- ---------------------------------------------------------------------------
-- 4. edit_order_items RPC validation update
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.edit_order_items(
  p_order_id  uuid,
  p_items     jsonb   -- [{"product_id": uuid, "qty": int, "packaging_level_id"?: uuid, "units_per_level"?: int}]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id       uuid := auth.uid();
  v_caller_role     text;
  v_order           RECORD;
  v_gst_enabled     boolean;
  v_subtotal        numeric := 0;
  v_gst_total       numeric := 0;
  v_grand_total     numeric := 0;
  v_item            jsonb;
  v_product_id      uuid;
  v_qty             integer;
  v_base_qty        integer;
  v_units_per_level integer;
  v_unit_price      numeric;
  v_gst_pct         numeric;
  v_stock           integer;
  v_line_total      numeric;
  v_line_gst        numeric;
  -- Batch allocation vars
  v_batch           RECORD;
  v_remaining       integer;
  v_take            integer;
  v_allocations     jsonb;
  -- Restore vars
  v_old_item        RECORD;
  v_alloc           jsonb;
  v_alloc_batch_id  uuid;
  v_alloc_qty       integer;
BEGIN
  -- -----------------------------------------------------------------------
  -- Step 1: Authorization
  -- -----------------------------------------------------------------------
  SELECT role INTO v_caller_role
    FROM profiles
   WHERE id = v_caller_id;

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'delivery') THEN
    RAISE EXCEPTION 'not_authorized'
      USING HINT = 'Only admin or delivery staff can edit order items';
  END IF;

  -- -----------------------------------------------------------------------
  -- Step 2: Fetch and validate the order
  -- -----------------------------------------------------------------------
  SELECT id, order_number, status, user_id, assigned_to, created_by
    INTO v_order
    FROM orders
   WHERE id = p_order_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_not_found'
      USING HINT = format('Order %s does not exist', p_order_id);
  END IF;

  IF v_caller_role = 'delivery' AND v_order.assigned_to IS DISTINCT FROM v_caller_id AND v_order.created_by IS DISTINCT FROM v_caller_id THEN
    RAISE EXCEPTION 'not_authorized'
      USING HINT = 'Delivery partners can only edit orders assigned to or created by them';
  END IF;

  IF v_order.status IN ('delivered', 'cancelled', 'rejected') THEN
    RAISE EXCEPTION 'order_not_editable'
      USING HINT = format('Order is %s and cannot be edited', v_order.status);
  END IF;

  -- -----------------------------------------------------------------------
  -- Step 3: Settings
  -- -----------------------------------------------------------------------
  SELECT COALESCE(s.gst_enabled, true)
    INTO v_gst_enabled
    FROM settings s
   LIMIT 1;

  -- -----------------------------------------------------------------------
  -- Step 4: Restore stock from OLD order_items batch allocations
  -- -----------------------------------------------------------------------
  FOR v_old_item IN
    SELECT product_id, qty, batch_allocations
      FROM order_items
     WHERE order_id = p_order_id
  LOOP
    IF v_old_item.batch_allocations IS NOT NULL
       AND jsonb_array_length(v_old_item.batch_allocations) > 0 THEN
      -- Restore to the specific batches that were allocated
      FOR v_alloc IN SELECT * FROM jsonb_array_elements(v_old_item.batch_allocations)
      LOOP
        v_alloc_batch_id := (v_alloc ->> 'batch_id')::uuid;
        v_alloc_qty      := (v_alloc ->> 'qty')::integer;

        UPDATE product_batches
           SET quantity = quantity + v_alloc_qty
         WHERE id = v_alloc_batch_id;
      END LOOP;
    ELSE
      -- Pre-v43 orders without batch_allocations: restore to LEGACY batch
      UPDATE product_batches
         SET quantity = quantity + v_old_item.qty
       WHERE id = (
         SELECT id FROM product_batches
          WHERE product_id = v_old_item.product_id
            AND is_active = true
          ORDER BY
            CASE WHEN batch_number = 'LEGACY' THEN 0 ELSE 1 END,
            created_at ASC
          LIMIT 1
       );

      IF NOT FOUND THEN
        INSERT INTO product_batches (product_id, batch_number, quantity)
        VALUES (v_old_item.product_id, 'LEGACY', v_old_item.qty);
      END IF;
    END IF;

    -- Audit trail for the restore
    INSERT INTO stock_history (product_id, change, reason)
    VALUES (
      v_old_item.product_id,
      v_old_item.qty,
      'Edit order restore: ' || v_order.order_number
    );
  END LOOP;

  -- -----------------------------------------------------------------------
  -- Step 5: Delete old order_items
  -- -----------------------------------------------------------------------
  DELETE FROM order_items WHERE order_id = p_order_id;

  -- -----------------------------------------------------------------------
  -- Step 6: Validate stock + compute totals (first pass)
  -- -----------------------------------------------------------------------
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id      := (v_item ->> 'product_id')::uuid;
    v_qty             := (v_item ->> 'qty')::integer;
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
  -- Step 7: Insert new order_items + FEFO batch allocation + stock history
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
    v_remaining   := v_base_qty;
    v_allocations := '[]'::jsonb;

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
      RAISE EXCEPTION 'insufficient_stock'
        USING HINT = format('FEFO allocation failed for product %s: %s units unallocated', v_product_id, v_remaining);
    END IF;

    -- Insert order_item with batch_allocations
    INSERT INTO order_items (order_id, product_id, qty, unit_price, gst_percent, line_total, batch_allocations)
    VALUES (p_order_id, v_product_id, v_base_qty, v_unit_price, v_gst_pct, v_line_total, v_allocations);

    -- Stock history audit
    INSERT INTO stock_history (product_id, change, reason)
    VALUES (v_product_id, -v_base_qty, 'Edit order ' || v_order.order_number);
  END LOOP;

  -- -----------------------------------------------------------------------
  -- Step 8: Update the order's totals and items JSON
  -- -----------------------------------------------------------------------
  UPDATE orders
     SET items       = p_items,
         subtotal    = v_subtotal,
         gst         = v_gst_total,
         grand_total = v_grand_total
   WHERE id = p_order_id;

  -- -----------------------------------------------------------------------
  -- Done
  -- -----------------------------------------------------------------------
  RETURN jsonb_build_object(
    'order_id',    p_order_id,
    'order_number', v_order.order_number,
    'subtotal',    v_subtotal,
    'gst',         v_gst_total,
    'grand_total', v_grand_total
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.edit_order_items(uuid, jsonb) TO authenticated;


-- ---------------------------------------------------------------------------
-- 5. place_order RPC auto-assign field orders
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.place_order(uuid, jsonb, text, uuid, text, int, text, jsonb, text);

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
  -- Assignment var
  v_assigned_to       uuid := NULL;
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
    status, idempotency_key, created_by, assigned_to
  ) VALUES (
    v_order_id, v_order_number, p_retailer_id, v_retailer_name, v_retailer_phone,
    p_items, v_subtotal, v_gst_total, v_grand_total,
    CASE WHEN p_fulfillment_mode = 'pickup' THEN NULL ELSE v_delivery_text END,
    CASE WHEN p_fulfillment_mode = 'pickup' THEN NULL ELSE v_delivery_id END,
    CASE WHEN p_fulfillment_mode = 'pickup' THEN NULL ELSE v_delivery_snapshot END,
    p_fulfillment_mode, p_payment_mode,
    p_fulfillment_mode, v_discount,
    NULLIF(trim(COALESCE(p_notes, '')), ''),
    v_initial_status, p_idempotency_key, v_caller_id, v_assigned_to
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
      RAISE EXCEPTION 'insufficient_stock'
        USING HINT = format('FEFO allocation failed for product %s: %s units unallocated', v_product_id, v_remaining);
    END IF;

    -- Insert order_item with batch_allocations
    INSERT INTO order_items (order_id, product_id, qty, unit_price, gst_percent, line_total, batch_allocations)
    VALUES (v_order_id, v_product_id, v_base_qty, v_unit_price, v_gst_pct, v_line_total, v_allocations);

    -- Stock history audit
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

GRANT EXECUTE ON FUNCTION public.place_order(uuid, jsonb, text, uuid, text, int, text, jsonb, text) TO authenticated;

COMMIT;
