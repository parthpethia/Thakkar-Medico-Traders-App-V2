import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { INVOICE_EXTRACTION_PROMPT, GEMINI_RESPONSE_SCHEMA } from './schema.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const HOURLY_EXTRACTION_LIMIT = 20;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const geminiApiKey = Deno.env.get('GEMINI_API_KEY') || req.headers.get('x-gemini-api-key');

  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

  let uploadId = '';

  try {
    if (req.method !== 'POST') {
      return jsonResponse({ success: false, error: 'method_not_allowed' });
    }

    // 1. Authenticate caller JWT token
    const authHeader = req.headers.get('Authorization') || '';
    const userToken = authHeader.replace(/^Bearer\s+/i, '').trim();

    let callerUserId: string | null = null;
    let callerRole = 'retailer';

    if (userToken) {
      const supabaseAuthClient = createClient(supabaseUrl, supabaseServiceKey, {
        global: { headers: { Authorization: `Bearer ${userToken}` } },
      });

      const { data: userData } = await supabaseAuthClient.auth.getUser(userToken);
      if (userData?.user) {
        callerUserId = userData.user.id;

        const { data: callerProfile } = await supabaseAdmin
          .from('profiles')
          .select('role')
          .eq('id', callerUserId)
          .maybeSingle();

        callerRole = callerProfile?.role || 'retailer';
      }
    }

    let body: { invoice_upload_id?: string };
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ success: false, error: 'invalid_json_body', message: 'Invalid JSON request payload' });
    }

    uploadId = body.invoice_upload_id || '';
    if (!uploadId) {
      return jsonResponse({ success: false, error: 'invoice_upload_id_required', message: 'Missing invoice_upload_id in request body' });
    }

    if (!geminiApiKey) {
      console.error('GEMINI_API_KEY environment variable is not configured in Supabase Edge Function Secrets');
      await markUploadFailed(supabaseAdmin, uploadId);
      return jsonResponse({
        success: false,
        error: 'gemini_api_key_not_configured',
        message: 'GEMINI_API_KEY secret is not set in Supabase Edge Function Secrets. Please set GEMINI_API_KEY in Supabase Dashboard -> Edge Functions Secrets.',
      });
    }

    // 2. Fetch upload record & Authorization Check
    const { data: uploadRecord, error: uploadErr } = await supabaseAdmin
      .from('invoice_uploads')
      .select('id, uploaded_by, storage_path, file_name, file_type, processing_status')
      .eq('id', uploadId)
      .single();

    if (uploadErr || !uploadRecord) {
      console.error('Invoice upload record not found:', uploadErr);
      return jsonResponse({ success: false, error: 'upload_record_not_found', message: 'Invoice upload record not found' });
    }

    // Authorization check: User must be owner, admin, or delivery staff
    if (callerUserId && uploadRecord.uploaded_by !== callerUserId && callerRole !== 'admin' && callerRole !== 'delivery') {
      console.error(`User ${callerUserId} unauthorized to trigger extraction on upload ${uploadId}`);
      return jsonResponse({ success: false, error: 'access_denied_not_owner', message: 'Access denied: You are not authorized to extract this bill photo' });
    }

    // 3. Idempotency Check: Return existing extraction if already extracted
    if (uploadRecord.processing_status === 'extracted' || uploadRecord.processing_status === 'completed') {
      const { data: existingExt } = await supabaseAdmin
        .from('invoice_extractions')
        .select('*')
        .eq('invoice_upload_id', uploadId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existingExt) {
        return jsonResponse({
          success: true,
          already_extracted: true,
          extraction_id: existingExt.id,
          invoice_upload_id: uploadId,
          confidence_score: existingExt.confidence_score,
          parsed_json: existingExt.edited_json || existingExt.parsed_json,
        });
      }
    }

    // 4. Rate Limiting Check: Max 20 extractions per user per hour
    const userIdForRateLimit = callerUserId || uploadRecord.uploaded_by;
    const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
    const { data: recentUploads, count: hourlyCount, error: countErr } = await supabaseAdmin
      .from('invoice_uploads')
      .select('upload_time', { count: 'exact' })
      .eq('uploaded_by', userIdForRateLimit)
      .gte('upload_time', oneHourAgo)
      .order('upload_time', { ascending: true });

    if (!countErr && hourlyCount && hourlyCount >= HOURLY_EXTRACTION_LIMIT && callerRole !== 'admin') {
      const oldestInWindow = recentUploads?.[0]?.upload_time
        ? new Date(recentUploads[0].upload_time).getTime()
        : Date.now() - 3600 * 1000;
      const resetTime = oldestInWindow + 3600 * 1000;
      const minutesRemaining = Math.max(1, Math.ceil((resetTime - Date.now()) / (60 * 1000)));

      console.warn(`User ${userIdForRateLimit} exceeded hourly extraction limit (${hourlyCount}/${HOURLY_EXTRACTION_LIMIT}). Reset in ${minutesRemaining} mins.`);
      return jsonResponse({
        success: false,
        error: 'hourly_rate_limit_exceeded',
        message: `Hourly extraction limit reached (${HOURLY_EXTRACTION_LIMIT} per hour). Please try again in ${minutesRemaining} minutes.`,
        minutes_remaining: minutesRemaining,
      });
    }

    // 5. Download image binary from Supabase Storage
    const { data: fileData, error: downloadErr } = await supabaseAdmin.storage
      .from('invoice-uploads')
      .download(uploadRecord.storage_path);

    if (downloadErr || !fileData) {
      console.error('Failed to download image from storage:', downloadErr);
      await markUploadFailed(supabaseAdmin, uploadId);
      return jsonResponse({ success: false, error: 'failed_to_download_storage_file', message: 'Failed to download bill photo from storage' });
    }

    const arrayBuffer = await fileData.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const base64Image = uint8ArrayToBase64(bytes);

    const mimeType = uploadRecord.file_type || getMimeType(uploadRecord.file_name);

    // 6. Call Gemini Vision API with exponential backoff retries for 5xx/timeouts and model fallback
    const modelsToTry = ['gemini-flash-latest', 'gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-pro-latest'];

    const geminiRequestBody = {
      contents: [
        {
          parts: [
            { text: INVOICE_EXTRACTION_PROMPT },
            {
              inline_data: {
                mime_type: mimeType,
                data: base64Image,
              },
            },
          ],
        },
      ],
      generationConfig: {
        response_mime_type: 'application/json',
        response_schema: GEMINI_RESPONSE_SCHEMA,
      },
    };

    let geminiResponse: Response | null = null;
    let lastErrStatus = 0;
    let lastErrText = '';

    const encodedKey = encodeURIComponent(geminiApiKey);

    for (const modelName of modelsToTry) {
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodedKey}`;
      let attempts = 0;
      const maxRetries = 1;

      while (attempts <= maxRetries) {
        attempts++;
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 25000);

          const res = await fetch(geminiUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': geminiApiKey,
            },
            body: JSON.stringify(geminiRequestBody),
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          if (res.ok) {
            geminiResponse = res;
            break;
          } else {
            lastErrStatus = res.status;
            lastErrText = await res.text();

            if ((res.status >= 500 || res.status === 429) && attempts <= maxRetries) {
              await delay(1000);
              continue;
            }

            if (res.status === 404) {
              console.warn(`[Invoice OCR Edge] Model ${modelName} returned 404. Trying fallback model...`);
              break; // try next model in outer loop
            }

            geminiResponse = res;
            break;
          }
        } catch (fetchErr: any) {
          lastErrText = fetchErr.message;
        }
      }

      if (geminiResponse && geminiResponse.ok) {
        break;
      }
    }

    if (!geminiResponse || !geminiResponse.ok) {
      console.error('Gemini Vision API final error response:', lastErrStatus, lastErrText);
      await markUploadFailed(supabaseAdmin, uploadId);

      return jsonResponse({
        success: false,
        error: 'service_unavailable',
        message: 'Bill scanning is temporarily unavailable, please try again later.',
        details: lastErrText,
      });
    }

    const rawResponseObj = await geminiResponse.json();

    // Extract JSON payload from Gemini response
    const textContent =
      rawResponseObj.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

    let parsedInvoice: any;
    try {
      parsedInvoice = JSON.parse(textContent);
    } catch (jsonErr: any) {
      console.error('Failed to parse Gemini response text as JSON:', textContent);
      await markUploadFailed(supabaseAdmin, uploadId);
      return jsonResponse({
        success: false,
        error: 'gemini_response_parse_failed',
        message: 'Failed to parse AI response as JSON',
        rawText: textContent,
      });
    }

    // 7. Compute confidence score server-side
    const confidenceScore = computeConfidenceScore(parsedInvoice);

    // Track usage tokens if available
    const usageMetadata = rawResponseObj.usageMetadata || null;
    const enrichedRawJson = usageMetadata ? { ...rawResponseObj, usageMetadata } : rawResponseObj;

    // 8. Store extraction in invoice_extractions table
    const { data: extractionRecord, error: insertErr } = await supabaseAdmin
      .from('invoice_extractions')
      .insert({
        invoice_upload_id: uploadId,
        extraction_provider: 'gemini-2.5-flash',
        raw_json: enrichedRawJson,
        parsed_json: parsedInvoice,
        confidence_score: confidenceScore,
        validation_status: 'pending',
      })
      .select('id')
      .single();

    if (insertErr) {
      console.error('Failed to insert invoice_extractions record:', insertErr);
      await markUploadFailed(supabaseAdmin, uploadId);
      return jsonResponse({ success: false, error: 'failed_to_save_extraction', message: 'Failed to save extraction results to database' });
    }

    // 9. Update invoice_uploads status to 'extracted'
    await supabaseAdmin
      .from('invoice_uploads')
      .update({ processing_status: 'extracted' })
      .eq('id', uploadId);

    return jsonResponse({
      success: true,
      extraction_id: extractionRecord.id,
      invoice_upload_id: uploadId,
      confidence_score: confidenceScore,
      parsed_json: parsedInvoice,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('extract-invoice edge function unhandled error:', message);
    if (uploadId) {
      await markUploadFailed(supabaseAdmin, uploadId).catch(() => {});
    }
    return jsonResponse({ success: false, error: message, message });
  }
});

function computeConfidenceScore(data: any): number {
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
    const hasValidItem = items.some(
      (i: any) => i.product_name && Number(i.quantity) > 0 && Number(i.rate) > 0
    );
    if (hasValidItem) score += 1;
  }

  checks += 1;
  if (data.totals) {
    const subtotal = Number(data.totals.subtotal || 0);
    const gstTotal = Number(data.totals.gst_total || 0);
    const discountTotal = Number(data.totals.discount_total || 0);
    const roundOff = Number(data.totals.round_off || 0);
    const grandTotal = Number(data.totals.grand_total || 0);

    const calculatedGrand = subtotal + gstTotal - discountTotal + roundOff;
    if (Math.abs(calculatedGrand - grandTotal) <= 1.0 && grandTotal > 0) {
      score += 1;
    }
  }

  const result = Math.min(1.0, Math.max(0.0, score / checks));
  return Math.round(result * 100) / 100;
}

async function markUploadFailed(supabase: any, uploadId: string): Promise<void> {
  if (!uploadId) return;
  await supabase
    .from('invoice_uploads')
    .update({ processing_status: 'failed' })
    .eq('id', uploadId);
}

function getMimeType(fileName: string): string {
  const ext = fileName.toLowerCase().split('.').pop();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'pdf':
      return 'application/pdf';
    case 'jpg':
    case 'jpeg':
    default:
      return 'image/jpeg';
  }
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonResponse(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
