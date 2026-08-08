-- =============================================================================
-- Thakkar Medico — V61: Fix Orders Profiles Foreign Key Constraints
--
-- Adds foreign key constraints between:
--   1. public.orders(user_id) -> public.profiles(id)
--   2. public.orders(assigned_to) -> public.profiles(id)
--
-- This enables PostgREST/Supabase to join orders and profiles table.
-- =============================================================================

BEGIN;

-- 1. Add user_id foreign key constraint if it doesn't exist
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_user_id_fkey;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- 2. Add assigned_to (rider) foreign key constraint if it doesn't exist
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_rider_id_fkey;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_rider_id_fkey FOREIGN KEY (assigned_to) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- 3. Grant SELECT on order_items to authenticated (required by mobile app returns and admin dashboard)
GRANT SELECT ON public.order_items TO authenticated;

COMMIT;
