-- =============================================================================
-- Thakkar Medico — Catalogue foundation (companies, divisions, FKs, purchase RPCs)
-- =============================================================================
-- Run after migration-cart-access-v33.sql (and prior v27–v32 order migrations).
-- Idempotent where practical — safe to re-run for policies/RPCs/indexes.
--
-- FOLLOW-UP (frontend, not in this migration):
--   • app/company/[name].tsx — switch .eq('company', name) → .eq('company_id', id)
--   • app/(tabs)/products.tsx — get_active_companies now returns rows
--     { id, name, slug, logo_url } instead of plain text company names
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PART 1: companies
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.companies (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL UNIQUE,
  slug       text        NOT NULL UNIQUE,
  logo_url   text,
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- PART 1: divisions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.divisions (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid        NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  name       text        NOT NULL,
  slug       text        NOT NULL,
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  UNIQUE (company_id, name)
);

-- ---------------------------------------------------------------------------
-- PART 1: products FK columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES public.companies (id) ON DELETE SET NULL;

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS division_id uuid REFERENCES public.divisions (id) ON DELETE SET NULL;

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES public.categories (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- PART 1: backfill companies from products.company (keep text column)
-- ---------------------------------------------------------------------------
INSERT INTO public.companies (name, slug)
SELECT DISTINCT
  trim(p.company) AS name,
  lower(regexp_replace(trim(p.company), '\s+', '-', 'g')) AS slug
FROM public.products p
WHERE p.company IS NOT NULL
  AND trim(p.company) <> ''
ON CONFLICT (name) DO NOTHING;

UPDATE public.products pr
SET company_id = c.id
FROM public.companies c
WHERE pr.company IS NOT NULL
  AND trim(pr.company) <> ''
  AND trim(pr.company) = c.name;

-- Verification: expect 0 rows with company text but no company_id
-- SELECT COUNT(*) FROM public.products WHERE company_id IS NULL AND company IS NOT NULL AND trim(company) <> '';

-- ---------------------------------------------------------------------------
-- PART 1: backfill category_id from products.category (keep text column)
-- ---------------------------------------------------------------------------
UPDATE public.products pr
SET category_id = cat.id
FROM public.categories cat
WHERE pr.category IS NOT NULL
  AND trim(pr.category) <> ''
  AND pr.category = cat.name
  AND cat.is_active = true;

-- Verification: some products may not match an active category name — run:
-- SELECT COUNT(*) FROM public.products WHERE category_id IS NOT NULL;
-- SELECT category, COUNT(*) FROM public.products
-- WHERE category_id IS NULL AND category IS NOT NULL AND trim(category) <> ''
-- GROUP BY category ORDER BY COUNT(*) DESC;

-- ---------------------------------------------------------------------------
-- PART 1: RLS — companies & divisions (read: authenticated; write: admin)
-- ---------------------------------------------------------------------------
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.divisions ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.companies TO authenticated;
GRANT SELECT ON public.divisions TO authenticated;

DROP POLICY IF EXISTS "companies_select" ON public.companies;
CREATE POLICY "companies_select" ON public.companies
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "companies_insert_admin" ON public.companies;
CREATE POLICY "companies_insert_admin" ON public.companies
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.current_user_is_admin()));

DROP POLICY IF EXISTS "companies_update_admin" ON public.companies;
CREATE POLICY "companies_update_admin" ON public.companies
  FOR UPDATE TO authenticated
  USING ((SELECT public.current_user_is_admin()))
  WITH CHECK ((SELECT public.current_user_is_admin()));

DROP POLICY IF EXISTS "companies_delete_admin" ON public.companies;
CREATE POLICY "companies_delete_admin" ON public.companies
  FOR DELETE TO authenticated
  USING ((SELECT public.current_user_is_admin()));

DROP POLICY IF EXISTS "divisions_select" ON public.divisions;
CREATE POLICY "divisions_select" ON public.divisions
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "divisions_insert_admin" ON public.divisions;
CREATE POLICY "divisions_insert_admin" ON public.divisions
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.current_user_is_admin()));

DROP POLICY IF EXISTS "divisions_update_admin" ON public.divisions;
CREATE POLICY "divisions_update_admin" ON public.divisions
  FOR UPDATE TO authenticated
  USING ((SELECT public.current_user_is_admin()))
  WITH CHECK ((SELECT public.current_user_is_admin()));

DROP POLICY IF EXISTS "divisions_delete_admin" ON public.divisions;
CREATE POLICY "divisions_delete_admin" ON public.divisions
  FOR DELETE TO authenticated
  USING ((SELECT public.current_user_is_admin()));

-- ---------------------------------------------------------------------------
-- PART 2: get_active_companies — read from companies table
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_active_companies();

