-- ============================================================================
-- Migration v12: RLS policy consolidation + duplicate index cleanup
-- ============================================================================
-- Fixes Supabase Performance Advisor:
--   • Multiple permissive policies (same role + action on one table)
--   • Duplicate indexes on cart_items / orders
-- Run after v11. Idempotent — safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- profiles: merge SELECT and UPDATE policies
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
DROP POLICY IF EXISTS "profiles_select_staff" ON public.profiles;
DROP POLICY IF EXISTS "profiles_select" ON public.profiles;
CREATE POLICY "profiles_select" ON public.profiles
  FOR SELECT TO authenticated
  USING (
    id = (select auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid()) AND p.role IN ('admin', 'delivery')
    )
  );

DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
DROP POLICY IF EXISTS "profiles_update_admin" ON public.profiles;
DROP POLICY IF EXISTS "profiles_update" ON public.profiles;
CREATE POLICY "profiles_update" ON public.profiles
  FOR UPDATE TO authenticated
  USING (
    id = (select auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid()) AND p.role = 'admin'
    )
  )
  WITH CHECK (
    id = (select auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid()) AND p.role = 'admin'
    )
  );

-- ---------------------------------------------------------------------------
-- products: one SELECT policy; split admin write (avoid FOR ALL + read overlap)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "products_write_admin" ON public.products;

DROP POLICY IF EXISTS "products_insert_admin" ON public.products;
CREATE POLICY "products_insert_admin" ON public.products
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid()) AND p.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "products_update_admin" ON public.products;
CREATE POLICY "products_update_admin" ON public.products
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid()) AND p.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid()) AND p.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "products_delete_admin" ON public.products;
CREATE POLICY "products_delete_admin" ON public.products
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid()) AND p.role = 'admin'
    )
  );

-- products_read (SELECT only) — recreate if missing
DROP POLICY IF EXISTS "products_select" ON public.products;
DROP POLICY IF EXISTS "products_read" ON public.products;
CREATE POLICY "products_read" ON public.products
  FOR SELECT TO authenticated
  USING (true);

-- ---------------------------------------------------------------------------
-- settings: one SELECT policy; admin write split by command
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "settings_write_admin" ON public.settings;
DROP POLICY IF EXISTS "settings_select" ON public.settings;

DROP POLICY IF EXISTS "settings_insert_admin" ON public.settings;
CREATE POLICY "settings_insert_admin" ON public.settings
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid()) AND p.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "settings_update_admin" ON public.settings;
CREATE POLICY "settings_update_admin" ON public.settings
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid()) AND p.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid()) AND p.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "settings_delete_admin" ON public.settings;
CREATE POLICY "settings_delete_admin" ON public.settings
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid()) AND p.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "settings_read" ON public.settings;
CREATE POLICY "settings_read" ON public.settings
  FOR SELECT TO authenticated
  USING (true);

-- ---------------------------------------------------------------------------
-- orders: merge SELECT / INSERT / UPDATE permissive pairs
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "orders_select_own" ON public.orders;
DROP POLICY IF EXISTS "orders_select_staff" ON public.orders;
DROP POLICY IF EXISTS "orders_select" ON public.orders;
CREATE POLICY "orders_select" ON public.orders
  FOR SELECT TO authenticated
  USING (
    user_id = (select auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid()) AND p.role IN ('admin', 'delivery')
    )
  );

DROP POLICY IF EXISTS "orders_insert_own" ON public.orders;
DROP POLICY IF EXISTS "orders_insert_staff" ON public.orders;
DROP POLICY IF EXISTS "orders_insert" ON public.orders;
CREATE POLICY "orders_insert" ON public.orders
  FOR INSERT TO authenticated
  WITH CHECK (
    (
      (select auth.uid()) = user_id
      AND (created_by IS NULL OR created_by = (select auth.uid()))
    )
    OR (
      created_by = (select auth.uid())
      AND EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = (select auth.uid()) AND p.role IN ('admin', 'delivery')
      )
      AND EXISTS (
        SELECT 1 FROM public.profiles r
        WHERE r.id = user_id AND r.role = 'retailer'
      )
    )
  );

DROP POLICY IF EXISTS "orders_update_staff" ON public.orders;
DROP POLICY IF EXISTS "orders_update_own_cancel" ON public.orders;
DROP POLICY IF EXISTS "orders_update" ON public.orders;
CREATE POLICY "orders_update" ON public.orders
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid()) AND p.role IN ('admin', 'delivery')
    )
    OR (
      (select auth.uid()) = user_id
      AND status IN ('pending', 'approved')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid()) AND p.role IN ('admin', 'delivery')
    )
    OR (
      (select auth.uid()) = user_id
      AND status IN ('pending', 'approved')
    )
  );

-- ---------------------------------------------------------------------------
-- loyalty_transactions: merge SELECT policies
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "loyalty_transactions_select_own" ON public.loyalty_transactions;
DROP POLICY IF EXISTS "loyalty_transactions_select_admin" ON public.loyalty_transactions;
DROP POLICY IF EXISTS "loyalty_transactions_select" ON public.loyalty_transactions;
CREATE POLICY "loyalty_transactions_select" ON public.loyalty_transactions
  FOR SELECT TO authenticated
  USING (
    retailer_id = (select auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (select auth.uid()) AND p.role = 'admin'
    )
  );

-- ---------------------------------------------------------------------------
-- Duplicate indexes (same columns as a UNIQUE constraint index)
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS public.idx_orders_order_number;

-- Redundant unique index names sometimes duplicated manually on cart_items
DROP INDEX IF EXISTS public.idx_cart_items_user_id_product_id;
DROP INDEX IF EXISTS public.cart_items_user_id_product_id_idx;

-- Drop any remaining byte-identical duplicate indexes (keep one per signature)
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    WITH defs AS (
      SELECT
        i.indrelid,
        i.indexrelid,
        pg_get_indexdef(i.indexrelid, 0, true) AS indexdef
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND NOT i.indisprimary
    ),
    grouped AS (
      SELECT indrelid, indexdef, array_agg(indexrelid ORDER BY indexrelid) AS oids
      FROM defs
      GROUP BY indrelid, indexdef
      HAVING COUNT(*) > 1
    )
    SELECT c.relname AS index_name
    FROM grouped g
    CROSS JOIN LATERAL unnest(g.oids[2:array_length(g.oids, 1)]) AS dup_oid
    JOIN pg_class c ON c.oid = dup_oid
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', r.index_name);
  END LOOP;
END $$;
