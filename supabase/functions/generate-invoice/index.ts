import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  try {
    if (req.method !== 'POST') {
      return jsonError('Method not allowed', 405);
    }

    const { order_id } = await req.json();
    if (!order_id) {
      return jsonError('order_id is required', 400);
    }

    // Verify caller identity
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return jsonError('Missing Authorization header', 401);
    }

    const token = authHeader.replace('Bearer ', '');
    const supabaseAuth = createClient(supabaseUrl, supabaseServiceKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const { data: { user }, error: userErr } = await supabaseAuth.auth.getUser(token);
    if (userErr || !user) {
      return jsonError('Invalid or expired token', 401);
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Fetch caller profile for role check
    const { data: callerProfile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    // Fetch the order
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select('*')
      .eq('id', order_id)
      .single();

    if (orderErr || !order) {
      return jsonError('Order not found', 404);
    }

    // Authorization: must own the order or be staff
    const isOwner = order.user_id === user.id;
    const isStaff = callerProfile?.role === 'admin' || callerProfile?.role === 'delivery';

    if (!isOwner && !isStaff) {
      return jsonError('You do not have permission to view this invoice', 403);
    }

    // Fetch order items with product names
    const { data: orderItems } = await supabase
      .from('order_items')
      .select('qty, unit_price, gst_percent, line_total, product_id')
      .eq('order_id', order_id);

    let itemsWithNames: Array<{
      qty: number;
      unit_price: number;
      gst_percent: number;
      line_total: number;
      product_name: string;
    }> = [];

    if (orderItems && orderItems.length > 0) {
      const productIds = orderItems.map((i) => i.product_id);
      const { data: products } = await supabase
        .from('products')
        .select('id, name')
        .in('id', productIds);

      const productMap = new Map((products ?? []).map((p) => [p.id, p.name]));

      itemsWithNames = orderItems.map((item) => ({
        qty: item.qty,
        unit_price: item.unit_price,
        gst_percent: item.gst_percent,
        line_total: item.line_total,
        product_name: productMap.get(item.product_id) ?? 'Unknown Product',
      }));
    }

    // Fetch retailer profile
    const { data: retailer } = await supabase
      .from('profiles')
      .select('name, business_name, address, city, state, pincode, phone, gstin')
      .eq('id', order.user_id)
      .single();

    // Fetch settings for company info
    const { data: settings } = await supabase
      .from('settings')
      .select('*')
      .limit(1)
      .single();

    const html = buildInvoiceHtml(order, itemsWithNames, retailer, settings);

    return new Response(html, {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'text/html; charset=utf-8' },
    });
  } catch (err: any) {
    console.error('generate-invoice error:', err);
    return jsonError(err.message ?? 'Internal server error', 500);
  }
});

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function formatDate(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  }) + ' ' + d.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kolkata',
  });
}

function formatCurrency(amount: number | null | undefined): string {
  return '₹' + (amount ?? 0).toFixed(2);
}

