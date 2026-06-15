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

    const { retailer_id, month } = await req.json();

    if (!retailer_id) {
      return jsonError('retailer_id is required', 400);
    }
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return jsonError('month is required in YYYY-MM format', 400);
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

    // Admin-only check
    const { data: callerProfile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (callerProfile?.role !== 'admin') {
      return jsonError('Only admins can generate statements', 403);
    }

    // Fetch retailer profile
    const { data: retailer } = await supabase
      .from('profiles')
      .select('name, business_name, phone, address, city, state, pincode')
      .eq('id', retailer_id)
      .single();

    if (!retailer) {
      return jsonError('Retailer not found', 404);
    }

    // Date range for the requested month
    const [year, mon] = month.split('-').map(Number);
    const startDate = new Date(Date.UTC(year, mon - 1, 1)).toISOString();
    const endDate = new Date(Date.UTC(year, mon, 1)).toISOString();

    // Fetch delivered orders for this retailer in this month
    const { data: orders } = await supabase
      .from('orders')
      .select('id, order_number, created_at, grand_total, payment_mode, status')
      .eq('user_id', retailer_id)
      .eq('status', 'delivered')
      .gte('created_at', startDate)
      .lt('created_at', endDate)
      .order('created_at', { ascending: true });

    const deliveredOrders = orders ?? [];

    // Fetch loyalty transactions (positive = earned) for this retailer in this month
    const { data: loyaltyTxns } = await supabase
      .from('loyalty_transactions')
      .select('points')
      .eq('retailer_id', retailer_id)
      .gt('points', 0)
      .gte('created_at', startDate)
      .lt('created_at', endDate);

    const totalLoyaltyEarned = (loyaltyTxns ?? []).reduce((sum, t) => sum + t.points, 0);

    // Compute summaries
    const totalOrders = deliveredOrders.length;
    const totalValue = deliveredOrders.reduce((sum, o) => sum + (o.grand_total ?? 0), 0);
    const creditUsed = deliveredOrders
      .filter((o) => o.payment_mode === 'credit')
      .reduce((sum, o) => sum + (o.grand_total ?? 0), 0);

    const monthLabel = new Date(year, mon - 1).toLocaleDateString('en-IN', {
      month: 'long',
      year: 'numeric',
    });

    const retailerName = retailer.name || retailer.business_name || 'N/A';

    const html = buildStatementHtml({
      retailerName,
      monthLabel,
      orders: deliveredOrders,
      totalOrders,
      totalValue,
      totalLoyaltyEarned,
      creditUsed,
    });

    return new Response(html, {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'text/html; charset=utf-8' },
    });
  } catch (err: any) {
    console.error('generate-statement error:', err);
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
  });
}

function formatCurrency(amount: number): string {
  return '₹' + amount.toFixed(2);
}

