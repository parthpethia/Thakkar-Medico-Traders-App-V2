-- =============================================================================
-- Thakkar Medico — V49: Add Retailer Code to Profiles
--
-- Run in: Supabase Dashboard → SQL Editor → New query → Run
-- =============================================================================

BEGIN;

-- 1. Add retailer_code column to profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS retailer_code text;

-- 2. Create unique index on retailer_code
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_retailer_code_unique
  ON public.profiles (retailer_code)
  WHERE retailer_code IS NOT NULL AND retailer_code != '';

-- 3. Update handle_new_user trigger function to read retailer_code from metadata
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (
    id,
    email,
    phone,
    name,
    business_name,
    gstin,
    address,
    city,
    state,
    pincode,
    role,
    approved,
    retailer_code
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
    COALESCE(NEW.raw_user_meta_data ->> 'role', 'retailer'),
    COALESCE((NEW.raw_user_meta_data ->> 'approved')::boolean, false),
    NULLIF(TRIM(COALESCE(NEW.raw_user_meta_data ->> 'retailer_code', '')), '')
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
    pincode = COALESCE(NULLIF(EXCLUDED.pincode, ''), public.profiles.pincode),
    retailer_code = COALESCE(NULLIF(EXCLUDED.retailer_code, ''), public.profiles.retailer_code);
  RETURN NEW;
END;
$$;

-- 4. Create get_email_by_retailer_code RPC lookup function
CREATE OR REPLACE FUNCTION public.get_email_by_retailer_code(p_retailer_code text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text;
BEGIN
  SELECT email INTO v_email
  FROM public.profiles
  WHERE lower(retailer_code) = lower(p_retailer_code)
  LIMIT 1;

  RETURN v_email;  -- NULL if not found
END;
$$;

REVOKE ALL ON FUNCTION public.get_email_by_retailer_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_email_by_retailer_code(text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_email_by_retailer_code(text) TO authenticated;

COMMIT;