function escapeHtml(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface OrderItem {
  qty: number;
  unit_price: number;
  gst_percent: number;
  line_total: number;
  product_name: string;
}

function buildInvoiceHtml(
  order: any,
  items: OrderItem[],
  retailer: any,
  settings: any,
): string {
  const companyName = 'Thakkar Medico Traders';
  const companyAddress = 'Surat, Gujarat';
  const companyPhone = settings?.support_phone ?? '';
  const companyGstin = '';

  const retailerName = escapeHtml(retailer?.name || retailer?.business_name || order.user_name || 'N/A');
  const retailerBusiness = escapeHtml(retailer?.business_name || '');
  const retailerPhone = escapeHtml(retailer?.phone || order.user_phone || '');
  const retailerGstin = escapeHtml(retailer?.gstin || '');

  const retailerAddress = [
    retailer?.address,
    retailer?.city,
    retailer?.state,
    retailer?.pincode,
  ].filter(Boolean).map(escapeHtml).join(', ');

  const paymentModeLabel: Record<string, string> = {
    cod: 'Cash on Delivery',
    credit: 'Credit',
    upi: 'UPI',
  };

  const fulfillmentLabel: Record<string, string> = {
    delivery: 'Delivery',
    pickup: 'Pickup',
  };

  let itemsRowsHtml = '';
  items.forEach((item, idx) => {
    const baseAmount = item.unit_price * item.qty;
    itemsRowsHtml += `
      <tr>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:center;color:#555;">${idx + 1}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;color:#333;">${escapeHtml(item.product_name)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:center;color:#555;">${item.qty}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:right;color:#555;">${formatCurrency(item.unit_price)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:center;color:#555;">${item.gst_percent}%</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:right;font-weight:600;color:#333;">${formatCurrency(item.line_total)}</td>
      </tr>`;
  });

  if (items.length === 0) {
    itemsRowsHtml = `
      <tr>
        <td colspan="6" style="padding:20px;text-align:center;color:#999;font-style:italic;">No line items found</td>
      </tr>`;
  }

  const discountAmount = order.discount_amount ?? 0;
  const discountRow = discountAmount > 0
    ? `<tr>
        <td style="padding:6px 10px;text-align:right;color:#e74c3c;">Discount</td>
        <td style="padding:6px 10px;text-align:right;color:#e74c3c;">-${formatCurrency(discountAmount)}</td>
       </tr>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Invoice - ${escapeHtml(order.order_number)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#fff;">
    <tr>
      <td style="padding:0;">

        <!-- Header -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#1a5276;padding:24px 20px;">
          <tr>
            <td>
              <h1 style="margin:0 0 4px 0;font-size:22px;font-weight:700;color:#fff;letter-spacing:0.5px;">${escapeHtml(companyName)}</h1>
              <p style="margin:0;font-size:13px;color:#aed6f1;">${escapeHtml(companyAddress)}</p>
              ${companyPhone ? `<p style="margin:2px 0 0 0;font-size:13px;color:#aed6f1;">Phone: ${escapeHtml(companyPhone)}</p>` : ''}
              ${companyGstin ? `<p style="margin:2px 0 0 0;font-size:13px;color:#aed6f1;">GSTIN: ${escapeHtml(companyGstin)}</p>` : ''}
            </td>
            <td style="text-align:right;vertical-align:top;">
              <p style="margin:0;font-size:28px;font-weight:700;color:#fff;opacity:0.9;">INVOICE</p>
            </td>
          </tr>
        </table>

        <!-- Order Info + Retailer -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:20px;">
          <tr>
            <td style="vertical-align:top;width:50%;padding-right:10px;">
              <p style="margin:0 0 8px 0;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#999;font-weight:600;">Bill To</p>
              <p style="margin:0 0 2px 0;font-size:15px;font-weight:600;color:#333;">${retailerName}</p>
              ${retailerBusiness && retailerBusiness !== retailerName ? `<p style="margin:0 0 2px 0;font-size:13px;color:#555;">${retailerBusiness}</p>` : ''}
              ${retailerAddress ? `<p style="margin:0 0 2px 0;font-size:13px;color:#555;">${retailerAddress}</p>` : ''}
              ${retailerPhone ? `<p style="margin:0 0 2px 0;font-size:13px;color:#555;">Ph: ${retailerPhone}</p>` : ''}
              ${retailerGstin ? `<p style="margin:0;font-size:13px;color:#555;">GSTIN: ${retailerGstin}</p>` : ''}
            </td>
            <td style="vertical-align:top;width:50%;padding-left:10px;">
              <p style="margin:0 0 8px 0;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#999;font-weight:600;">Order Details</p>
              <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:13px;">
                <tr>
                  <td style="padding:2px 8px 2px 0;color:#777;">Order #</td>
                  <td style="padding:2px 0;font-weight:600;color:#333;">${escapeHtml(order.order_number)}</td>
                </tr>
                <tr>
                  <td style="padding:2px 8px 2px 0;color:#777;">Date</td>
                  <td style="padding:2px 0;color:#333;">${formatDate(order.created_at)}</td>
                </tr>
                <tr>
                  <td style="padding:2px 8px 2px 0;color:#777;">Payment</td>
                  <td style="padding:2px 0;color:#333;">${paymentModeLabel[order.payment_mode] ?? order.payment_mode ?? 'N/A'}</td>
                </tr>
                <tr>
                  <td style="padding:2px 8px 2px 0;color:#777;">Fulfillment</td>
                  <td style="padding:2px 0;color:#333;">${fulfillmentLabel[order.fulfillment_mode] ?? order.fulfillment_mode ?? 'Delivery'}</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- Line Items -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:0 20px;">
          <tr>
            <td>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                <thead>
                  <tr style="background:#f0f4f8;">
                    <th style="padding:10px;text-align:center;font-size:12px;font-weight:600;color:#555;border-bottom:2px solid #d5dfe8;width:36px;">#</th>
                    <th style="padding:10px;text-align:left;font-size:12px;font-weight:600;color:#555;border-bottom:2px solid #d5dfe8;">Product</th>
                    <th style="padding:10px;text-align:center;font-size:12px;font-weight:600;color:#555;border-bottom:2px solid #d5dfe8;width:44px;">Qty</th>
                    <th style="padding:10px;text-align:right;font-size:12px;font-weight:600;color:#555;border-bottom:2px solid #d5dfe8;width:80px;">Unit Price</th>
                    <th style="padding:10px;text-align:center;font-size:12px;font-weight:600;color:#555;border-bottom:2px solid #d5dfe8;width:52px;">GST%</th>
                    <th style="padding:10px;text-align:right;font-size:12px;font-weight:600;color:#555;border-bottom:2px solid #d5dfe8;width:90px;">Line Total</th>
                  </tr>
                </thead>
                <tbody>
                  ${itemsRowsHtml}
                </tbody>
              </table>
            </td>
          </tr>
        </table>

        <!-- Totals -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:16px 20px 0 20px;">
          <tr>
            <td>
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin-left:auto;min-width:220px;font-size:14px;">
                <tr>
                  <td style="padding:6px 10px;text-align:right;color:#777;">Subtotal</td>
                  <td style="padding:6px 10px;text-align:right;color:#333;">${formatCurrency(order.subtotal)}</td>
                </tr>
                <tr>
                  <td style="padding:6px 10px;text-align:right;color:#777;">GST</td>
                  <td style="padding:6px 10px;text-align:right;color:#333;">${formatCurrency(order.gst)}</td>
                </tr>
                ${discountRow}
                <tr style="border-top:2px solid #1a5276;">
                  <td style="padding:12px 10px;text-align:right;font-size:16px;font-weight:700;color:#1a5276;">Grand Total</td>
                  <td style="padding:12px 10px;text-align:right;font-size:16px;font-weight:700;color:#1a5276;">${formatCurrency(order.grand_total)}</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- Footer -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:28px 20px;margin-top:16px;border-top:1px solid #eee;">
          <tr>
            <td style="text-align:center;">
              <p style="margin:0 0 4px 0;font-size:14px;color:#1a5276;font-weight:600;">Thank you for your business!</p>
              <p style="margin:0;font-size:12px;color:#999;">This is a computer-generated invoice and does not require a signature.</p>
            </td>
          </tr>
        </table>

      </td>
    </tr>
  </table>
</body>
</html>`;
}
