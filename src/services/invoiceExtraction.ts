import * as ImagePicker from 'expo-image-picker';
import { v4 as uuidv4 } from 'uuid';
import { supabase } from './supabase';
import type { ExtractedInvoice, InvoiceExtraction, ProcessingStatus } from '../types/invoice';

export type { ExtractedInvoice };

export interface FieldConfidences {
  party?: { code?: number; name?: number; gst?: number; address?: number };
  invoice?: { number?: number; date?: number };
  items?: Array<{
    product_name?: number;
    product_code?: number;
    batch?: number;
    expiry?: number;
    quantity?: number;
    free_quantity?: number;
    rate?: number;
    discount?: number;
    gst?: number;
    amount?: number;
  }>;
  totals?: {
    subtotal?: number;
    gst_total?: number;
    discount_total?: number;
    round_off?: number;
    grand_total?: number;
  };
}

export interface ExtractionResult {
  parsedData: ExtractedInvoice;
  confidenceScores?: FieldConfidences;
  overallConfidence: number;
  rawResponseText: string;
}

export interface InvoiceExtractionProvider {
  name: string;
  extract(rawInput: string | ArrayBuffer): Promise<ExtractionResult>;
}

/**
 * Tolerant JSON parser to clean common errors in LLM generated strings or manual pastes.
 */
export function cleanAndParseJson(text: string): any {
  let cleaned = text.trim();

  // Remove markdown code blocks if present
  const markdownRegex = /```(?:json)?\s*([\s\S]*?)\s*```/i;
  const match = cleaned.match(markdownRegex);
  if (match) {
    cleaned = match[1].trim();
  }

  // Find first '{' and last '}' to strip surrounding conversational text
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  }

  // Remove trailing commas in arrays/objects which crash JSON.parse
  cleaned = cleaned.replace(/,\s*([\]}])/g, '$1');

  try {
    return JSON.parse(cleaned);
  } catch (error: any) {
    throw new Error(`Failed to parse JSON even after cleaning: ${error.message}. Original text: ${text.slice(0, 100)}...`);
  }
}

/**
 * Normalizes values to match the target schema, filling missing fields with defaults.
 */
export function normalizeExtractedInvoice(json: any): ExtractedInvoice {
  const party = json.party || {};
  const invoice = json.invoice || {};
  const rawItems = Array.isArray(json.items) ? json.items : [];
  const totals = json.totals || {};

  return {
    party: {
      code: String(party.code || '').trim(),
      name: String(party.name || '').trim(),
      gst: String(party.gst || '').trim(),
      address: String(party.address || '').trim(),
    },
    invoice: {
      number: String(invoice.number || '').trim(),
      date: String(invoice.date || '').trim(),
    },
    items: rawItems.map((item: any) => ({
      product_name: String(item.product_name || item.name || '').trim(),
      product_code: String(item.product_code || item.sku || item.code || '').trim(),
      batch: String(item.batch || '').trim(),
      expiry: String(item.expiry || '').trim(),
      quantity: Number(item.quantity || 0),
      free_quantity: Number(item.free_quantity || 0),
      rate: Number(item.rate || item.price || item.selling_price || 0),
      discount: Number(item.discount || 0),
      gst: Number(item.gst || item.gst_percent || 0),
      amount: Number(item.amount || item.total || 0),
    })),
    totals: {
      subtotal: Number(totals.subtotal || 0),
      gst_total: Number(totals.gst_total || totals.gst || 0),
      discount_total: Number(totals.discount_total || totals.discount || 0),
      round_off: Number(totals.round_off || 0),
      grand_total: Number(totals.grand_total || totals.total || 0),
    },
  };
}

/**
 * Manual provider that takes pasted JSON text and processes it.
 */
export class ManualJsonProvider implements InvoiceExtractionProvider {
  name = 'ManualJsonProvider';

