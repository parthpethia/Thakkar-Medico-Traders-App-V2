-- =============================================================================
-- Thakkar Medico Traders — Supabase database setup (EMAIL-PRIMARY AUTH)
-- Run in: Supabase Dashboard → SQL Editor → New query → Run
-- Project: dbmnznmuomansrivyvfy (or your project)
-- =============================================================================
-- 
-- AUTH MODEL:
--   • Primary identity: EMAIL + PASSWORD (Supabase Email Auth)
--   • Phone number: stored in profiles table, used as alternative login ID
--   • Login: user enters email OR phone → app resolves to email → signInWithPassword
--   • Password reset: Supabase sends OTP to email → user verifies → sets new password
--
-- DASHBOARD SETUP (Authentication → Providers):
--   • Email → ENABLED, "Confirm email" → OFF
--   • Phone → DISABLED (not used for auth)
-- =============================================================================

-- Fix dashboard migration error (if schema was never created)
CREATE SCHEMA IF NOT EXISTS supabase_migrations;

CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
  version text PRIMARY KEY,
  statements text[],
  name text
);

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================================
-- TABLES
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  email text,
  phone text,
  name text,
  business_name text,
  gstin text,
  address text,
  city text,
  state text,
  pincode text,
  role text NOT NULL DEFAULT 'retailer' CHECK (role IN ('admin', 'retailer', 'delivery')),
  approved boolean NOT NULL DEFAULT false,
  loyalty_points integer NOT NULL DEFAULT 0,
  credit_limit numeric NOT NULL DEFAULT 0,
  credit_used numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Unique indexes for login lookups
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_email_unique
  ON public.profiles (lower(email))
  WHERE email IS NOT NULL AND email != '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_phone_unique
  ON public.profiles (phone)
  WHERE phone IS NOT NULL AND phone != '';

CREATE TABLE IF NOT EXISTS public.categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  is_active boolean DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  company text,
  sku text NOT NULL,
  pack_size text,
  image text,
  mrp numeric NOT NULL DEFAULT 0,
  selling_price numeric NOT NULL DEFAULT 0,
  gst_percent numeric NOT NULL DEFAULT 0,
  stock_quantity integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.cart_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products (id) ON DELETE CASCADE,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, product_id)
);

CREATE TABLE IF NOT EXISTS public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number text NOT NULL,
  user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  user_name text,
  user_phone text,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  subtotal numeric NOT NULL DEFAULT 0,
  gst numeric NOT NULL DEFAULT 0,
  grand_total numeric NOT NULL DEFAULT 0,
  delivery_address text,
  delivery_type text DEFAULT 'delivery',
  payment_mode text DEFAULT 'cod',
  notes text,
  cancellation_requested boolean DEFAULT false,
  cancellation_reason text,
  cancellation_requested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gst_enabled boolean NOT NULL DEFAULT true,
  credit_enabled boolean NOT NULL DEFAULT true,
  loyalty_enabled boolean NOT NULL DEFAULT true,
  delivery_enabled boolean NOT NULL DEFAULT true,
  show_prices_to_unverified boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.stock_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.products (id) ON DELETE CASCADE,
  change integer NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Password reset audit
CREATE TABLE IF NOT EXISTS public.password_reset_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  email text NOT NULL DEFAULT '',
  event_type text NOT NULL CHECK (event_type IN ('otp_sent', 'password_changed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- PHONE-TO-EMAIL LOOKUP RPC
-- =============================================================================
-- Called by the app when a user logs in with their phone number.
-- Returns just the email so the app can call signInWithPassword({ email, password }).
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
-- PROFILE ON SIGNUP (email-primary)
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

-- Password reset audit logger
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
-- ROW LEVEL SECURITY
-- =============================================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cart_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.password_reset_events ENABLE ROW LEVEL SECURITY;

-- Profiles
DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
CREATE POLICY "profiles_select_own" ON public.profiles
  FOR SELECT TO authenticated
  USING (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_select_staff" ON public.profiles;
CREATE POLICY "profiles_select_staff" ON public.profiles
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role IN ('admin', 'delivery')
    )
  );

DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;
CREATE POLICY "profiles_insert_own" ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE TO authenticated
  USING (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_update_admin" ON public.profiles;
CREATE POLICY "profiles_update_admin" ON public.profiles
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

-- Categories & products: read for authenticated; write for admin
DROP POLICY IF EXISTS "categories_read" ON public.categories;
CREATE POLICY "categories_read" ON public.categories
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "products_read" ON public.products;
CREATE POLICY "products_read" ON public.products
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "products_write_admin" ON public.products;
CREATE POLICY "products_write_admin" ON public.products
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

-- Cart
DROP POLICY IF EXISTS "cart_own" ON public.cart_items;
CREATE POLICY "cart_own" ON public.cart_items
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Orders
DROP POLICY IF EXISTS "orders_select_own" ON public.orders;
CREATE POLICY "orders_select_own" ON public.orders
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "orders_select_staff" ON public.orders;
CREATE POLICY "orders_select_staff" ON public.orders
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role IN ('admin', 'delivery')
    )
  );

DROP POLICY IF EXISTS "orders_insert_own" ON public.orders;
CREATE POLICY "orders_insert_own" ON public.orders
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "orders_update_staff" ON public.orders;
CREATE POLICY "orders_update_staff" ON public.orders
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role IN ('admin', 'delivery')
    )
  );

-- Settings: read all authenticated; write admin
DROP POLICY IF EXISTS "settings_read" ON public.settings;
CREATE POLICY "settings_read" ON public.settings
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "settings_write_admin" ON public.settings;
CREATE POLICY "settings_write_admin" ON public.settings
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

-- Stock history
DROP POLICY IF EXISTS "stock_history_read" ON public.stock_history;
CREATE POLICY "stock_history_read" ON public.stock_history
  FOR SELECT TO authenticated
  USING (true);

-- Password reset events
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

-- =============================================================================
-- SEED DATA
-- =============================================================================

INSERT INTO public.settings (id, gst_enabled, credit_enabled, loyalty_enabled, delivery_enabled, show_prices_to_unverified)
VALUES (
  'd0d9e798-e760-449e-ba23-93374828b6d8',
  true,
  true,
  true,
  true,
  true
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.categories (name)
VALUES ('Tablets'), ('Syrups'), ('Injections'), ('OTC')
ON CONFLICT (name) DO NOTHING;

-- =============================================================================
-- Supabase Auth providers (Dashboard → Authentication → Providers):
--   Email → ENABLED, "Confirm email" → OFF
--   Phone → DISABLED (not used for auth, phone is stored in profiles only)
--
-- Login flow:
--   User enters email → signInWithPassword({ email, password })
--   User enters phone → RPC get_email_by_phone → signInWithPassword({ email, password })
--
-- Password reset flow:
--   resetPasswordForEmail(email) → OTP email sent → verifyOtp(recovery) → updateUser({ password })
-- =============================================================================