function escapeHtml(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface StatementData {
  retailerName: string;
  monthLabel: string;
  orders: Array<{
    order_number: string;
    created_at: string;
    grand_total: number;
    payment_mode: string;
  }>;
  totalOrders: number;
  totalValue: number;
  totalLoyaltyEarned: number;
  creditUsed: number;
}

function buildStatementHtml(data: StatementData): string {
  const paymentModeLabel: Record<string, string> = {
    cod: 'COD',
    credit: 'Credit',
    upi: 'UPI',
  };

  let ordersRowsHtml = '';
  data.orders.forEach((order, idx) => {
    const rowBg = idx % 2 === 0 ? '#fff' : '#f9fbfc';
    ordersRowsHtml += `
      <tr style="background:${rowBg};">
        <td style="padding:10px 12px;border-bottom:1px solid #eee;color:#333;font-weight:500;">${escapeHtml(order.order_number)}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #eee;color:#555;">${formatDate(order.created_at)}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #eee;text-align:right;font-weight:600;color:#333;">${formatCurrency(order.grand_total ?? 0)}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #eee;text-align:center;color:#555;">${paymentModeLabel[order.payment_mode] ?? order.payment_mode ?? 'N/A'}</td>
      </tr>`;
  });

  if (data.orders.length === 0) {
    ordersRowsHtml = `
      <tr>
        <td colspan="4" style="padding:30px;text-align:center;color:#999;font-style:italic;">No delivered orders found for this period</td>
      </tr>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Statement - ${escapeHtml(data.retailerName)} - ${escapeHtml(data.monthLabel)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#fff;">
    <tr>
      <td style="padding:0;">

        <!-- Header -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#1a5276;padding:24px 20px;">
          <tr>
            <td>
              <h1 style="margin:0 0 4px 0;font-size:22px;font-weight:700;color:#fff;letter-spacing:0.5px;">Thakkar Medico Traders</h1>
              <p style="margin:0;font-size:13px;color:#aed6f1;">Monthly Statement</p>
            </td>
            <td style="text-align:right;vertical-align:top;">
              <p style="margin:0;font-size:14px;color:#aed6f1;">STATEMENT</p>
            </td>
          </tr>
        </table>

        <!-- Retailer + Month -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:20px;border-bottom:1px solid #eee;">
          <tr>
            <td style="vertical-align:top;width:50%;">
              <p style="margin:0 0 6px 0;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#999;font-weight:600;">Retailer</p>
              <p style="margin:0;font-size:16px;font-weight:600;color:#333;">${escapeHtml(data.retailerName)}</p>
            </td>
            <td style="vertical-align:top;width:50%;text-align:right;">
              <p style="margin:0 0 6px 0;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#999;font-weight:600;">Period</p>
              <p style="margin:0;font-size:16px;font-weight:600;color:#333;">${escapeHtml(data.monthLabel)}</p>
            </td>
          </tr>
        </table>

        <!-- Summary Cards -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:20px;">
          <tr>
            <td style="width:25%;text-align:center;padding:8px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eaf2f8;border-radius:8px;padding:14px 8px;">
                <tr><td style="text-align:center;">
                  <p style="margin:0;font-size:24px;font-weight:700;color:#1a5276;">${data.totalOrders}</p>
                  <p style="margin:4px 0 0 0;font-size:11px;color:#777;text-transform:uppercase;letter-spacing:0.5px;">Orders</p>
                </td></tr>
              </table>
            </td>
            <td style="width:25%;text-align:center;padding:8px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e8f8f5;border-radius:8px;padding:14px 8px;">
                <tr><td style="text-align:center;">
                  <p style="margin:0;font-size:24px;font-weight:700;color:#1e8449;">${formatCurrency(data.totalValue)}</p>
                  <p style="margin:4px 0 0 0;font-size:11px;color:#777;text-transform:uppercase;letter-spacing:0.5px;">Total Value</p>
                </td></tr>
              </table>
            </td>
            <td style="width:25%;text-align:center;padding:8px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fef9e7;border-radius:8px;padding:14px 8px;">
                <tr><td style="text-align:center;">
                  <p style="margin:0;font-size:24px;font-weight:700;color:#b7950b;">${data.totalLoyaltyEarned}</p>
                  <p style="margin:4px 0 0 0;font-size:11px;color:#777;text-transform:uppercase;letter-spacing:0.5px;">Loyalty Pts</p>
                </td></tr>
              </table>
            </td>
            <td style="width:25%;text-align:center;padding:8px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fdedec;border-radius:8px;padding:14px 8px;">
                <tr><td style="text-align:center;">
                  <p style="margin:0;font-size:24px;font-weight:700;color:#c0392b;">${formatCurrency(data.creditUsed)}</p>
                  <p style="margin:4px 0 0 0;font-size:11px;color:#777;text-transform:uppercase;letter-spacing:0.5px;">Credit Used</p>
                </td></tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- Orders Table -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:0 20px 20px 20px;">
          <tr>
            <td>
              <p style="margin:0 0 12px 0;font-size:15px;font-weight:600;color:#333;">Order Details</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                <thead>
                  <tr style="background:#f0f4f8;">
                    <th style="padding:10px 12px;text-align:left;font-size:12px;font-weight:600;color:#555;border-bottom:2px solid #d5dfe8;">Order #</th>
                    <th style="padding:10px 12px;text-align:left;font-size:12px;font-weight:600;color:#555;border-bottom:2px solid #d5dfe8;">Date</th>
                    <th style="padding:10px 12px;text-align:right;font-size:12px;font-weight:600;color:#555;border-bottom:2px solid #d5dfe8;">Amount</th>
                    <th style="padding:10px 12px;text-align:center;font-size:12px;font-weight:600;color:#555;border-bottom:2px solid #d5dfe8;">Payment</th>
                  </tr>
                </thead>
                <tbody>
                  ${ordersRowsHtml}
                </tbody>
                ${data.orders.length > 0 ? `
                <tfoot>
                  <tr style="background:#f0f4f8;">
                    <td colspan="2" style="padding:12px;font-size:14px;font-weight:700;color:#1a5276;">Total (${data.totalOrders} orders)</td>
                    <td style="padding:12px;text-align:right;font-size:14px;font-weight:700;color:#1a5276;">${formatCurrency(data.totalValue)}</td>
                    <td style="padding:12px;"></td>
                  </tr>
                </tfoot>` : ''}
              </table>
            </td>
          </tr>
        </table>

        <!-- Footer -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:20px;border-top:1px solid #eee;">
          <tr>
            <td style="text-align:center;">
              <p style="margin:0 0 4px 0;font-size:14px;color:#1a5276;font-weight:600;">Thank you for your business!</p>
              <p style="margin:0;font-size:12px;color:#999;">This statement is auto-generated by Thakkar Medico Traders.</p>
            </td>
          </tr>
        </table>

      </td>
    </tr>
  </table>
</body>
</html>`;
}
