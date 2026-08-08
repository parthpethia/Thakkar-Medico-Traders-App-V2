import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Named constant threshold (150m) as specified in requirements
const PIN_DRIFT_THRESHOLD_METERS = 150.0;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    let body: { order_id?: string; threshold_meters?: number; batch?: boolean } = {};
    if (req.method === 'POST') {
      try {
        body = await req.json();
      } catch {
        body = {};
      }
    }

    const threshold = body.threshold_meters || PIN_DRIFT_THRESHOLD_METERS;

    // Single order evaluation
    if (body.order_id) {
      const { data: flagged, error } = await supabase.rpc('evaluate_delivered_order_pin_drift', {
        p_order_id: body.order_id,
        p_threshold_meters: threshold,
      });

      if (error) {
        return jsonResponse({ success: false, error: error.message }, 400);
      }

      return jsonResponse({
        success: true,
        order_id: body.order_id,
        threshold_meters: threshold,
        flagged_for_reverification: Boolean(flagged),
      });
    }

    // Batch evaluation across recent delivered orders
    const { data: flaggedCount, error: batchErr } = await supabase.rpc('audit_delivered_orders_for_pin_drift', {
      p_threshold_meters: threshold,
    });

    if (batchErr) {
      return jsonResponse({ success: false, error: batchErr.message }, 400);
    }

    return jsonResponse({
      success: true,
      batch_scan: true,
      threshold_meters: threshold,
      flagged_count: flaggedCount || 0,
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse({ success: false, error: message }, 500);
  }
});

function jsonResponse(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
