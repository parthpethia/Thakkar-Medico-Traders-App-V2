-- =============================================================================
-- Thakkar Medico — V45: edit_order_items RPC
--
-- Transactional RPC for editing order items on an existing order.
-- Restores old batch-allocated stock, deletes old order_items, performs FEFO
-- batch allocation for the new items, inserts new order_items, updates the
-- order's totals and items JSON.
--
-- Prerequisites: All migrations through v44 must have been applied.
-- =============================================================================

BEGIN;

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
  v_old_item        RECORD;Audit whole delivery person portal and see if all pages have the things they are made for. goo deep and find bugs in it
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
  SELECT id, order_number, status, user_id
    INTO v_order
    FROM orders
   WHERE id = p_order_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_not_found'
      USING HINT = format('Order %s does not exist', p_order_id);
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

REVOKE ALL ON FUNCTION public.edit_order_items(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.edit_order_items(uuid, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.edit_order_items(uuid, jsonb) TO authenticated;

COMMIT;