  async extract(rawInput: string): Promise<ExtractionResult> {
    if (typeof rawInput !== 'string') {
      throw new Error('ManualJsonProvider only supports string input');
    }

    const parsedRaw = cleanAndParseJson(rawInput);
    const normalized = normalizeExtractedInvoice(parsedRaw);

    const confidenceScores: FieldConfidences = {
      party: { code: 1.0, name: 1.0, gst: 1.0, address: 1.0 },
      invoice: { number: 1.0, date: 1.0 },
      items: normalized.items.map(() => ({
        product_name: 1.0,
        product_code: 1.0,
        batch: 1.0,
        expiry: 1.0,
        quantity: 1.0,
        free_quantity: 1.0,
        rate: 1.0,
        discount: 1.0,
        gst: 1.0,
        amount: 1.0,
      })),
      totals: {
        subtotal: 1.0,
        gst_total: 1.0,
        discount_total: 1.0,
        round_off: 1.0,
        grand_total: 1.0,
      },
    };

    return {
      parsedData: normalized,
      confidenceScores,
      overallConfidence: 1.0,
      rawResponseText: rawInput,
    };
  }
}

/* ================= PHOTO-TO-ORDER UTILITIES ================= */

export interface PickedImage {
  uri: string;
  name: string;
  type: string;
}

/**
 * Prompt user to pick an image from camera or photo library using expo-image-picker.
 */
export async function pickOrCaptureInvoiceImage(
  source: 'camera' | 'library' = 'camera'
): Promise<PickedImage | null> {
  if (source === 'camera') {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      throw new Error('Camera permission is required to capture bill photo');
    }

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      quality: 0.8,
      allowsEditing: false,
    });

    if (result.canceled || !result.assets || result.assets.length === 0) {
      return null;
    }

    const asset = result.assets[0];
    const name = asset.fileName || `bill_${Date.now()}.jpg`;
    return {
      uri: asset.uri,
      name,
      type: asset.mimeType || 'image/jpeg',
    };
  } else {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      throw new Error('Media library permission is required to select bill photo');
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.8,
      allowsEditing: false,
    });

    if (result.canceled || !result.assets || result.assets.length === 0) {
      return null;
    }

    const asset = result.assets[0];

    // Image Resolution Quality Gate: Minimum 600x600px
    if (asset.width && asset.height && (asset.width < 600 || asset.height < 600)) {
      throw new Error(`Image resolution is too low (${asset.width}x${asset.height}px). Minimum required resolution is 600x600px for reliable AI OCR reading. Please retake a higher quality photo.`);
    }

    const name = asset.fileName || `bill_${Date.now()}.jpg`;
    return {
      uri: asset.uri,
      name,
      type: asset.mimeType || 'image/jpeg',
    };
  }
}

/**
 * Uploads local image URI to Supabase Storage bucket 'invoice-uploads' and inserts record in invoice_uploads.
 */
export async function uploadInvoiceImage(
  uri: string,
  uploadedBy: string,
  fileName?: string
): Promise<string> {
  if (!uri) throw new Error('Image URI is required for upload');

  const fileExt = (fileName || uri).split('.').pop()?.toLowerCase() || 'jpg';
  const cleanExt = ['jpg', 'jpeg', 'png', 'webp', 'pdf'].includes(fileExt) ? fileExt : 'jpg';
  const uniqueName = `${uuidv4()}.${cleanExt}`;
  const storagePath = `${uploadedBy}/${uniqueName}`;
  const mimeType = cleanExt === 'png' ? 'image/png' : cleanExt === 'webp' ? 'image/webp' : 'image/jpeg';

  const response = await fetch(uri);
  const blob = await response.blob();

  // Client-side Image Quality Gate: Reject unreadable or corrupt photos (< 15KB)
  if (blob.size < 15000) {
    throw new Error('Image file is too small or blurry (less than 15KB). Please retake a clear, well-lit photo of the bill.');
  }

  // Convert Blob to ArrayBuffer for native React Native compatibility
  let arrayBuffer: ArrayBuffer;
  try {
    arrayBuffer = await new Response(blob).arrayBuffer();
  } catch {
    arrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        if (reader.result instanceof ArrayBuffer) {
          resolve(reader.result);
        } else {
          reject(new Error('Failed to convert image blob to ArrayBuffer'));
        }
      };
      reader.onerror = () => reject(new Error('FileReader error reading image blob'));
      reader.readAsArrayBuffer(blob);
    });
  }

  // 1. Upload file binary (ArrayBuffer) to Supabase Storage bucket 'invoice-uploads'
  const { error: uploadError } = await supabase.storage
    .from('invoice-uploads')
    .upload(storagePath, arrayBuffer, {
      contentType: mimeType,
      cacheControl: '3600',
      upsert: true,
    });

  if (uploadError) {
    if (uploadError.message?.toLowerCase().includes('row-level security')) {
      throw new Error("Storage RLS Policy Missing: Please run 'migration-invoice-ocr-rls-v64.sql' in your Supabase SQL Editor to enable bucket permissions for 'invoice-uploads'.");
    }
    throw new Error(`Failed to upload bill image to storage: ${uploadError.message}`);
  }

  // 2. Insert tracking record into invoice_uploads table
  const { data: record, error: dbError } = await supabase
    .from('invoice_uploads')
    .insert({
      uploaded_by: uploadedBy,
      storage_path: storagePath,
      file_name: fileName || uniqueName,
      file_type: mimeType,
      processing_status: 'uploaded',
    })
    .select('id')
    .single();

  if (dbError || !record) {
    // Cleanup storage file on DB error
    await supabase.storage.from('invoice-uploads').remove([storagePath]).catch(() => {});
    throw new Error(`Failed to save invoice upload record: ${dbError?.message || 'Unknown DB error'}`);
  }

  return record.id;
}

