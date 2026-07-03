import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function amountPaise(grandTotal: number): number {
  return Math.round(Number(grandTotal) * 100);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  try {
    if (req.method !== 'POST') {
      return jsonResponse({ error: 'method_not_allowed' }, 405);
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return jsonResponse({ error: 'unauthorized' }, 401);
    }

    const userToken = authHeader.replace('Bearer ', '');
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const supabaseAuth = createClient(supabaseUrl, supabaseServiceKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } },
    });

    const {
      data: { user },
      error: userErr,
    } = await supabaseAuth.auth.getUser(userToken);

    if (userErr || !user) {
      return jsonResponse({ error: 'unauthorized' }, 401);
    }

    let body: { order_id?: string };
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: 'invalid_json' }, 400);
    }

    const orderId = body.order_id;
    if (!orderId) {
      return jsonResponse({ error: 'order_id_required' }, 400);
    }

    const keyId = Deno.env.get('RAZORPAY_KEY_ID');
    const keySecret = Deno.env.get('RAZORPAY_KEY_SECRET');
    if (!keyId || !keySecret) {
      console.error('Missing RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET');
      return jsonResponse({ error: 'payment_not_configured' }, 500);
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select('id, user_id, status, order_number, grand_total, razorpay_order_id, payment_mode')
      .eq('id', orderId)
      .maybeSingle();

    if (orderErr || !order) {
      return jsonResponse({ error: 'order_not_found' }, 404);
    }

    if (order.user_id !== user.id) {
      return jsonResponse({ error: 'not_authorized' }, 403);
    }

    if (order.payment_mode !== 'upi') {
      return jsonResponse({ error: 'not_upi_order' }, 400);
    }

    if (order.status === 'payment_failed') {
      const { error: retryErr } = await supabase
        .from('orders')
        .update({ status: 'pending_payment' })
        .eq('id', orderId)
        .eq('user_id', user.id)
        .eq('status', 'payment_failed');

      if (retryErr) {
        return jsonResponse({ error: retryErr.message || 'retry_failed' }, 400);
      }
      order.status = 'pending_payment';
    }

    if (order.status !== 'pending_payment') {
      return jsonResponse({ error: 'invalid_order_status' }, 400);
    }

    const paise = amountPaise(order.grand_total);

    if (order.razorpay_order_id) {
      return jsonResponse({
        razorpay_order_id: order.razorpay_order_id,
        amount_paise: paise,
        key_id: keyId,
        order_number: order.order_number,
      });
    }

    const auth = btoa(`${keyId}:${keySecret}`);
    const rzRes = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: paise,
        currency: 'INR',
        receipt: order.order_number,
      }),
    });

    const rzJson = await rzRes.json().catch(() => ({}));
    if (!rzRes.ok) {
      console.error('Razorpay create order failed:', rzRes.status, rzJson);
      return jsonResponse(
        { error: 'razorpay_error', detail: rzJson?.error?.description || rzRes.statusText },
        502,
      );
    }

    const razorpayOrderId = rzJson.id as string;
    if (!razorpayOrderId) {
      return jsonResponse({ error: 'razorpay_invalid_response' }, 502);
    }

    const { error: updateErr } = await supabase
      .from('orders')
      .update({ razorpay_order_id: razorpayOrderId })
      .eq('id', orderId)
      .eq('status', 'pending_payment')
      .is('razorpay_order_id', null);

    if (updateErr) {
      console.error('Failed to store razorpay_order_id:', updateErr.message);
      return jsonResponse({ error: 'store_failed' }, 500);
    }

    return jsonResponse({
      razorpay_order_id: razorpayOrderId,
      amount_paise: paise,
      key_id: keyId,
      order_number: order.order_number,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('create-razorpay-order error:', message);
    return jsonResponse({ error: message }, 500);
  }
});

function jsonResponse(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
