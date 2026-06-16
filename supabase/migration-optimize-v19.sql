-- =============================================================================
-- Thakkar Medico — Optimization Migration V19
-- Distinct company RPC and product indexes
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_active_companies()
RETURNS SETOF text AS $$
  SELECT DISTINCT company
    FROM public.products
   WHERE is_active = true
     AND company IS NOT NULL
     AND company <> ''
   ORDER BY company;
$$ LANGUAGE sql STABLE;

REVOKE ALL ON FUNCTION public.get_active_companies() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_active_companies() TO authenticated;

-- Composite Indexes
CREATE INDEX IF NOT EXISTS idx_products_active_company_name ON public.products (is_active, company, name);
CREATE INDEX IF NOT EXISTS idx_products_active_created_at ON public.products (is_active, created_at DESC);