/**
 * Triggers the extract-invoice Supabase Edge Function to parse the uploaded invoice via Gemini Vision.
 * Automatically falls back to client-side Gemini API invocation if Edge Function is not deployed (404).
 */
export async function triggerExtraction(invoiceUploadId: string): Promise<{
  success: boolean;
  extraction_id?: string;
  error?: string;
}> {
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData?.session?.access_token;
    const geminiEnvKey = getEffectiveGeminiApiKey();
    const headers: Record<string, string> = {};
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    if (geminiEnvKey) headers['x-gemini-api-key'] = geminiEnvKey;

    const { data, error } = await supabase.functions.invoke('extract-invoice', {
      body: { invoice_upload_id: invoiceUploadId },
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    });

    if (error) {
      let detailedMsg = error.message || 'Edge function invocation failed';
      try {
        if ('context' in error && typeof (error as any).context?.json === 'function') {
          const body = await (error as any).context.json();
          if (body?.message) detailedMsg = body.message;
          else if (body?.error) detailedMsg = body.error;
        }
      } catch {}

      // Fallback: If Edge Function is not deployed on Supabase Cloud (404 / Function Not Found), execute fallback client-side
      const isNotFound =
        detailedMsg.toLowerCase().includes('not found') ||
        error.message?.toLowerCase().includes('not found') ||
        (error as any).status === 404;

      if (isNotFound) {
        console.log('[Invoice OCR] Edge Function not found on Supabase Cloud. Running client-side Gemini OCR fallback...');
        return await extractInvoiceClientFallback(invoiceUploadId);
      }

      return { success: false, error: detailedMsg };
    }

    if (data && data.success === false) {
      return { success: false, error: data.message || data.error || 'Invoice extraction failed' };
    }

    return {
      success: true,
      extraction_id: data?.extraction_id,
    };
  } catch (err: any) {
    const isNotFound = err?.message?.toLowerCase().includes('not found');
    if (isNotFound) {
      return await extractInvoiceClientFallback(invoiceUploadId);
    }
    return { success: false, error: err.message || 'Failed to trigger extraction' };
  }
}

function getEffectiveGeminiApiKey(): string {
  return (process.env.EXPO_PUBLIC_GEMINI_API_KEY || '').trim();
}

/**
 * Fallback client-side Gemini Vision OCR parser when Supabase Edge Function is not deployed.
 */
