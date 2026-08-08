-- =============================================================================
-- Thakkar Medico — V58: Product Aliases for Invoice Import Auto-Matching
--
-- When an admin manually maps an unmatched invoice product name to a database
-- product, the alias is saved here. Future imports with the same name will
-- automatically match via alias lookup (Priority 2, after SKU match).
--
-- Run in: Supabase Dashboard → SQL Editor → New query → Run
-- =============================================================================

BEGIN;

-- 1. Create product_aliases table
CREATE TABLE IF NOT EXISTS public.product_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alias_name text NOT NULL,
  normalized_alias text NOT NULL UNIQUE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.product_aliases IS
  'Stores admin-confirmed mappings between invoice product names and database products for auto-matching.';

-- 2. Indexes
CREATE INDEX IF NOT EXISTS idx_product_aliases_normalized ON public.product_aliases (normalized_alias);
CREATE INDEX IF NOT EXISTS idx_product_aliases_product_id ON public.product_aliases (product_id);

-- 3. Row Level Security
ALTER TABLE public.product_aliases ENABLE ROW LEVEL SECURITY;

-- Select policy: readable by admin
DROP POLICY IF EXISTS "product_aliases_select_admin" ON public.product_aliases;
CREATE POLICY "product_aliases_select_admin" ON public.product_aliases
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

-- All actions policy: only admin can modify/insert
DROP POLICY IF EXISTS "product_aliases_all_admin" ON public.product_aliases;
CREATE POLICY "product_aliases_all_admin" ON public.product_aliases
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

COMMIT;
