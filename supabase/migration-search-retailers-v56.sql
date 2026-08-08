-- =============================================================================
-- Thakkar Medico — V56: Server-Side Retailer Search with Pagination
--
-- Problem: The delivery "Field Order" screen fetches all retailers via
--          PostgREST SELECT, which silently caps at 1,000 rows.
--          With ~6,800 retailers, most are invisible to the delivery user.
--
-- Solution: A SECURITY DEFINER RPC that performs ILIKE search + OFFSET
--           pagination on the server and returns a total_count so the
--           client can implement infinite scroll.
--
-- Run in: Supabase Dashboard → SQL Editor → New query → Run
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Enable pg_trgm for fast ILIKE / trigram searches
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- 2. GIN trigram indexes on the columns we search
--    These make ILIKE '%term%' queries use index scans instead of seq scans.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_profiles_name_trgm
  ON public.profiles USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_profiles_business_name_trgm
  ON public.profiles USING gin (business_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_profiles_retailer_code_trgm
  ON public.profiles USING gin (retailer_code gin_trgm_ops);

-- Also add a btree index on role for the filter
CREATE INDEX IF NOT EXISTS idx_profiles_role
  ON public.profiles (role);

-- ---------------------------------------------------------------------------
-- 3. search_retailers RPC
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_retailers(
  p_query          text    DEFAULT NULL,
  p_search_by_code boolean DEFAULT false,
  p_offset         int     DEFAULT 0,
  p_page_size      int     DEFAULT 50
)
RETURNS TABLE (
  id             uuid,
  name           text,
  phone          text,
  business_name  text,
  address        text,
  city           text,
  state          text,
  pincode        text,
  role           text,
  approved       boolean,
  retailer_code  text,
  total_count    bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_caller_role text;
  v_query       text;
BEGIN
  -- Authorization: only admin or delivery can call this
  SELECT p.role INTO v_caller_role
    FROM public.profiles p
   WHERE p.id = auth.uid();

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'delivery') THEN
    RAISE EXCEPTION 'not_authorized'
      USING HINT = 'Only admin or delivery staff can search retailers';
  END IF;

  -- Clamp page_size to a reasonable max
  IF p_page_size > 100 THEN
    p_page_size := 100;
  END IF;
  IF p_page_size < 1 THEN
    p_page_size := 50;
  END IF;

  -- Normalize search query
  v_query := NULLIF(trim(COALESCE(p_query, '')), '');

  IF v_query IS NULL THEN
    -- No search term: return all retailers ordered by name, paginated
    RETURN QUERY
      SELECT
        pr.id,
        pr.name,
        pr.phone,
        pr.business_name,
        pr.address,
        pr.city,
        pr.state,
        pr.pincode,
        pr.role,
        pr.approved,
        pr.retailer_code,
        COUNT(*) OVER() AS total_count
      FROM public.profiles pr
      WHERE pr.role = 'retailer'
      ORDER BY pr.name ASC NULLS LAST, pr.business_name ASC NULLS LAST
      LIMIT p_page_size
      OFFSET p_offset;
  ELSIF p_search_by_code THEN
    -- Search by retailer_code (party code)
    RETURN QUERY
      SELECT
        pr.id,
        pr.name,
        pr.phone,
        pr.business_name,
        pr.address,
        pr.city,
        pr.state,
        pr.pincode,
        pr.role,
        pr.approved,
        pr.retailer_code,
        COUNT(*) OVER() AS total_count
      FROM public.profiles pr
      WHERE pr.role = 'retailer'
        AND pr.retailer_code ILIKE '%' || v_query || '%'
      ORDER BY pr.retailer_code ASC NULLS LAST
      LIMIT p_page_size
      OFFSET p_offset;
  ELSE
    -- Search by party name (name + business_name)
    RETURN QUERY
      SELECT
        pr.id,
        pr.name,
        pr.phone,
        pr.business_name,
        pr.address,
        pr.city,
        pr.state,
        pr.pincode,
        pr.role,
        pr.approved,
        pr.retailer_code,
        COUNT(*) OVER() AS total_count
      FROM public.profiles pr
      WHERE pr.role = 'retailer'
        AND (
          pr.name ILIKE '%' || v_query || '%'
          OR pr.business_name ILIKE '%' || v_query || '%'
        )
      ORDER BY pr.name ASC NULLS LAST, pr.business_name ASC NULLS LAST
      LIMIT p_page_size
      OFFSET p_offset;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.search_retailers(text, boolean, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_retailers(text, boolean, int, int) TO authenticated;

COMMIT;
