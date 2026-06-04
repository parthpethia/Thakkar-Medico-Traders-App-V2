-- =============================================================================
-- Thakkar Medico Traders — Migrate to EMAIL-PRIMARY authentication
-- Run in: Supabase Dashboard → SQL Editor → New query → Run
-- 
-- PURPOSE:
--   1. Roll back old phone-based password-reset objects
--   2. Make email the primary Supabase Auth identity
--   3. Add phone-to-email lookup RPC so users can still log in with phone
--   4. Fresh password-reset audit table (email-based)
--
-- PREREQUISITES (Supabase Dashboard → Authentication → Providers):
--   • Email → ENABLED, "Confirm email" → OFF (immediate login after signup)
--   • Phone → can be DISABLED (no longer used for Supabase Auth)
-- =============================================================================

-- =============================================================================
-- STEP 1: ROLLBACK OLD PASSWORD-RESET OBJECTS
-- =============================================================================

-- Drop old RPC
DROP FUNCTION IF EXISTS public.log_password_reset_event(text);

-- Drop old password_reset_events table
DROP TABLE IF EXISTS public.password_reset_events;

-- Drop old email index (will recreate a better one)
DROP INDEX IF EXISTS public.idx_profiles_email;

-- =============================================================================
-- STEP 2: ALTER PROFILES TABLE FOR EMAIL-PRIMARY AUTH
-- =============================================================================

-- Ensure email column exists (it already does from setup.sql, but be safe)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'profiles'
      AND column_name = 'email'
  ) THEN
    ALTER TABLE public.profiles ADD COLUMN email text;
  END IF;
END $$;

-- Make phone column nullable (it's no longer the primary auth field)
ALTER TABLE public.profiles ALTER COLUMN phone DROP NOT NULL;

-- Add unique constraint on email for login lookups
-- (Use a partial unique index so NULL emails don't conflict)
DROP INDEX IF EXISTS public.idx_profiles_email_unique;
CREATE UNIQUE INDEX idx_profiles_email_unique
  ON public.profiles (lower(email))
  WHERE email IS NOT NULL AND email != '';

-- Add unique index on phone for phone-to-email lookups
DROP INDEX IF EXISTS public.idx_profiles_phone_unique;
CREATE UNIQUE INDEX idx_profiles_phone_unique
  ON public.profiles (phone)
  WHERE phone IS NOT NULL AND phone != '';

-- =============================================================================
-- STEP 3: PHONE-TO-EMAIL LOOKUP RPC
-- =============================================================================
-- Called by the app when a user logs in with their phone number.
-- Returns just the email — no other data leaks.
-- Callable by anon (before sign-in, user has no session yet).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_email_by_phone(p_phone text)
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
  WHERE phone = p_phone
  LIMIT 1;

  RETURN v_email;  -- NULL if not found
END;
$$;

REVOKE ALL ON FUNCTION public.get_email_by_phone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_email_by_phone(text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_email_by_phone(text) TO authenticated;

-- =============================================================================
-- STEP 4: UPDATE handle_new_user TRIGGER (email-primary)
-- =============================================================================
-- Now reads NEW.email (primary auth field) and phone from user_metadata.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, phone, name, role, approved)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data ->> 'phone', ''),
    COALESCE(NEW.raw_user_meta_data ->> 'name', ''),
    'retailer',
    false
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    phone = COALESCE(NULLIF(EXCLUDED.phone, ''), public.profiles.phone),
    name  = COALESCE(NULLIF(EXCLUDED.name, ''),  public.profiles.name);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- =============================================================================
-- STEP 5: FRESH PASSWORD RESET AUDIT TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.password_reset_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  email text NOT NULL DEFAULT '',
  event_type text NOT NULL CHECK (event_type IN ('otp_sent', 'password_changed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.password_reset_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "password_reset_events_insert_own" ON public.password_reset_events;
CREATE POLICY "password_reset_events_insert_own" ON public.password_reset_events
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "password_reset_events_select_own" ON public.password_reset_events;
CREATE POLICY "password_reset_events_select_own" ON public.password_reset_events
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "password_reset_events_select_admin" ON public.password_reset_events;
CREATE POLICY "password_reset_events_select_admin" ON public.password_reset_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

-- Simple audit logger (optional, called from app after password change)
CREATE OR REPLACE FUNCTION public.log_password_reset_event(p_event_type text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text;
BEGIN
  IF p_event_type NOT IN ('otp_sent', 'password_changed') THEN
    RAISE EXCEPTION 'Invalid event_type';
  END IF;

  SELECT email INTO v_email FROM public.profiles WHERE id = auth.uid();
  IF v_email IS NULL OR v_email = '' THEN
    v_email := COALESCE(
      (SELECT email FROM auth.users WHERE id = auth.uid()),
      ''
    );
  END IF;

  INSERT INTO public.password_reset_events (user_id, email, event_type)
  VALUES (auth.uid(), v_email, p_event_type);
END;
$$;

REVOKE ALL ON FUNCTION public.log_password_reset_event(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_password_reset_event(text) TO authenticated;

-- =============================================================================
-- DONE
-- =============================================================================
-- After running this migration:
--   1. Go to Supabase Dashboard → Authentication → Providers
--   2. Enable Email provider (set "Confirm email" to OFF)
--   3. Phone provider can now be DISABLED
--   4. Test: register with email + password, login with email or phone
-- =============================================================================
