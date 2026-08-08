-- =============================================================================
-- Thakkar Medico — V64: Invoice OCR Tables RLS, Storage Bucket RLS, Order Index & Observability View
--
-- Run in: Supabase Dashboard → SQL Editor → New query → Run
-- =============================================================================

BEGIN;

-- 1. Add invoice_number column to orders table if not present
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS invoice_number TEXT;

-- Index for per-retailer indexed duplicate invoice checks
CREATE INDEX IF NOT EXISTS idx_orders_user_invoice_number ON public.orders(user_id, invoice_number);

-- Enable Row Level Security (RLS) on OCR tables
ALTER TABLE public.invoice_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_extractions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_validation_logs ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 2. Storage Bucket & Policies for 'invoice-uploads'
-- -----------------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public)
VALUES ('invoice-uploads', 'invoice-uploads', true)
ON CONFLICT (id) DO UPDATE SET public = true;

DROP POLICY IF EXISTS "Allow authenticated staff to insert invoice uploads" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated staff to select invoice uploads" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated staff to update invoice uploads" ON storage.objects;

CREATE POLICY "Allow authenticated staff to insert invoice uploads"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'invoice-uploads'
);

CREATE POLICY "Allow authenticated staff to select invoice uploads"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'invoice-uploads'
);

CREATE POLICY "Allow authenticated staff to update invoice uploads"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'invoice-uploads'
);

-- -----------------------------------------------------------------------------
-- 3. invoice_uploads Policies
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS "invoice_uploads_owner_select" ON public.invoice_uploads;
DROP POLICY IF EXISTS "invoice_uploads_owner_insert" ON public.invoice_uploads;
DROP POLICY IF EXISTS "invoice_uploads_owner_update" ON public.invoice_uploads;

CREATE POLICY "invoice_uploads_owner_select" ON public.invoice_uploads
  FOR SELECT TO authenticated
  USING (
    uploaded_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND (p.role = 'admin' OR p.role = 'delivery')
    )
  );

CREATE POLICY "invoice_uploads_owner_insert" ON public.invoice_uploads
  FOR INSERT TO authenticated
  WITH CHECK (
    uploaded_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND (p.role = 'admin' OR p.role = 'delivery')
    )
  );

CREATE POLICY "invoice_uploads_owner_update" ON public.invoice_uploads
  FOR UPDATE TO authenticated
  USING (
    uploaded_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND (p.role = 'admin' OR p.role = 'delivery')
    )
  )
  WITH CHECK (
    uploaded_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND (p.role = 'admin' OR p.role = 'delivery')
    )
  );

-- -----------------------------------------------------------------------------
-- 4. invoice_extractions Policies
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS "invoice_extractions_owner_select" ON public.invoice_extractions;
DROP POLICY IF EXISTS "invoice_extractions_owner_update" ON public.invoice_extractions;

CREATE POLICY "invoice_extractions_owner_select" ON public.invoice_extractions
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.invoice_uploads u
      WHERE u.id = invoice_upload_id AND (
        u.uploaded_by = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = auth.uid() AND (p.role = 'admin' OR p.role = 'delivery')
        )
      )
    )
  );

CREATE POLICY "invoice_extractions_owner_update" ON public.invoice_extractions
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.invoice_uploads u
      WHERE u.id = invoice_upload_id AND (
        u.uploaded_by = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = auth.uid() AND (p.role = 'admin' OR p.role = 'delivery')
        )
      )
    )
  );

-- -----------------------------------------------------------------------------
-- 5. invoice_validation_logs Policies
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS "invoice_validation_logs_owner_select" ON public.invoice_validation_logs;
DROP POLICY IF EXISTS "invoice_validation_logs_owner_insert" ON public.invoice_validation_logs;

CREATE POLICY "invoice_validation_logs_owner_select" ON public.invoice_validation_logs
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.invoice_extractions e
      JOIN public.invoice_uploads u ON u.id = e.invoice_upload_id
      WHERE e.id = extraction_id AND (
        u.uploaded_by = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = auth.uid() AND (p.role = 'admin' OR p.role = 'delivery')
        )
      )
    )
  );

CREATE POLICY "invoice_validation_logs_owner_insert" ON public.invoice_validation_logs
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.invoice_extractions e
      JOIN public.invoice_uploads u ON u.id = e.invoice_upload_id
      WHERE e.id = extraction_id AND (
        u.uploaded_by = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = auth.uid() AND (p.role = 'admin' OR p.role = 'delivery')
        )
      )
    )
  );

-- -----------------------------------------------------------------------------
-- 6. Observability View for Low Confidence Extractions
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.low_confidence_extractions_view AS
SELECT 
  e.id AS extraction_id,
  e.invoice_upload_id,
  u.uploaded_by,
  e.confidence_score,
  (e.parsed_json->'party'->>'name') AS party_name,
  (e.parsed_json->'invoice'->>'number') AS invoice_number,
  (e.parsed_json->>'readability_score')::numeric AS readability_score,
  (e.parsed_json->>'is_truncated')::boolean AS is_truncated,
  e.validation_status,
  e.created_at
FROM public.invoice_extractions e
JOIN public.invoice_uploads u ON u.id = e.invoice_upload_id
WHERE e.confidence_score < 0.70 OR (e.parsed_json->>'readability_score')::numeric < 0.60 OR e.validation_status = 'warning'
ORDER BY e.created_at DESC;

COMMIT;
