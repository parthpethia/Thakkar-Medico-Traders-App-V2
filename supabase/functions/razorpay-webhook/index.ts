import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendPush } from '../notify-order-status/push.ts';

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function amountPaise(grandTotal: number): number {
  return Math.round(Number(grandTotal) * 100);
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const webhookSecret = Deno.env.get('RAZORPAY_WEBHOOK_SECRET');
  if (!webhookSecret) {
    console.error('RAZORPAY_WEBHOOK_SECRET not configured');
    return new Response('Webhook not configured', { status: 500 });
  }

  const rawBody = await req.text();
  const signature = req.headers.get('X-Razorpay-Signature') || '';

  const expected = await hmacSha256Hex(webhookSecret, rawBody);
  if (!signature || signature !== expected) {
    console.error('Invalid Razorpay webhook signature');
    return new Response('Invalid signature', { status: 400 });
  }

  let payload: {
    event?: string;
    payload?: {
      payment?: { entity?: { id?: string; order_id?: string; amount?: number } };
    };
  };

  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const event = payload.event;
  if (event !== 'payment.captured' && event !== 'payment.failed') {
    return new Response('OK', { status: 200 });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const paymentEntity = payload.payload?.payment?.entity;
  const razorpayOrderId = paymentEntity?.order_id;
  const razorpayPaymentId = paymentEntity?.id;
  const paymentAmount = paymentEntity?.amount;

  if (!razorpayOrderId) {
    console.error('Webhook missing payment.entity.order_id');
    return new Response('OK', { status: 200 });
  }

  const { data: order, error: orderErr } = await supabase
    .from('orders')
    .select('id, order_number, user_id, grand_total, status, user_name')
    .eq('razorpay_order_id', razorpayOrderId)
    .maybeSingle();

  if (orderErr || !order) {
    console.error('No order for razorpay_order_id:', razorpayOrderId, orderErr?.message);
    return new Response('OK', { status: 200 });
  }

  if (event === 'payment.captured') {
    const expectedPaise = amountPaise(order.grand_total);
    if (paymentAmount == null || paymentAmount !== expectedPaise) {
      console.error(
        'Amount mismatch for order',
        order.id,
        'expected',
        expectedPaise,
        'got',
        paymentAmount,
      );
      await alertAdminsAmountMismatch(supabase, order.id, order.order_number);
      return new Response('OK', { status: 200 });
    }

    const { error: updateErr } = await supabase
      .from('orders')
      .update({
        status: 'pending',
        razorpay_payment_id: razorpayPaymentId ?? null,
        payment_captured_at: new Date().toISOString(),
      })
      .eq('razorpay_order_id', razorpayOrderId)
      .eq('status', 'pending_payment');

    if (updateErr) {
      console.error('payment.captured update failed:', updateErr.message);
    }

    return new Response('OK', { status: 200 });
  }

  if (event === 'payment.failed') {
    const { error: failErr } = await supabase
      .from('orders')
      .update({ status: 'payment_failed' })
      .eq('razorpay_order_id', razorpayOrderId)
      .eq('status', 'pending_payment');

    if (failErr) {
      console.error('payment.failed update failed:', failErr.message);
      return new Response('OK', { status: 200 });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('push_token')
      .eq('id', order.user_id)
      .maybeSingle();

    const token = profile?.push_token;
    if (token) {
      await sendPush(
        supabase,
        [token],
        'Payment failed',
        `Your payment for ${order.order_number} failed. Tap to retry.`,
        { orderId: order.id, type: 'payment_failed' },
      );
    }

    return new Response('OK', { status: 200 });
  }

  return new Response('OK', { status: 200 });
});

async function alertAdminsAmountMismatch(
  supabase: ReturnType<typeof createClient>,
  orderId: string,
  orderNumber: string,
): Promise<void> {
  const { data: rows, error } = await supabase
    .from('profiles')
    .select('push_token')
    .eq('role', 'admin')
    .not('push_token', 'is', null);

  if (error) {
    console.error('Failed to fetch admin tokens for amount mismatch:', error.message);
    return;
  }

  const tokens = (rows ?? [])
    .map((r: { push_token: string | null }) => r.push_token)
    .filter((t): t is string => !!t);

  await sendPush(
    supabase,
    tokens,
    'Payment amount mismatch',
    `${orderNumber}: Razorpay amount did not match order total. Review manually.`,
    { orderId, type: 'payment_amount_mismatch' },
  );
}
