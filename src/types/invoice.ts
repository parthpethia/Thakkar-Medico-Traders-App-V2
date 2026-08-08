/* ======================================================
   PHOTO-TO-ORDER (BILL OCR) TYPES
====================================================== */

export interface ExtractedParty {
  code: string | null;
  name: string | null;
  gst: string | null;
  address: string | null;
}

export interface ExtractedHeader {
  number: string | null;
  date: string | null;
}

export interface ExtractedItem {
  product_name: string | null;
  product_code: string | null;
  batch: string | null;
  expiry: string | null;
  quantity: number;
  free_quantity: number;
  rate: number;
  discount: number;
  gst: number;
  amount: number;
}

export interface ExtractedTotals {
  subtotal: number;
  gst_total: number;
  discount_total: number;
  round_off: number;
  grand_total: number;
}

export interface ExtractedInvoice {
  party: ExtractedParty;
  invoice: ExtractedHeader;
  items: ExtractedItem[];
  totals: ExtractedTotals;
}

export type ProcessingStatus =
  | 'uploaded'
  | 'extracted'
  | 'validated'
  | 'completed'
  | 'failed';

export type ValidationStatus =
  | 'pending'
  | 'success'
  | 'warning'
  | 'failed';

export interface InvoiceUpload {
  id: string;
  uploaded_by: string | null;
  storage_path: string;
  file_name: string;
  file_type: string;
  upload_time: string;
  processing_status: ProcessingStatus;
  linked_order_id?: string | null;
  created_at: string;
}

export interface InvoiceExtraction {
  id: string;
  invoice_upload_id: string;
  extraction_provider: string;
  raw_json: Record<string, unknown>;
  parsed_json: ExtractedInvoice;
  edited_json?: ExtractedInvoice | null;
  confidence_score: number;
  validation_status: ValidationStatus;
  created_at: string;
}

export interface InvoiceValidationLog {
  id: string;
  extraction_id: string;
  field_name: string;
  extracted_value?: string | null;
  matched_value?: string | null;
  validation_result: 'match' | 'warning' | 'error';
  notes?: string | null;
  created_at: string;
}