CREATE OR REPLACE FUNCTION public.get_active_companies()
RETURNS TABLE (
  id       uuid,
  name     text,
  slug     text,
  logo_url text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT c.id, c.name, c.slug, c.logo_url
  FROM public.companies c
  WHERE c.is_active = true
  ORDER BY c.name ASC;
$$;

REVOKE ALL ON FUNCTION public.get_active_companies() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_active_companies() TO authenticated;

-- ---------------------------------------------------------------------------
-- PART 3: get_retailer_purchase_history
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_retailer_purchase_history(
  p_user_id uuid DEFAULT auth.uid()
)
RETURNS TABLE (
  product_id        uuid,
  name              text,
  company           text,
  company_id        uuid,
  division_id       uuid,
  category_id       uuid,
  selling_price     numeric,
  stock_quantity    integer,
  is_active         boolean,
  image             text,
  total_qty_ordered bigint,
  order_count       bigint,
  last_ordered_at   timestamptz,
  first_ordered_at  timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'access_denied';
  END IF;

  IF auth.uid() IS DISTINCT FROM p_user_id
     AND NOT (SELECT public.current_user_is_admin()) THEN
    RAISE EXCEPTION 'access_denied';
  END IF;

  RETURN QUERY
  SELECT
    oi.product_id,
    p.name,
    p.company,
    p.company_id,
    p.division_id,
    p.category_id,
    p.selling_price,
    p.stock_quantity,
    p.is_active,
    p.image,
    SUM(oi.qty)           AS total_qty_ordered,
    COUNT(DISTINCT o.id)  AS order_count,
    MAX(o.created_at)     AS last_ordered_at,
    MIN(o.created_at)     AS first_ordered_at
  FROM public.order_items oi
  JOIN public.orders o ON o.id = oi.order_id
  JOIN public.products p ON p.id = oi.product_id
  WHERE
    o.user_id = p_user_id
    AND o.status NOT IN ('cancelled', 'payment_failed', 'rejected')
    AND p.is_active = true
  GROUP BY
    oi.product_id, p.name, p.company, p.company_id,
    p.division_id, p.category_id, p.selling_price,
    p.stock_quantity, p.is_active, p.image
  ORDER BY total_qty_ordered DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_retailer_purchase_history(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_retailer_purchase_history(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_retailer_purchase_history(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- PART 3: get_company_purchase_summary
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_company_purchase_summary(
  p_user_id uuid DEFAULT auth.uid()
)
RETURNS TABLE (
  company_id    uuid,
  company_name  text,
  company_slug  text,
  order_count   bigint,
  total_units   bigint,
  last_order_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'access_denied';
  END IF;

  IF auth.uid() IS DISTINCT FROM p_user_id
     AND NOT (SELECT public.current_user_is_admin()) THEN
    RAISE EXCEPTION 'access_denied';
  END IF;

  RETURN QUERY
  SELECT
    p.company_id,
    c.name        AS company_name,
    c.slug        AS company_slug,
    COUNT(DISTINCT o.id)   AS order_count,
    SUM(oi.qty)            AS total_units,
    MAX(o.created_at)      AS last_order_at
  FROM public.order_items oi
  JOIN public.orders o ON o.id = oi.order_id
  JOIN public.products p ON p.id = oi.product_id
  JOIN public.companies c ON c.id = p.company_id
  WHERE
    o.user_id = p_user_id
    AND o.status NOT IN ('cancelled', 'payment_failed', 'rejected')
    AND p.company_id IS NOT NULL
  GROUP BY p.company_id, c.name, c.slug
  ORDER BY order_count DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_company_purchase_summary(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_company_purchase_summary(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_company_purchase_summary(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- PART 4: indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_products_company_id ON public.products (company_id);
CREATE INDEX IF NOT EXISTS idx_products_division_id ON public.products (division_id);
CREATE INDEX IF NOT EXISTS idx_products_category_id ON public.products (category_id);
CREATE INDEX IF NOT EXISTS idx_divisions_company_id ON public.divisions (company_id);
-- idx_order_items_order_id exists from ordering-system v2
CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON public.order_items (product_id);

-- =============================================================================
-- Post-migration verification (run in SQL Editor)
-- =============================================================================
-- SELECT COUNT(*) FROM companies;
-- SELECT COUNT(*) FROM products WHERE company_id IS NOT NULL;
-- SELECT company, COUNT(*) FROM products
-- WHERE company_id IS NULL AND company IS NOT NULL
-- GROUP BY company ORDER BY COUNT(*) DESC;
-- SELECT COUNT(*) FROM products WHERE category_id IS NOT NULL;
-- SELECT category, COUNT(*) FROM products
-- WHERE category_id IS NULL AND category IS NOT NULL
-- GROUP BY category ORDER BY COUNT(*) DESC;
-- SELECT * FROM get_retailer_purchase_history(auth.uid()) LIMIT 10;
-- SELECT * FROM get_company_purchase_summary(auth.uid()) LIMIT 5;
