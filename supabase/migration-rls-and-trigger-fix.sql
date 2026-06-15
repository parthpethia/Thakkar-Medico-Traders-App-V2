-- =============================================================================
-- Thakkar Medico Traders — Fix RLS Policy and Update handle_new_user Trigger
-- Run in: Supabase Dashboard → SQL Editor → New query → Run
-- 
-- PURPOSE:
--   1. Drop permissive leftover policy `authenticated_can_read_profiles` on public.profiles.
--   2. Update trigger function `public.handle_new_user()` to pull all retailer
--      details (business details, address, state, etc.) from `raw_user_meta_data`.
--      This bypasses client-side RLS limits for unconfirmed accounts.
-- =============================================================================

-- =============================================================================
-- STEP 1: DROP PERMISSIVE RLS POLICY
-- =============================================================================
DROP POLICY IF EXISTS "authenticated_can_read_profiles" ON public.profiles;

-- =============================================================================
-- STEP 2: UPDATE handle_new_user TRIGGER FUNCTION
-- =============================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (
    id, email, phone, name, business_name, gstin, address, city, state, pincode, role, approved
  )
  VALUES (
    NEW.id,
    NEW.email,
    NULLIF(TRIM(COALESCE(NEW.raw_user_meta_data ->> 'phone', '')), ''),
    COALESCE(NEW.raw_user_meta_data ->> 'name', ''),
    COALESCE(NEW.raw_user_meta_data ->> 'business_name', ''),
    COALESCE(NEW.raw_user_meta_data ->> 'gstin', ''),
    COALESCE(NEW.raw_user_meta_data ->> 'address', ''),
    COALESCE(NEW.raw_user_meta_data ->> 'city', ''),
    COALESCE(NEW.raw_user_meta_data ->> 'state', ''),
    COALESCE(NEW.raw_user_meta_data ->> 'pincode', ''),
    'retailer',
    false
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    phone = COALESCE(NULLIF(EXCLUDED.phone, ''), public.profiles.phone),
    name  = COALESCE(NULLIF(EXCLUDED.name, ''),  public.profiles.name),
    business_name = COALESCE(NULLIF(EXCLUDED.business_name, ''), public.profiles.business_name),
    gstin = COALESCE(NULLIF(EXCLUDED.gstin, ''), public.profiles.gstin),
    address = COALESCE(NULLIF(EXCLUDED.address, ''), public.profiles.address),
    city = COALESCE(NULLIF(EXCLUDED.city, ''), public.profiles.city),
    state = COALESCE(NULLIF(EXCLUDED.state, ''), public.profiles.state),
    pincode = COALESCE(NULLIF(EXCLUDED.pincode, ''), public.profiles.pincode);
  RETURN NEW;
END;
$$;