async function extractInvoiceClientFallback(uploadId: string): Promise<{
  success: boolean;
  extraction_id?: string;
  error?: string;
}> {
  const geminiApiKey = getEffectiveGeminiApiKey();
  if (!geminiApiKey) {
    return {
      success: false,
      error: 'Google API Key is not configured in .env file. Please ensure EXPO_PUBLIC_GEMINI_API_KEY or EXPO_PUBLIC_GOOGLE_VISION_API_KEY is set.',
    };
  }

  try {
    // 1. Fetch upload record
    const { data: uploadRecord, error: uploadErr } = await supabase
      .from('invoice_uploads')
      .select('*')
      .eq('id', uploadId)
      .single();

    if (uploadErr || !uploadRecord) {
      return { success: false, error: 'Upload record not found' };
    }

    // 2. Download photo from Supabase Storage
    const { data: blobData, error: downloadErr } = await supabase.storage
      .from('invoice-uploads')
      .download(uploadRecord.storage_path);

    if (downloadErr || !blobData) {
      return { success: false, error: 'Failed to download bill photo from storage' };
    }

    // Convert Blob to Base64
    const base64Image = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const res = reader.result as string;
        const b64 = res.split(',')[1] || res;
        resolve(b64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blobData);
    });

    const mimeType = uploadRecord.file_type || 'image/jpeg';

    const modelsToTry = ['gemini-flash-latest', 'gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-pro-latest'];
    let res: Response | null = null;
    let lastErrStatus = 0;
    let lastErrTxt = '';
    let usedModel = 'gemini-flash-latest';

    const promptText = `
You are an expert OCR parser specialized in Indian pharmaceutical distributor invoices and wholesale bills.
CRITICAL RULES:
1. BUYER VS LETTERHEAD: Extract the BUYER ("Bill To"/"M/s" block) as 'party'. NEVER extract Thakkar Medico Traders.
2. HSN VS PRODUCT CODE: HSN / HSNCD codes (e.g. 3004, 300490) are GST tax classification codes, NOT product codes / SKUs. NEVER extract HSN / HSNCD column numbers as 'product_code'. Only extract 'product_code' if a distinct item/SKU code is printed (e.g. Item Code: 1042). If the bill only has an HSN code column and no distinct SKU code column, leave 'product_code' null.
3. NULL OVER HALLUCINATION: Return null for unreadable/missing values.
4. QUALITY & TRUNCATION: Return readability_score (0.0 to 1.0), image_quality_notes, is_multi_page, and is_truncated.
Return ONLY valid JSON with keys: readability_score, image_quality_notes, is_multi_page, is_truncated, party {code, name, gst, address}, invoice {number, date}, items [{product_name, product_code, batch, expiry, quantity, free_quantity, rate, discount, gst, amount}], totals {subtotal, gst_total, discount_total, round_off, grand_total}.
`;

    const geminiBody = {
      contents: [
        {
          parts: [
            { text: promptText },
            { inline_data: { mime_type: mimeType, data: base64Image } },
          ],
        },
      ],
      generationConfig: {
        response_mime_type: 'application/json',
      },
    };

    const encodedKey = encodeURIComponent(geminiApiKey);

    for (const modelName of modelsToTry) {
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodedKey}`;
      try {
        let attemptRes = await fetch(geminiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': geminiApiKey,
          },
          body: JSON.stringify(geminiBody),
        });

        if (attemptRes.status === 429) {
          console.warn(`[Invoice OCR] Model ${modelName} returned 429. Waiting 3s for retry...`);
          await new Promise((r) => setTimeout(r, 3000));
          attemptRes = await fetch(geminiUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': geminiApiKey,
            },
            body: JSON.stringify(geminiBody),
          });
        }

        if (attemptRes.ok) {
          res = attemptRes;
          usedModel = modelName;
          break;
        } else {
          lastErrStatus = attemptRes.status;
          lastErrTxt = await attemptRes.text();
          if (attemptRes.status === 404) {
            console.warn(`[Invoice OCR] Model ${modelName} returned 404. Trying fallback model...`);
            continue;
          }
          res = attemptRes;
          break;
        }
      } catch (fErr: any) {
        lastErrTxt = fErr.message;
      }
    }

    if (!res || !res.ok) {
      await supabase.from('invoice_uploads').update({ processing_status: 'failed' }).eq('id', uploadId);
      console.error(`[Invoice OCR Failure] Raw Gemini Error (${lastErrStatus}):`, lastErrTxt);

      return {
        success: false,
        error: 'Bill scanning is temporarily unavailable, please try again later.',
      };
    }

    const resJson = await res.json();
    const rawText = resJson.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const parsedInvoice = JSON.parse(rawText);

    const confidenceScore = computeClientConfidenceScore(parsedInvoice);

    // 4. Save extraction to DB
    const { data: extRecord, error: insErr } = await supabase
      .from('invoice_extractions')
      .insert({
        invoice_upload_id: uploadId,
        extraction_provider: `${usedModel}-client-fallback`,
        raw_json: resJson,
        parsed_json: parsedInvoice,
        confidence_score: confidenceScore,
        validation_status: 'pending',
      })
      .select('id')
      .single();

    if (insErr || !extRecord) {
      await supabase.from('invoice_uploads').update({ processing_status: 'failed' }).eq('id', uploadId);
      return { success: false, error: 'Failed to save client extraction' };
    }

    // 5. Update invoice_uploads status to extracted
    await supabase.from('invoice_uploads').update({ processing_status: 'extracted' }).eq('id', uploadId);

    return {
      success: true,
      extraction_id: extRecord.id,
    };
  } catch (err: any) {
    await supabase.from('invoice_uploads').update({ processing_status: 'failed' }).eq('id', uploadId);
    return { success: false, error: err.message || 'Client fallback extraction error' };
  }
}

function computeClientConfidenceScore(data: any): number {
  if (!data) return 0;
  let score = 0;
  let checks = 0;
  checks += 2;
  if (data.party?.code || data.party?.gst) score += 1;
  if (data.party?.name) score += 1;
  checks += 1;
  if (data.invoice?.number) score += 1;
  checks += 2;
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length > 0) {
    score += 1;
    if (items.some((i: any) => i.product_name && Number(i.quantity) > 0 && Number(i.rate) > 0)) score += 1;
  }
  checks += 1;
  if (data.totals?.grand_total > 0) score += 1;
  const result = Math.min(1.0, Math.max(0.0, score / checks));
  return Math.round(result * 100) / 100;
}

/**
 * Subscribes to extraction status changes via Supabase Realtime channel with short-interval polling fallback.
 */
export function subscribeToExtractionStatus(
  invoiceUploadId: string,
  onUpdate: (status: ProcessingStatus, extraction?: InvoiceExtraction) => void
): () => void {
  let isUnsubscribed = false;
  let pollingTimer: ReturnType<typeof setInterval> | null = null;
  let lastHandledStatus: ProcessingStatus | null = null;

  const checkStatus = async () => {
    if (isUnsubscribed) return;
    try {
      const { data: upload } = await supabase
        .from('invoice_uploads')
        .select('processing_status')
        .eq('id', invoiceUploadId)
        .maybeSingle();

      if (!upload || isUnsubscribed) return;

      const currentStatus = upload.processing_status as ProcessingStatus;

      // Deduplicate if already handled this terminal status
      if (lastHandledStatus === currentStatus && (currentStatus === 'extracted' || currentStatus === 'completed' || currentStatus === 'failed')) {
        return;
      }

      lastHandledStatus = currentStatus;

      if (currentStatus === 'extracted' || currentStatus === 'completed') {
        const { data: extraction } = await supabase
          .from('invoice_extractions')
          .select('*')
          .eq('invoice_upload_id', invoiceUploadId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!isUnsubscribed) {
          onUpdate(currentStatus, (extraction as InvoiceExtraction) || undefined);
        }
      } else {
        if (!isUnsubscribed) {
          onUpdate(currentStatus);
        }
      }
    } catch (err) {
      console.warn('Status poll error:', err);
    }
  };

  const channel = supabase
    .channel(`invoice-upload-${invoiceUploadId}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'invoice_uploads',
        filter: `id=eq.${invoiceUploadId}`,
      },
      (payload) => {
        const newStatus = payload.new?.processing_status as ProcessingStatus;
        if (newStatus) {
          checkStatus();
        }
      }
    )
    .subscribe();

  pollingTimer = setInterval(() => {
    checkStatus();
  }, 2500);

  checkStatus();

  return () => {
    isUnsubscribed = true;
    if (pollingTimer) clearInterval(pollingTimer);
    supabase.removeChannel(channel);
  };
}
