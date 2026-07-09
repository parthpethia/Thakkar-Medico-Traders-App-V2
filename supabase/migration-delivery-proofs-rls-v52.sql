-- =============================================================================
-- Thakkar Medico — V52: Make OTP columns nullable & add delivery RLS write policy
--
-- Run in: Supabase Dashboard → SQL Editor → New query → Run
-- =============================================================================

BEGIN;

-- 1. Make OTP columns nullable since OTP is no longer required for delivery
ALTER TABLE public.delivery_proofs
  ALTER COLUMN otp_code_hash DROP NOT NULL,
  ALTER COLUMN otp_expires_at DROP NOT NULL;

-- 2. Add INSERT policy for delivery drivers
DROP POLICY IF EXISTS "delivery_proofs_insert_delivery" ON public.delivery_proofs;
CREATE POLICY "delivery_proofs_insert_delivery" ON public.delivery_proofs
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.orders o
      WHERE o.id = delivery_proofs.order_id
        AND o.assigned_to = (SELECT auth.uid())
    )
  );

-- 3. Add UPDATE policy for delivery drivers
DROP POLICY IF EXISTS "delivery_proofs_update_delivery" ON public.delivery_proofs;
CREATE POLICY "delivery_proofs_update_delivery" ON public.delivery_proofs
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.orders o
      WHERE o.id = delivery_proofs.order_id
        AND o.assigned_to = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.orders o
      WHERE o.id = delivery_proofs.order_id
        AND o.assigned_to = (SELECT auth.uid())
    )
  );

COMMIT;
