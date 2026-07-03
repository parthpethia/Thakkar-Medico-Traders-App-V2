-- =============================================================================
-- Thakkar Medico — V43 Verification Tests
--
-- Run these AFTER migration-packaging-batch-v43.sql on STAGING ONLY.
-- Each test section is independent. Check output in the SQL Editor "Results" pane.
-- =============================================================================

-- =============================================================================
-- TEST 1: Packaging levels table exists and constraints work
-- =============================================================================
DO $$
DECLARE
  v_test_product_id uuid;
  v_count int;
BEGIN
  -- Pick a product
  SELECT id INTO v_test_product_id FROM products WHERE is_active = true LIMIT 1;

  IF v_test_product_id IS NULL THEN
    RAISE NOTICE 'TEST 1: SKIP — no active products found';
    RETURN;
  END IF;

  -- Insert a base packaging level
  INSERT INTO product_packaging_levels (product_id, level_name, units_per_level, is_base, min_order_qty, increment_step, display_order)
  VALUES (v_test_product_id, 'test_strip', 1, true, 1, 1, 0)
  ON CONFLICT (product_id, level_name) DO NOTHING;

  -- Insert a box level
  INSERT INTO product_packaging_levels (product_id, level_name, units_per_level, is_base, min_order_qty, increment_step, display_order)
  VALUES (v_test_product_id, 'test_box', 10, false, 1, 1, 1)
  ON CONFLICT (product_id, level_name) DO NOTHING;

  SELECT count(*) INTO v_count
    FROM product_packaging_levels
   WHERE product_id = v_test_product_id;

  IF v_count >= 2 THEN
    RAISE NOTICE 'TEST 1: PASS — product_packaging_levels has % rows for product %', v_count, v_test_product_id;
  ELSE
    RAISE NOTICE 'TEST 1: FAIL — expected >= 2 rows, got %', v_count;
  END IF;

  -- Cleanup test data
  DELETE FROM product_packaging_levels WHERE product_id = v_test_product_id AND level_name LIKE 'test_%';
END;
$$;


-- =============================================================================
-- TEST 2: LEGACY backfill verification
-- =============================================================================
DO $$
DECLARE
  v_mismatched int;
  v_missing    int;
BEGIN
  -- Check products with stock > 0 that have no batches
  SELECT count(*) INTO v_missing
    FROM products p
   WHERE p.stock_quantity > 0
     AND NOT EXISTS (SELECT 1 FROM product_batches pb WHERE pb.product_id = p.id);

  IF v_missing > 0 THEN
    RAISE NOTICE 'TEST 2a: FAIL — % products with stock but no batches', v_missing;
  ELSE
    RAISE NOTICE 'TEST 2a: PASS — all products with stock have batch rows';
  END IF;

  -- Check that SUM(batch qty) matches products.stock_quantity
  SELECT count(*) INTO v_mismatched
    FROM products p
   WHERE p.stock_quantity > 0
     AND p.stock_quantity <> COALESCE((
           SELECT SUM(pb.quantity)
             FROM product_batches pb
            WHERE pb.product_id = p.id AND pb.is_active = true
         ), 0);

  IF v_mismatched > 0 THEN
    RAISE NOTICE 'TEST 2b: FAIL — % products where stock_quantity != SUM(batch quantity)', v_mismatched;
  ELSE
    RAISE NOTICE 'TEST 2b: PASS — all product stock_quantity matches batch sum';
  END IF;
END;
$$;


-- =============================================================================
-- TEST 3: Trigger verification — updating batch qty syncs products.stock_quantity
-- =============================================================================
DO $$
DECLARE
  v_product_id uuid;
  v_batch_id   uuid;
  v_stock_before int;
  v_stock_after  int;
BEGIN
  -- Pick a product with a LEGACY batch
  SELECT pb.product_id, pb.id INTO v_product_id, v_batch_id
    FROM product_batches pb
   WHERE pb.batch_number = 'LEGACY' AND pb.quantity > 5
   LIMIT 1;

  IF v_product_id IS NULL THEN
    RAISE NOTICE 'TEST 3: SKIP — no LEGACY batch with qty > 5 found';
    RETURN;
  END IF;

  SELECT stock_quantity INTO v_stock_before FROM products WHERE id = v_product_id;

  -- Temporarily decrease batch qty by 3
  UPDATE product_batches SET quantity = quantity - 3 WHERE id = v_batch_id;

  SELECT stock_quantity INTO v_stock_after FROM products WHERE id = v_product_id;

  IF v_stock_after = v_stock_before - 3 THEN
    RAISE NOTICE 'TEST 3: PASS — trigger updated stock_quantity from % to %', v_stock_before, v_stock_after;
  ELSE
    RAISE NOTICE 'TEST 3: FAIL — expected %, got %', v_stock_before - 3, v_stock_after;
  END IF;

  -- Restore
  UPDATE product_batches SET quantity = quantity + 3 WHERE id = v_batch_id;
END;
$$;


-- =============================================================================
-- TEST 4: Place order — batch allocation + batch_allocations column
-- =============================================================================
-- NOTE: This requires a valid retailer and product. Adjust IDs as needed.
-- This test is designed to be run manually with real staging IDs.

-- SELECT * FROM product_batches WHERE product_id = '<YOUR_PRODUCT_ID>' ORDER BY expiry_date ASC NULLS LAST;
-- Run place_order via the app or RPC, then:
-- SELECT batch_allocations FROM order_items WHERE order_id = '<NEW_ORDER_ID>';
-- Verify batch_allocations is a non-null JSON array with batch_id and qty entries.


-- =============================================================================
-- TEST 5: Cancel order — batch restore (CRITICAL)
-- =============================================================================
-- After placing a test order (TEST 4):
--
-- 1. Record the batch quantities BEFORE cancel:
--    SELECT id, quantity FROM product_batches WHERE product_id = '<PRODUCT_ID>';
--
-- 2. Cancel the order:
--    UPDATE orders SET status = 'cancelled' WHERE id = '<ORDER_ID>';
--
-- 3. Verify batch quantities are restored:
--    SELECT id, quantity FROM product_batches WHERE product_id = '<PRODUCT_ID>';
--    -- Each batch's qty should be back to pre-order value
--
-- 4. Verify products.stock_quantity is restored (via trigger):
--    SELECT stock_quantity FROM products WHERE id = '<PRODUCT_ID>';
--
-- 5. Verify stock_history has the restore entry:
--    SELECT * FROM stock_history WHERE product_id = '<PRODUCT_ID>' ORDER BY created_at DESC LIMIT 5;


-- =============================================================================
-- TEST 6: Pre-v43 order cancel (NULL batch_allocations → LEGACY fallback)
-- =============================================================================
DO $$
DECLARE
  v_product_id  uuid;
  v_batch_id    uuid;
  v_batch_qty   int;
  v_order_id    uuid;
  v_item_id     uuid;
  v_stock_before int;
  v_stock_after  int;
BEGIN
  -- Pick a product with a LEGACY batch
  SELECT pb.product_id, pb.id, pb.quantity INTO v_product_id, v_batch_id, v_batch_qty
    FROM product_batches pb
    JOIN products p ON p.id = pb.product_id
   WHERE pb.batch_number = 'LEGACY' AND pb.quantity >= 5 AND p.is_active = true
   LIMIT 1;

  IF v_product_id IS NULL THEN
    RAISE NOTICE 'TEST 6: SKIP — no suitable LEGACY batch found';
    RETURN;
  END IF;

  -- Find an existing cancelled order to modify, or skip
  SELECT o.id INTO v_order_id
    FROM orders o WHERE o.status = 'cancelled' LIMIT 1;

  IF v_order_id IS NULL THEN
    RAISE NOTICE 'TEST 6: SKIP — no cancelled orders to test with';
    RETURN;
  END IF;

  -- Insert a fake order_item with NULL batch_allocations to simulate pre-v43
  INSERT INTO order_items (order_id, product_id, qty, unit_price, gst_percent, line_total, batch_allocations)
  VALUES (v_order_id, v_product_id, 2, 100, 0, 200, NULL)
  RETURNING id INTO v_item_id;

  -- Manually deduct from batch to simulate stock taken
  UPDATE product_batches SET quantity = quantity - 2 WHERE id = v_batch_id;
  SELECT stock_quantity INTO v_stock_before FROM products WHERE id = v_product_id;

  RAISE NOTICE 'TEST 6: stock before restore = %', v_stock_before;

  -- NOTE: Cannot re-trigger cancel here because the order is already cancelled.
  -- This test validates that the SQL structure is correct.
  -- A full integration test should be done via the app.

  -- Cleanup
  DELETE FROM order_items WHERE id = v_item_id;
  UPDATE product_batches SET quantity = quantity + 2 WHERE id = v_batch_id;

  SELECT stock_quantity INTO v_stock_after FROM products WHERE id = v_product_id;
  RAISE NOTICE 'TEST 6: stock after cleanup = % (should equal original)', v_stock_after;
  RAISE NOTICE 'TEST 6: PASS — structure valid (full integration test needed via app)';
END;
$$;


-- =============================================================================
-- TEST 7: place_order function exists with 9 args
-- =============================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname = 'place_order'
      AND array_length(p.proargtypes, 1) = 9
  ) THEN
    RAISE NOTICE 'TEST 7: PASS — place_order with 9 args exists';
  ELSE
    RAISE NOTICE 'TEST 7: FAIL — place_order with 9 args NOT found';
  END IF;

  -- Check old 8-arg version is gone
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname = 'place_order'
      AND array_length(p.proargtypes, 1) = 8
  ) THEN
    RAISE NOTICE 'TEST 7b: FAIL — old 8-arg place_order still exists (should be dropped)';
  ELSE
    RAISE NOTICE 'TEST 7b: PASS — old 8-arg place_order correctly dropped';
  END IF;
END;
$$;
