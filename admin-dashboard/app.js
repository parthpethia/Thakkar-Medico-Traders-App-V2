/* ============================================================
   Thakkar Medico — Admin Dashboard Application Logic
   Full admin pages: Dashboard, Analytics, Orders, Products,
   Stock, Users, Retailers, Delivery, POS, Invoice, Settings
   ============================================================ */

// --------------- Supabase Config ---------------
const SUPABASE_URL = 'https://glsedwmswfhnmvuabrbh.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdsc2Vkd21zd2Zobm12dWFicmJoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA0ODg3OTYsImV4cCI6MjA4NjA2NDc5Nn0.d0PThbSOi6YG0UGq4j3WIvb7y73hDU4HYWlQ17DpOl8';

// Guard: ensure Supabase SDK loaded
if (!window.supabase || !window.supabase.createClient) {
  document.getElementById('loginErrorText').textContent = 'Failed to load Supabase SDK. Please refresh the page.';
  document.getElementById('loginError').classList.remove('hidden');
  throw new Error('Supabase SDK not loaded');
}

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// --------------- DOM Elements ---------------
const loginPage = document.getElementById('loginPage');
const dashboard = document.getElementById('dashboard');
const loginForm = document.getElementById('loginForm');
const loginBtn = document.getElementById('loginBtn');
const loginError = document.getElementById('loginError');
const loginErrorText = document.getElementById('loginErrorText');
const loginIdentity = document.getElementById('loginIdentity');
const loginPassword = document.getElementById('loginPassword');
const passwordToggle = document.getElementById('passwordToggle');

const sidebar = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebarOverlay');
const sidebarToggle = document.getElementById('sidebarToggle');
const logoutBtn = document.getElementById('logoutBtn');
const pageTitle = document.getElementById('pageTitle');
const pageContent = document.getElementById('pageContent');
const userAvatar = document.getElementById('userAvatar');
const userName = document.getElementById('userName');

// --------------- State ---------------
let currentUser = null;
let currentProfile = null;
let currentPage = 'dashboard';
let dashboardStats = null;
let isAuthChecking = false;

// Helper: fetch all products in chunks of 1000 to bypass PostgREST max_rows cap
async function fetchAllProducts(selectCols = '*', filterActive = false) {
  let all = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    let q = sb.from('products').select(selectCols).order('name').range(from, from + pageSize - 1);
    if (filterActive) q = q.eq('is_active', true);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// Page-level state objects
let _ordersState = {};
let _posState = {};
let _invoiceState = {};
let _deliveryMap = null;
let _realtimeChannels = [];

// ============================================================
// AUTH & STATE MANAGEMENT
// ============================================================

sb.auth.onAuthStateChange(async (event, session) => {
  console.log('Auth state change event:', event, session ? session.user.email : 'no session');

  if (event === 'SIGNED_OUT' || !session) {
    currentUser = null;
    currentProfile = null;
    cleanupRealtimeChannels();
    showLogin(true);
    return;
  }

  if (isAuthChecking) return;
  isAuthChecking = true;

  try {
    if (!currentProfile || currentProfile.id !== session.user.id) {
      const { data: profile, error: profileError } = await sb
        .from('profiles')
        .select('*')
        .eq('id', session.user.id)
        .single();

      if (profileError) throw profileError;

      if (!profile || profile.role !== 'admin') {
        isAuthChecking = false;
        await sb.auth.signOut();
        showError('Access denied. Only admin accounts can access this dashboard.');
        return;
      }

      currentUser = session.user;
      currentProfile = profile;
    }

    showDashboard();
  } catch (err) {
    console.error('Profile verification error:', err);
    isAuthChecking = false;
    await sb.auth.signOut();
    showError('Failed to verify profile. Please try logging in again.');
  } finally {
    isAuthChecking = false;
  }
});

// Password visibility toggle
passwordToggle.addEventListener('click', () => {
  const isPassword = loginPassword.type === 'password';
  loginPassword.type = isPassword ? 'text' : 'password';
  passwordToggle.textContent = isPassword ? '🙈' : '👁️';
});

// Phone formatter to E.164 (Indian numbers)
function formatPhoneE164(phone) {
  let cleaned = phone.replace(/\s/g, '');
  if (cleaned.startsWith('+91')) {
    return cleaned;
  }
  let digits = cleaned.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) {
    digits = digits.substring(2);
  } else if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.substring(1);
  }
  return '+91' + digits;
}

// Login form submit
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();

  const identity = loginIdentity.value.trim();
  const password = loginPassword.value;

  if (!identity || !password) {
    showError('Please enter your email/phone and password.');
    return;
  }

  setLoginLoading(true);

  try {
    let email = identity;
    const digitsOnly = identity.replace(/[\s\-+()]/g, '');
    const isPhone = /^\d{7,15}$/.test(digitsOnly) && !identity.includes('@');

    if (isPhone) {
      const formattedPhone = formatPhoneE164(identity);
      const { data, error: rpcError } = await sb.rpc('get_email_by_phone', { p_phone: formattedPhone });
      if (rpcError) { showError('Error looking up phone number. Please try with email.'); setLoginLoading(false); return; }
      
      if (data) {
        email = data;
      } else {
        // Fallback: Check if it's a retailer code (e.g. pure digit retailer code >= 7 digits)
        const { data: codeData, error: codeError } = await sb.rpc('get_email_by_retailer_code', { p_retailer_code: identity });
        if (codeError || !codeData) {
          showError('No account found for this phone number or retailer code.');
          setLoginLoading(false);
          return;
        }
        email = codeData;
      }
    } else if (!identity.includes('@')) {
      // It's not a phone, and doesn't have '@', so treat as retailer code
      const { data, error: rpcError } = await sb.rpc('get_email_by_retailer_code', { p_retailer_code: identity });
      if (rpcError || !data) {
        showError('Please enter a valid email, phone number, or retailer code.');
        setLoginLoading(false);
        return;
      }
      email = data;
    }

    const { data: authData, error: authError } = await sb.auth.signInWithPassword({ email, password });

    if (authError) {
      showError(authError.message === 'Invalid login credentials' ? 'Invalid email/phone or password.' : authError.message);
      setLoginLoading(false);
      return;
    }
  } catch (err) {
    console.error('Login submit error:', err);
    showError(err.message || 'An unexpected error occurred.');
    setLoginLoading(false);
  }
});

// Logout
logoutBtn.addEventListener('click', async () => {
  currentUser = null;
  currentProfile = null;
  dashboardStats = null;
  cleanupRealtimeChannels();
  await sb.auth.signOut();
});

// --------------- UI Helpers ---------------

function showLogin(keepError = false) {
  loginPage.style.display = 'flex';
  dashboard.classList.remove('active');
  loginForm.reset();
  setLoginLoading(false);
  if (!keepError) hideError();
}

function showDashboard() {
  loginPage.style.display = 'none';
  dashboard.classList.add('active');
  updateUserUI();
  navigateTo('dashboard');
}

function showError(msg) {
  loginErrorText.textContent = msg;
  loginError.classList.remove('hidden');
}
function hideError() { loginError.classList.add('hidden'); }

function setLoginLoading(loading) {
  if (loading) { loginBtn.disabled = true; loginBtn.innerHTML = '<span class="spinner"></span> Signing in...'; }
  else { loginBtn.disabled = false; loginBtn.textContent = 'Sign In'; }
}

function updateUserUI() {
  if (!currentProfile) return;
  const name = currentProfile.name || currentProfile.email || 'Admin';
  userName.textContent = name;
  userAvatar.textContent = name.charAt(0).toUpperCase();
}

function cleanupRealtimeChannels() {
  _realtimeChannels.forEach(ch => { try { sb.removeChannel(ch); } catch(e){} });
  _realtimeChannels = [];
}

// Toast notification
function showToast(msg, type = 'info') {
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;top:20px;right:20px;z-index:9999;padding:14px 20px;border-radius:12px;font-size:14px;font-weight:600;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,0.3);animation:cardEntry .3s both;max-width:360px;`;
  const bgMap = { success: 'linear-gradient(135deg,#00C896,#00A67E)', error: 'linear-gradient(135deg,#FF6B6B,#EE5A24)', warning: 'linear-gradient(135deg,#FFA500,#FF8C00)', info: 'linear-gradient(135deg,#6C63FF,#8B83FF)' };
  el.style.background = bgMap[type] || bgMap.info;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, 3000);
}

// Formatter helpers
const fmtCurrency = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const fmtTime = (d) => d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '';
const fmtDateTime = (d) => d ? `${fmtDate(d)} ${fmtTime(d)}` : '—';
const timeAgo = (d) => {
  if (!d) return '';
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
};

// Skeleton loader
const skeleton = (w = '100%', h = '20px') => `<div style="background:var(--bg-elevated);border-radius:8px;width:${w};height:${h};animation:pulse 1.5s infinite;"></div>`;

// ============================================================
// NAVIGATION
// ============================================================

document.querySelectorAll('.sidebar-link').forEach(link => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    const page = link.dataset.page;
    if (page) navigateTo(page);
    closeSidebar();
  });
});

sidebarToggle.addEventListener('click', () => {
  sidebar.classList.toggle('open');
  sidebarOverlay.classList.toggle('active');
});

sidebarOverlay.addEventListener('click', closeSidebar);

function closeSidebar() {
  sidebar.classList.remove('open');
  sidebarOverlay.classList.remove('active');
}

const pageTitles = {
  dashboard: 'Dashboard', analytics: 'Analytics', manage: 'Manage Overview', orders: 'Orders',
  products: 'Products', stock: 'Stock Management', users: 'Users',
  retailers: 'Retailers', delivery: 'Delivery Tracking',
  pos: 'POS Counter Billing', invoice: 'Invoice Import', audit: 'Audit Logs', settings: 'Settings',
};

function navigateTo(page) {
  cleanupRealtimeChannels();
  if (_deliveryMap) { _deliveryMap.remove(); _deliveryMap = null; }
  currentPage = page;

  document.querySelectorAll('.sidebar-link').forEach(l => l.classList.remove('active'));
  const activeLink = document.querySelector(`.sidebar-link[data-page="${page}"]`);
  if (activeLink) activeLink.classList.add('active');

  pageTitle.textContent = pageTitles[page] || 'Dashboard';

  const renderers = {
    dashboard: renderDashboard,
    analytics: renderAnalytics,
    manage: renderManage,
    orders: renderOrders,
    products: renderProducts,
    stock: renderStock,
    users: renderUsers,
    retailers: renderRetailers,
    delivery: renderDelivery,
    pos: renderPOS,
    invoice: renderInvoice,
    audit: renderAudit,
    settings: renderSettings,
  };

  (renderers[page] || renderDashboard)();
}

// ============================================================
// DASHBOARD PAGE
// ============================================================

async function renderDashboard() {
  pageContent.innerHTML = `
    <div class="stats-grid" id="statsGrid">${renderStatCardSkeleton(6)}</div>
    <div class="dashboard-bottom-grid">
      <div class="section-card">
        <div class="section-card-header"><h3 class="section-card-title">Quick Actions</h3></div>
        <div class="quick-actions" id="quickActions">${renderQuickActionCards()}</div>
      </div>
      <div class="section-card">
        <div class="section-card-header"><h3 class="section-card-title">System Status</h3></div>
        ${renderSystemStatus()}
      </div>
    </div>
  `;
  await fetchDashboardStats();
}

async function fetchDashboardStats() {
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const { data, error } = await sb.rpc('get_admin_dashboard_stats', { p_today: today.toISOString() });
    if (error) throw error;
    dashboardStats = data;
    renderStatsCards(data);
    updateBadges(data);
  } catch (err) {
    console.error('Dashboard stats error:', err);
    renderStatsCardsFallback();
  }
}

function renderStatsCards(s) {
  const grid = document.getElementById('statsGrid');
  if (!grid) return;
  const rev = typeof s.todayRevenue === 'number' ? `₹${s.todayRevenue.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '₹0';
  grid.innerHTML = `
    <div class="stat-card primary"><div class="stat-card-header"><div class="stat-card-icon">🛒</div></div><div class="stat-card-value">${s.todayOrders || 0}</div><div class="stat-card-label">Today's Orders</div></div>
    <div class="stat-card success"><div class="stat-card-header"><div class="stat-card-icon">💰</div></div><div class="stat-card-value">${rev}</div><div class="stat-card-label">Today's Revenue</div></div>
    <div class="stat-card warning"><div class="stat-card-header"><div class="stat-card-icon">⏳</div></div><div class="stat-card-value">${s.pendingOrders || 0}</div><div class="stat-card-label">Pending Orders</div></div>
    <div class="stat-card info"><div class="stat-card-header"><div class="stat-card-icon">💊</div></div><div class="stat-card-value">${s.totalProducts || 0}</div><div class="stat-card-label">Total Products</div></div>
    <div class="stat-card primary"><div class="stat-card-header"><div class="stat-card-icon">👥</div></div><div class="stat-card-value">${s.totalUsers || 0}</div><div class="stat-card-label">Total Users</div></div>
    <div class="stat-card error"><div class="stat-card-header"><div class="stat-card-icon">🔔</div></div><div class="stat-card-value">${s.pendingUsers || 0}</div><div class="stat-card-label">Pending Verification</div></div>
  `;
}

function renderStatsCardsFallback() {
  const grid = document.getElementById('statsGrid');
  if (!grid) return;
  const items = [['🛒','Today\'s Orders'],['💰','Today\'s Revenue'],['⏳','Pending Orders'],['💊','Total Products'],['👥','Total Users'],['🔔','Pending Verification']];
  grid.innerHTML = items.map(([i,l]) => `<div class="stat-card"><div class="stat-card-header"><div class="stat-card-icon">${i}</div></div><div class="stat-card-value">—</div><div class="stat-card-label">${l}</div></div>`).join('');
}

function renderStatCardSkeleton(count) {
  let h = '';
  for (let i = 0; i < count; i++) h += `<div class="stat-card" style="opacity:.5"><div class="stat-card-header"><div class="stat-card-icon" style="background:var(--bg-elevated)">⏳</div></div><div class="stat-card-value" style="color:var(--text-muted)">...</div><div class="stat-card-label">Loading</div></div>`;
  return h;
}

function updateBadges(s) {
  const ob = document.getElementById('pendingOrdersBadge');
  if (ob) { if (s.pendingOrders > 0) { ob.textContent = s.pendingOrders; ob.style.display = ''; } else ob.style.display = 'none'; }
  const ub = document.getElementById('pendingUsersBadge');
  if (ub) { if (s.pendingUsers > 0) { ub.textContent = s.pendingUsers; ub.style.display = ''; } else ub.style.display = 'none'; }
}

function renderQuickActionCards() {
  const actions = [
    { icon: '📋', title: 'Process Orders', desc: 'Review and process pending orders', page: 'orders' },
    { icon: '📦', title: 'Check Stock', desc: 'View low stock alerts', page: 'stock' },
    { icon: '👥', title: 'Verify Users', desc: 'Approve pending registrations', page: 'users' },
    { icon: '📈', title: 'View Analytics', desc: 'Sales & revenue insights', page: 'analytics' },
  ];
  return actions.map(a => `<div class="quick-action-card" onclick="navigateTo('${a.page}')" style="cursor:pointer"><div class="quick-action-icon">${a.icon}</div><div class="quick-action-info"><h4>${a.title}</h4><p>${a.desc}</p></div></div>`).join('');
}

function renderSystemStatus() {
  return `<ul class="activity-list">
    <li class="activity-item"><span class="activity-dot success"></span><span class="activity-text">Supabase connection active</span><span class="activity-time">Live</span></li>
    <li class="activity-item"><span class="activity-dot success"></span><span class="activity-text">Authentication service running</span><span class="activity-time">Operational</span></li>
    <li class="activity-item"><span class="activity-dot primary"></span><span class="activity-text">Admin session active</span><span class="activity-time">Now</span></li>
    <li class="activity-item"><span class="activity-dot success"></span><span class="activity-text">All modules operational</span><span class="activity-time">✓</span></li>
  </ul>`;
}

// ============================================================
// ANALYTICS PAGE
// ============================================================

async function renderAnalytics() {
  pageContent.innerHTML = `
    <div class="section-card mb-2">
      <div class="section-card-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">
        <h3 class="section-card-title">Date Range</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap" id="analyticsRangeGroup">
          <button class="btn btn-primary btn-sm option-chip active" data-range="today">Today</button>
          <button class="btn option-chip" data-range="week">This Week</button>
          <button class="btn option-chip" data-range="month">This Month</button>
          <button class="btn option-chip" data-range="custom">Custom</button>
        </div>
        <div id="customDateInputs" class="hidden" style="display:none;gap:8px;align-items:center">
          <input type="date" id="analyticsFrom" class="form-input" style="width:auto">
          <span>to</span>
          <input type="date" id="analyticsTo" class="form-input" style="width:auto">
          <button class="btn btn-primary" id="analyticsApplyCustom">Apply</button>
        </div>
      </div>
    </div>
    <div id="analyticsContent"><div class="text-center mt-3">${skeleton('200px','20px')}</div></div>
  `;

  // Wire range buttons
  document.querySelectorAll('#analyticsRangeGroup .option-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#analyticsRangeGroup .option-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const r = btn.dataset.range;
      const customBox = document.getElementById('customDateInputs');
      if (r === 'custom') { customBox.style.display = 'flex'; customBox.classList.remove('hidden'); }
      else { customBox.style.display = 'none'; loadAnalytics(r); }
    });
  });

  const applyBtn = document.getElementById('analyticsApplyCustom');
  if (applyBtn) applyBtn.addEventListener('click', () => loadAnalytics('custom'));

  loadAnalytics('today');
}

async function loadAnalytics(range) {
  const container = document.getElementById('analyticsContent');
  if (!container) return;
  container.innerHTML = `<div class="text-center mt-3" style="padding:40px;color:var(--text-muted)">Loading analytics...</div>`;

  let fromDate = new Date(), toDate = new Date();
  if (range === 'today') { fromDate.setHours(0,0,0,0); toDate.setHours(23,59,59,999); }
  else if (range === 'week') { fromDate.setDate(fromDate.getDate() - fromDate.getDay()); fromDate.setHours(0,0,0,0); toDate.setHours(23,59,59,999); }
  else if (range === 'month') { fromDate.setDate(1); fromDate.setHours(0,0,0,0); toDate.setHours(23,59,59,999); }
  else if (range === 'custom') {
    const f = document.getElementById('analyticsFrom')?.value;
    const t = document.getElementById('analyticsTo')?.value;
    if (!f || !t) { container.innerHTML = '<div class="text-center mt-3" style="color:var(--text-muted)">Please select both dates.</div>'; return; }
    fromDate = new Date(f); toDate = new Date(t); toDate.setHours(23,59,59,999);
  }

  try {
    const { data, error } = await sb.rpc('get_sales_analytics', {
      p_from_date: fromDate.toISOString(),
      p_to_date: toDate.toISOString(),
      p_limit: 10,
    });
    if (error) throw error;
    renderAnalyticsData(container, data, fromDate, toDate);
  } catch (err) {
    console.error('Analytics error:', err);
    container.innerHTML = `<div class="text-center mt-3" style="color:var(--color-error)">Failed to load analytics: ${err.message}</div>`;
  }
}

function renderAnalyticsData(container, data, fromDate, toDate) {
  const summary = data?.summary || {};
  const daily = data?.daily_revenue || [];
  const topProducts = data?.top_products || [];
  const topRetailers = data?.top_retailers || [];
  const statusBreakdown = data?.status_breakdown || [];

  const maxRev = Math.max(...daily.map(d => d.revenue || 0), 1);

  container.innerHTML = `
    <div class="stats-grid mb-2">
      <div class="stat-card success"><div class="stat-card-header"><div class="stat-card-icon">💰</div></div><div class="stat-card-value">${fmtCurrency(summary.total_revenue)}</div><div class="stat-card-label">Total Revenue</div></div>
      <div class="stat-card primary"><div class="stat-card-header"><div class="stat-card-icon">🛒</div></div><div class="stat-card-value">${summary.total_orders || 0}</div><div class="stat-card-label">Total Orders</div></div>
      <div class="stat-card info"><div class="stat-card-header"><div class="stat-card-icon">📦</div></div><div class="stat-card-value">${summary.total_items_sold || 0}</div><div class="stat-card-label">Items Sold</div></div>
      <div class="stat-card warning"><div class="stat-card-header"><div class="stat-card-icon">📊</div></div><div class="stat-card-value">${fmtCurrency(summary.avg_order_value)}</div><div class="stat-card-label">Avg Order Value</div></div>
    </div>

    <!-- Daily Revenue Chart -->
    <div class="section-card mb-2">
      <div class="section-card-header" style="display:flex;justify-content:space-between;align-items:center">
        <h3 class="section-card-title">Daily Revenue</h3>
        <button class="btn btn-secondary" id="csvDownloadBtn">📥 Export CSV</button>
      </div>
      <div class="revenue-chart-bar-container" id="revenueChart">
        ${daily.length === 0 ? '<div style="flex:1;text-align:center;color:var(--text-muted);align-self:center">No data for this period</div>' :
          daily.map(d => {
            const pct = Math.max(4, (d.revenue / maxRev) * 140);
            const label = new Date(d.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
            return `<div class="chart-bar-col"><div class="chart-bar-rect" style="height:${pct}px"><div class="chart-bar-tooltip">${fmtCurrency(d.revenue)}<br>${d.order_count} orders</div></div><div class="chart-bar-label">${label}</div></div>`;
          }).join('')}
      </div>
    </div>

    <div class="dashboard-bottom-grid">
      <!-- Status Breakdown -->
      <div class="section-card">
        <div class="section-card-header"><h3 class="section-card-title">Status Breakdown</h3></div>
        <div style="display:flex;flex-direction:column;gap:10px;margin-top:8px">
          ${statusBreakdown.map(s => {
            const pct = summary.total_orders > 0 ? ((s.count / summary.total_orders) * 100).toFixed(1) : 0;
            const color = getStatusColor(s.status);
            return `<div><div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px"><span style="text-transform:capitalize">${s.status.replace(/_/g,' ')}</span><span>${s.count} (${pct}%)</span></div><div class="progress-track"><div class="progress-fill" style="width:${pct}%;background:${color}"></div></div></div>`;
          }).join('')}
        </div>
      </div>

      <!-- Top Products -->
      <div class="section-card">
        <div class="section-card-header"><h3 class="section-card-title">Top Selling Products</h3></div>
        ${topProducts.length === 0 ? '<p style="color:var(--text-muted);font-size:13px">No product data</p>' : `
        <div class="table-responsive" style="border:none">
          <table class="data-table"><thead><tr><th>#</th><th>Product</th><th>Qty</th><th>Revenue</th></tr></thead><tbody>
          ${topProducts.map((p, i) => `<tr><td>${i+1}</td><td>${p.product_name || '—'}</td><td>${p.quantity_sold || 0}</td><td>${fmtCurrency(p.revenue)}</td></tr>`).join('')}
          </tbody></table>
        </div>`}
      </div>
    </div>

    <!-- Top Retailers -->
    <div class="section-card mt-2">
      <div class="section-card-header"><h3 class="section-card-title">Top Retailers</h3></div>
      ${topRetailers.length === 0 ? '<p style="color:var(--text-muted);font-size:13px">No retailer data</p>' : `
      <div class="table-responsive" style="border:none">
        <table class="data-table"><thead><tr><th>#</th><th>Retailer</th><th>Orders</th><th>Revenue</th></tr></thead><tbody>
        ${topRetailers.map((r, i) => `<tr><td>${i+1}</td><td>${r.retailer_name || '—'}</td><td>${r.order_count || 0}</td><td>${fmtCurrency(r.revenue)}</td></tr>`).join('')}
        </tbody></table>
      </div>`}
    </div>
  `;

  // CSV download
  document.getElementById('csvDownloadBtn')?.addEventListener('click', () => {
    let csv = 'Date,Revenue,Orders\n';
    daily.forEach(d => csv += `${d.date},${d.revenue},${d.order_count}\n`);
    csv += `\nTop Products\nProduct,Qty,Revenue\n`;
    topProducts.forEach(p => csv += `"${p.product_name}",${p.quantity_sold},${p.revenue}\n`);
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `analytics_${fmtDate(fromDate)}_${fmtDate(toDate)}.csv`; a.click();
  });
}

function getStatusColor(status) {
  const m = { pending: '#FFA500', pending_payment: '#FFD700', approved: '#4A90D9', packed: '#8B83FF', dispatched: '#00C896', delivered: '#00A67E', cancelled: '#FF6B6B', rejected: '#EE5A24', delivery_failed: '#FF6B6B' };
  return m[status] || '#6C63FF';
}

// ============================================================
// ORDERS PAGE
// ============================================================

async function renderOrders() {
  _ordersState = { orders: [], selected: new Set(), batchMode: false };

  pageContent.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px">
      <div style="display:flex;gap:8px" id="orderBatchActions" class="hidden">
        <select id="batchStatusSelect" class="form-select" style="width:auto"><option value="approved">Approve</option><option value="packed">Pack</option><option value="dispatched">Dispatch</option><option value="delivered">Deliver</option><option value="cancelled">Cancel</option></select>
        <button class="btn btn-primary" id="batchApplyBtn">Apply to Selected</button>
        <button class="btn btn-secondary" id="batchCancelBtn">Cancel</button>
      </div>
      <button class="btn btn-secondary" id="batchToggleBtn">☑️ Batch Select</button>
    </div>
    <div id="ordersAlarmBanner"></div>
    <div class="pipeline-container" id="ordersPipeline">
      <div class="pipeline-column"><div class="pipeline-column-header"><span class="pipeline-column-title">🔴 Incoming</span><span class="pipeline-column-badge" id="incomingCount">0</span></div><div class="pipeline-cards" id="incomingCards"><div style="color:var(--text-muted);font-size:13px;padding:20px;text-align:center">Loading...</div></div></div>
      <div class="pipeline-column"><div class="pipeline-column-header"><span class="pipeline-column-title">🟡 Active</span><span class="pipeline-column-badge" id="activeCount">0</span></div><div class="pipeline-cards" id="activeCards"><div style="color:var(--text-muted);font-size:13px;padding:20px;text-align:center">Loading...</div></div></div>
      <div class="pipeline-column"><div class="pipeline-column-header"><span class="pipeline-column-title">🟢 Completed</span><span class="pipeline-column-badge" id="completedCount">0</span></div><div class="pipeline-cards" id="completedCards"><div style="color:var(--text-muted);font-size:13px;padding:20px;text-align:center">Loading...</div></div></div>
    </div>
  `;

  document.getElementById('batchToggleBtn')?.addEventListener('click', () => {
    _ordersState.batchMode = !_ordersState.batchMode;
    _ordersState.selected.clear();
    document.getElementById('orderBatchActions')?.classList.toggle('hidden', !_ordersState.batchMode);
    document.getElementById('batchToggleBtn').textContent = _ordersState.batchMode ? '✖ Exit Batch' : '☑️ Batch Select';
    renderOrderCards();
  });

  document.getElementById('batchApplyBtn')?.addEventListener('click', async () => {
    const ids = Array.from(_ordersState.selected);
    if (ids.length === 0) { showToast('No orders selected', 'warning'); return; }
    const status = document.getElementById('batchStatusSelect').value;
    try {
      const { error } = await sb.rpc('batch_update_order_status', { p_order_ids: ids, p_new_status: status });
      if (error) throw error;
      showToast(`${ids.length} orders updated to ${status}`, 'success');
      _ordersState.selected.clear();
      loadOrders();
    } catch (err) { showToast(err.message, 'error'); }
  });

  document.getElementById('batchCancelBtn')?.addEventListener('click', () => {
    _ordersState.batchMode = false;
    _ordersState.selected.clear();
    document.getElementById('orderBatchActions')?.classList.add('hidden');
    document.getElementById('batchToggleBtn').textContent = '☑️ Batch Select';
    renderOrderCards();
  });

  await loadOrders();
  setupOrdersRealtime();
}

async function loadOrders() {
  try {
    const { data, error } = await sb.from('orders').select(`
      id, status, grand_total, payment_mode, fulfillment_mode, created_at, notes,
      user:profiles!orders_user_id_fkey(id, name, business_name, phone),
      rider:profiles!orders_rider_id_fkey(id, name, phone),
      order_items(id, qty, unit_price, line_total, product:products(name))
    `).order('created_at', { ascending: false }).limit(200);
    if (error) throw error;
    _ordersState.orders = (data || []).map(o => ({
      ...o,
      order_items: (o.order_items || []).map(it => ({
        ...it,
        product_name: it.product?.name || 'Unknown Product',
        quantity: it.qty,
        total_price: it.line_total
      }))
    }));
    renderOrderCards();
  } catch (err) {
    console.error('Orders load error:', err);
    showToast('Failed to load orders', 'error');
  }
}

function renderOrderCards() {
  const incoming = ['pending', 'pending_payment', 'cancellation_requested'];
  const active = ['approved', 'packed', 'dispatched', 'assigned', 'accepted'];
  const completed = ['delivered', 'cancelled', 'rejected', 'delivery_failed'];

  const groups = { incoming: [], active: [], completed: [] };
  _ordersState.orders.forEach(o => {
    if (incoming.includes(o.status)) groups.incoming.push(o);
    else if (active.includes(o.status)) groups.active.push(o);
    else groups.completed.push(o);
  });

  const renderCard = (o) => {
    const customerName = o.user?.business_name || o.user?.name || 'Unknown';
    const itemCount = o.order_items?.length || 0;
    const sel = _ordersState.selected.has(o.id) ? 'pipeline-card-selected' : '';
    const checkbox = _ordersState.batchMode ? `<input type="checkbox" ${_ordersState.selected.has(o.id) ? 'checked' : ''} style="accent-color:var(--color-primary);width:16px;height:16px;margin-right:8px" onclick="event.stopPropagation();toggleOrderSelect('${o.id}')">` : '';

    return `<div class="pipeline-card ${sel}" onclick="${_ordersState.batchMode ? `toggleOrderSelect('${o.id}')` : `openOrderDetail('${o.id}')`}">
      <div class="pipeline-card-header">${checkbox}<span class="pipeline-card-id">#${o.id.slice(0,8)}</span><span class="pipeline-card-time">${timeAgo(o.created_at)}</span></div>
      <div class="pipeline-card-body">${customerName} · ${itemCount} items</div>
      <div class="pipeline-card-footer"><span class="badge badge-${getStatusBadgeClass(o.status)}">${o.status.replace(/_/g,' ')}</span><span class="pipeline-card-price">${fmtCurrency(o.grand_total)}</span></div>
    </div>`;
  };

  const renderCol = (colId, countId, orders) => {
    const el = document.getElementById(colId);
    const cnt = document.getElementById(countId);
    if (el) el.innerHTML = orders.length === 0 ? '<div style="color:var(--text-muted);font-size:13px;padding:20px;text-align:center">No orders</div>' : orders.map(renderCard).join('');
    if (cnt) cnt.textContent = orders.length;
  };

  renderCol('incomingCards', 'incomingCount', groups.incoming);
  renderCol('activeCards', 'activeCount', groups.active);
  renderCol('completedCards', 'completedCount', groups.completed);

  // Alarm banner for pending
  const banner = document.getElementById('ordersAlarmBanner');
  if (banner) {
    if (groups.incoming.length > 0) {
      banner.innerHTML = `<div class="alarm-banner"><span>🔔 ${groups.incoming.length} incoming order(s) need attention!</span></div>`;
    } else banner.innerHTML = '';
  }
}

function getStatusBadgeClass(s) {
  const m = { pending: 'warning', pending_payment: 'warning', approved: 'info', packed: 'primary', dispatched: 'info', delivered: 'success', cancelled: 'danger', rejected: 'danger', delivery_failed: 'danger', cancellation_requested: 'danger', assigned: 'info', accepted: 'info' };
  return m[s] || 'primary';
}

window.toggleOrderSelect = function(id) {
  if (_ordersState.selected.has(id)) _ordersState.selected.delete(id);
  else _ordersState.selected.add(id);
  renderOrderCards();
};

window.openOrderDetail = async function(id) {
  const order = _ordersState.orders.find(o => o.id === id);
  if (!order) return;

  const nextStatus = getNextStatus(order.status);
  const customerName = order.user?.business_name || order.user?.name || 'Unknown';
  const riderName = order.rider?.name || 'Unassigned';

  // Load timeline
  let timelineHtml = '';
  try {
    const { data: timeline } = await sb.rpc('get_order_timeline', { p_order_id: id });
    if (timeline && timeline.length > 0) {
      timelineHtml = `<div class="timeline">${timeline.map((t, i) => `<div class="timeline-step ${i === 0 ? 'active' : 'success'}"><div class="timeline-step-title">${(t.status || '').replace(/_/g,' ')}</div><div class="timeline-step-desc">${fmtDateTime(t.created_at)}${t.changed_by_name ? ` by ${t.changed_by_name}` : ''}</div></div>`).join('')}</div>`;
    }
  } catch(e) { timelineHtml = '<p style="color:var(--text-muted);font-size:12px">Timeline unavailable</p>'; }

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card large">
      <div class="modal-header"><h3 class="modal-title">Order #${id.slice(0,8)}</h3><button class="modal-close" onclick="this.closest('.modal-overlay').remove()">✕</button></div>
      <div class="modal-body">
        <div class="form-grid mb-2">
          <div><span style="font-size:12px;color:var(--text-muted)">Customer</span><div style="font-weight:600">${customerName}</div><div style="font-size:12px;color:var(--text-muted)">${order.user?.phone || ''}</div></div>
          <div><span style="font-size:12px;color:var(--text-muted)">Status</span><div><span class="badge badge-${getStatusBadgeClass(order.status)}">${order.status.replace(/_/g,' ')}</span></div></div>
          <div><span style="font-size:12px;color:var(--text-muted)">Payment</span><div style="font-weight:600;text-transform:uppercase">${order.payment_mode || '—'}</div></div>
          <div><span style="font-size:12px;color:var(--text-muted)">Fulfillment</span><div style="font-weight:600;text-transform:capitalize">${(order.fulfillment_mode || 'delivery').replace(/_/g,' ')}</div></div>
          <div><span style="font-size:12px;color:var(--text-muted)">Rider</span><div style="font-weight:600">${riderName}</div></div>
          <div><span style="font-size:12px;color:var(--text-muted)">Total</span><div style="font-weight:800;font-size:18px">${fmtCurrency(order.grand_total)}</div></div>
        </div>
        ${order.notes ? `<div style="background:var(--bg-surface);padding:10px;border-radius:8px;margin-bottom:12px;font-size:13px">📝 ${order.notes}</div>` : ''}
        <h4 style="margin-bottom:8px;font-size:14px;font-weight:700">Items</h4>
        <div class="table-responsive mb-2">
          <table class="data-table"><thead><tr><th>Product</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead><tbody>
          ${(order.order_items || []).map(it => `<tr><td>${it.product_name}</td><td>${it.quantity}</td><td>${fmtCurrency(it.unit_price)}</td><td>${fmtCurrency(it.total_price)}</td></tr>`).join('')}
          </tbody></table>
        </div>
        <h4 style="margin-bottom:8px;font-size:14px;font-weight:700">Timeline</h4>
        ${timelineHtml || '<p style="color:var(--text-muted);font-size:12px">No timeline data</p>'}
      </div>
      <div class="modal-footer">
        ${!['delivered','cancelled','rejected'].includes(order.status) && order.fulfillment_mode !== 'self_pickup' ? `<button class="btn btn-secondary" onclick="assignRiderModal('${id}')">🚚 Assign Rider</button>` : ''}
        ${nextStatus ? `<button class="btn btn-primary" onclick="advanceOrderStatus('${id}','${nextStatus}')">✓ Mark ${nextStatus.replace(/_/g,' ')}</button>` : ''}
        ${!['delivered','cancelled','rejected'].includes(order.status) ? `<button class="btn btn-danger" onclick="advanceOrderStatus('${id}','cancelled')">✕ Cancel</button>` : ''}
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
};

function getNextStatus(s) {
  const flow = { pending: 'approved', pending_payment: 'pending', approved: 'packed', packed: 'dispatched', dispatched: 'delivered', assigned: 'accepted', accepted: 'dispatched', cancellation_requested: 'cancelled' };
  return flow[s] || null;
}

window.advanceOrderStatus = async function(id, newStatus) {
  try {
    const { error } = await sb.from('orders').update({ status: newStatus }).eq('id', id);
    if (error) throw error;
    showToast(`Order updated to ${newStatus}`, 'success');
    document.querySelector('.modal-overlay')?.remove();
    loadOrders();
  } catch (err) { showToast(err.message, 'error'); }
};

window.assignRiderModal = async function(orderId) {
  try {
    const { data: riders } = await sb.from('profiles').select('id, name, phone').eq('role', 'delivery').eq('approved', true);
    if (!riders || riders.length === 0) { showToast('No delivery personnel found', 'warning'); return; }

    // Remove existing modal first
    document.querySelector('.modal-overlay')?.remove();

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-card">
        <div class="modal-header"><h3 class="modal-title">Assign Rider</h3><button class="modal-close" onclick="this.closest('.modal-overlay').remove()">✕</button></div>
        <div class="modal-body">
          ${riders.map(r => `<div class="driver-card" onclick="doAssignRider('${orderId}','${r.id}')"><div class="driver-card-name">${r.name}</div><div class="driver-card-meta">📱 ${r.phone || 'No phone'}</div></div>`).join('')}
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  } catch (err) { showToast(err.message, 'error'); }
};

window.doAssignRider = async function(orderId, riderId) {
  try {
    const { error } = await sb.from('orders').update({ assigned_to: riderId, status: 'assigned' }).eq('id', orderId);
    if (error) throw error;
    showToast('Rider assigned', 'success');
    document.querySelector('.modal-overlay')?.remove();
    loadOrders();
  } catch (err) { showToast(err.message, 'error'); }
};

function setupOrdersRealtime() {
  const channel = sb.channel('orders-realtime').on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => {
    if (currentPage === 'orders') loadOrders();
  }).subscribe();
  _realtimeChannels.push(channel);
}

// ============================================================
// PRODUCTS PAGE
// ============================================================

async function renderProducts() {
  pageContent.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px">
      <div class="search-dropdown-wrap" style="flex:1;min-width:200px">
        <input type="text" class="form-input" id="productSearch" placeholder="Search products by name or SKU..." style="margin:0">
      </div>
      <div style="display:flex;gap:8px">
        <div class="option-pill-group" id="productStatusFilter">
          <button class="option-chip active" data-filter="all">All</button>
          <button class="option-chip" data-filter="active">Active</button>
          <button class="option-chip" data-filter="inactive">Inactive</button>
          <button class="option-chip" data-filter="low_stock">Low Stock</button>
        </div>
      </div>
      <button class="btn btn-primary" id="addProductBtn">+ Add Product</button>
    </div>
    <div id="productsTableContainer"><div class="text-center mt-3" style="color:var(--text-muted)">Loading products...</div></div>
  `;

  let allProducts = [];
  let filterMode = 'all';
  let searchTerm = '';

  async function loadProducts() {
    try {
      const container = document.getElementById('productsTableContainer');
      if (container) container.innerHTML = '<div class="text-center mt-3" style="color:var(--text-muted)">Loading products catalog (4,500+ items)...</div>';
      allProducts = await fetchAllProducts('*', false);
      renderProductsTable();
    } catch (err) {
      console.error('Products load error:', err);
      showToast('Failed to load products', 'error');
    }
  }

  function renderProductsTable() {
    let filtered = allProducts;
    if (filterMode === 'active') filtered = filtered.filter(p => p.is_active);
    else if (filterMode === 'inactive') filtered = filtered.filter(p => !p.is_active);
    else if (filterMode === 'low_stock') filtered = filtered.filter(p => p.is_active && (p.stock_quantity || 0) < 10);

    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      filtered = filtered.filter(p => (p.name || '').toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q) || (p.barcode_sku || '').toLowerCase().includes(q));
    }

    const container = document.getElementById('productsTableContainer');
    if (!container) return;

    if (filtered.length === 0) {
      container.innerHTML = '<div class="text-center mt-3" style="color:var(--text-muted);padding:40px">No products found</div>';
      return;
    }

    container.innerHTML = `
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;font-weight:600">
        Showing ${filtered.length.toLocaleString('en-IN')} of ${allProducts.length.toLocaleString('en-IN')} total products
      </div>
      <div class="table-responsive">
        <table class="data-table"><thead><tr><th>Name</th><th>SKU</th><th>Category</th><th>MRP</th><th>Price</th><th>GST%</th><th>Stock</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${filtered.map(p => {
          const isZeroPrice = (p.selling_price || 0) <= 0 || (p.mrp || 0) <= 0;
          return `<tr>
          <td style="font-weight:600">
            ${p.name}
            ${isZeroPrice ? '<span style="display:inline-block;font-size:10px;color:var(--color-error);background:rgba(239,68,68,0.1);padding:2px 6px;border-radius:4px;margin-left:6px;font-weight:700">0 Price (Out of Stock)</span>' : ''}
          </td>
          <td style="font-size:12px;color:var(--text-muted)">${p.sku || p.barcode_sku || '—'}</td>
          <td><span class="badge badge-info">${p.category || '—'}</span></td>
          <td>${fmtCurrency(p.mrp)}</td>
          <td style="font-weight:600;color:${isZeroPrice ? 'var(--color-error)' : 'inherit'}">${fmtCurrency(p.selling_price)}</td>
          <td>${p.gst_percent || 0}%</td>
          <td style="font-weight:600;color:${(p.stock_quantity || 0) < 10 || isZeroPrice ? 'var(--color-error)' : 'var(--color-success)'}">
            ${p.stock_quantity || 0}
          </td>
          <td><span class="badge badge-${p.is_active && !isZeroPrice ? 'success' : 'danger'}">${p.is_active ? (isZeroPrice ? 'Out of Stock' : 'Active') : 'Inactive'}</span></td>
          <td><button class="btn btn-secondary" style="padding:6px 10px;font-size:12px" onclick="openProductForm('${p.id}')">Edit</button></td>
        </tr>`;
        }).join('')}</tbody></table>
      </div>
    `;
  }

  // Filter buttons
  document.querySelectorAll('#productStatusFilter .option-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#productStatusFilter .option-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      filterMode = btn.dataset.filter;
      renderProductsTable();
    });
  });

  // Search
  document.getElementById('productSearch')?.addEventListener('input', (e) => {
    searchTerm = e.target.value;
    renderProductsTable();
  });

  // Add product
  document.getElementById('addProductBtn')?.addEventListener('click', () => openProductForm(null));

  // Store loadProducts for refresh
  window._refreshProducts = loadProducts;
  await loadProducts();
}

window.openProductForm = async function(productId) {
  let product = null;
  if (productId) {
    try {
      const { data } = await sb.from('products').select('*').eq('id', productId).single();
      product = data;
    } catch(e) { showToast('Failed to load product', 'error'); return; }
  }

  // Load categories
  let categories = [];
  try {
    const { data } = await sb.rpc('get_product_categories');
    if (data) categories = data.map(c => c.category).filter(Boolean);
  } catch(e) {}

  const isNew = !product;
  const f = product || { name: '', company: '', category: '', selling_price: '', mrp: '', gst_percent: 18, pack_size: '', stock_quantity: 0, is_active: true, barcode_sku: '' };

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'productFormModal';
  modal.innerHTML = `
    <div class="modal-card large">
      <div class="modal-header"><h3 class="modal-title">${isNew ? 'Add Product' : 'Edit Product'}</h3><button class="modal-close" onclick="this.closest('.modal-overlay').remove()">✕</button></div>
      <div class="modal-body">
        <div class="form-grid">
          <div class="form-group form-group-full"><label class="form-label">Product Name *</label><input class="form-input" id="pf_name" value="${f.name || ''}"></div>
          <div class="form-group"><label class="form-label">Company</label><input class="form-input" id="pf_company" value="${f.company || ''}"></div>
          <div class="form-group"><label class="form-label">Category</label>
            <input class="form-input" id="pf_category" value="${f.category || ''}" list="categoryList" placeholder="Type or select">
            <datalist id="categoryList">${categories.map(c => `<option value="${c}">`).join('')}</datalist>
          </div>
          <div class="form-group"><label class="form-label">Selling Price *</label><input type="number" step="0.01" class="form-input" id="pf_price" value="${f.selling_price || ''}"></div>
          <div class="form-group"><label class="form-label">MRP *</label><input type="number" step="0.01" class="form-input" id="pf_mrp" value="${f.mrp || ''}"></div>
          <div class="form-group"><label class="form-label">GST %</label>
            <div class="option-pill-group" id="pf_gst_group">
              ${[0,5,12,18,28].map(g => `<button class="option-chip ${f.gst_percent === g ? 'active' : ''}" data-gst="${g}">${g}%</button>`).join('')}
            </div>
          </div>
          <div class="form-group"><label class="form-label">Pack Size / Unit</label><input class="form-input" id="pf_unit" value="${f.pack_size || ''}" placeholder="e.g. 10 Strips"></div>
          <div class="form-group"><label class="form-label">Stock Quantity</label><input type="number" class="form-input" id="pf_stock" value="${f.stock_quantity || 0}"></div>
          <div class="form-group"><label class="form-label">Barcode / SKU</label><input class="form-input" id="pf_barcode" value="${f.barcode_sku || ''}" placeholder="e.g. 8901234567890"></div>
          <div class="form-group">
            <div class="switch-container"><span style="font-weight:600">Active (Visible to retailers)</span><label class="switch"><input type="checkbox" id="pf_active" ${f.is_active ? 'checked' : ''}><span class="slider"></span></label></div>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        ${!isNew && f.is_active ? `<button class="btn btn-danger" id="pf_deactivate">Deactivate</button>` : ''}
        <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
        <button class="btn btn-primary" id="pf_save">${isNew ? 'Create Product' : 'Save Changes'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  // GST chip toggle
  let selectedGst = f.gst_percent;
  modal.querySelectorAll('#pf_gst_group .option-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      modal.querySelectorAll('#pf_gst_group .option-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      selectedGst = parseInt(chip.dataset.gst);
    });
  });

  // Save
  modal.querySelector('#pf_save')?.addEventListener('click', async () => {
    const name = modal.querySelector('#pf_name').value.trim();
    const price = parseFloat(modal.querySelector('#pf_price').value);
    const mrp = parseFloat(modal.querySelector('#pf_mrp').value);
    if (!name) { showToast('Product name is required', 'warning'); return; }
    if (isNaN(price) || price <= 0) { showToast('Valid selling price is required', 'warning'); return; }
    if (isNaN(mrp) || mrp < price) { showToast('MRP must be >= selling price', 'warning'); return; }

    try {
      const payload = {
        p_name: name,
        p_company: modal.querySelector('#pf_company').value.trim() || null,
        p_category: modal.querySelector('#pf_category').value.trim() || null,
        p_selling_price: price,
        p_mrp: mrp,
        p_gst_percent: selectedGst,
        p_unit: modal.querySelector('#pf_unit').value.trim() || null,
        p_stock_quantity: parseInt(modal.querySelector('#pf_stock').value) || 0,
        p_is_active: modal.querySelector('#pf_active').checked,
        p_barcode_sku: modal.querySelector('#pf_barcode').value.trim() || null,
      };
      if (!isNew) payload.p_id = productId;

      const { error } = await sb.rpc('upsert_product', payload);
      if (error) throw error;
      showToast(isNew ? 'Product created!' : 'Product updated!', 'success');
      modal.remove();
      if (window._refreshProducts) window._refreshProducts();
    } catch (err) { showToast(err.message, 'error'); }
  });

  // Deactivate
  modal.querySelector('#pf_deactivate')?.addEventListener('click', async () => {
    if (!confirm('Are you sure you want to deactivate this product?')) return;
    try {
      const { error } = await sb.rpc('deactivate_product', { p_product_id: productId });
      if (error) throw error;
      showToast('Product deactivated', 'success');
      modal.remove();
      if (window._refreshProducts) window._refreshProducts();
    } catch (err) { showToast(err.message, 'error'); }
  });
};

// ============================================================
// STOCK MANAGEMENT PAGE
// ============================================================

async function renderStock() {
  pageContent.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">
      <div class="option-pill-group" id="stockTabGroup">
        <button class="option-chip active" data-tab="low">⚠️ Low Stock</button>
        <button class="option-chip" data-tab="all">All Products</button>
        <button class="option-chip" data-tab="bulk">📦 Bulk Restock</button>
      </div>
      <input type="text" class="form-input" id="stockSearch" placeholder="Search..." style="margin:0;flex:1;min-width:180px">
    </div>
    <div id="stockContent"><div class="text-center mt-3" style="color:var(--text-muted)">Loading...</div></div>
  `;

  let stockTab = 'low';
  let allProducts = [];
  let lowStockProducts = [];

  async function loadStockData() {
    try {
      const [all, lowStockRes] = await Promise.all([
        fetchAllProducts('id, name, sku, barcode_sku, stock_quantity, is_active, selling_price, category', true),
        sb.rpc('get_low_stock_products'),
      ]);
      allProducts = all || [];
      lowStockProducts = lowStockRes.data || [];
      renderStockTab();
    } catch (err) { showToast('Failed to load stock data', 'error'); }
  }

  function renderStockTab() {
    const container = document.getElementById('stockContent');
    if (!container) return;
    const search = (document.getElementById('stockSearch')?.value || '').toLowerCase();

    if (stockTab === 'low') {
      let items = lowStockProducts;
      if (search) items = items.filter(p => (p.name || '').toLowerCase().includes(search));
      container.innerHTML = items.length === 0 ? '<div class="text-center mt-3" style="color:var(--text-muted);padding:40px">✅ No low stock items</div>' : `
        <div class="table-responsive"><table class="data-table"><thead><tr><th>Product</th><th>Current Stock</th><th>Category</th><th>Action</th></tr></thead><tbody>
        ${items.map(p => `<tr><td style="font-weight:600">${p.name}</td><td style="color:var(--color-error);font-weight:700">${p.stock_quantity}</td><td>${p.category || '—'}</td><td><button class="btn btn-primary" style="padding:6px 12px;font-size:12px" onclick="openStockAdjust('${p.id}','${(p.name||'').replace(/'/g,"\\'")}',${p.stock_quantity})">Adjust</button></td></tr>`).join('')}
        </tbody></table></div>`;
    } else if (stockTab === 'all') {
      let items = allProducts;
      if (search) items = items.filter(p => (p.name || '').toLowerCase().includes(search));
      container.innerHTML = `
        <div class="table-responsive"><table class="data-table"><thead><tr><th>Product</th><th>SKU</th><th>Stock</th><th>Action</th></tr></thead><tbody>
        ${items.map(p => `<tr><td style="font-weight:600">${p.name}</td><td style="font-size:12px;color:var(--text-muted)">${p.sku || p.barcode_sku || '—'}</td><td style="font-weight:600;color:${(p.stock_quantity||0)<10?'var(--color-error)':'var(--color-success)'}">${p.stock_quantity || 0}</td><td><button class="btn btn-secondary" style="padding:6px 12px;font-size:12px" onclick="openStockAdjust('${p.id}','${(p.name||'').replace(/'/g,"\\'")}',${p.stock_quantity||0})">Adjust</button></td></tr>`).join('')}
        </tbody></table></div>`;
    } else if (stockTab === 'bulk') {
      let items = allProducts;
      if (search) items = items.filter(p => (p.name || '').toLowerCase().includes(search));
      container.innerHTML = `
        <div class="section-card">
          <p style="color:var(--text-muted);font-size:13px;margin-bottom:12px">Enter restock quantities for products. Leave blank or 0 to skip.</p>
          <div class="table-responsive"><table class="data-table"><thead><tr><th>Product</th><th>Current</th><th>Add Qty</th></tr></thead><tbody>
          ${items.map(p => `<tr><td style="font-weight:600">${p.name}</td><td>${p.stock_quantity || 0}</td><td><input type="number" min="0" class="form-input bulk-qty-input" data-pid="${p.id}" style="width:80px;margin:0;padding:6px 8px" value="0"></td></tr>`).join('')}
          </tbody></table></div>
          <div style="margin-top:16px;text-align:right">
            <label class="form-label">Reason</label>
            <input type="text" class="form-input" id="bulkReason" placeholder="e.g. Weekly restock" style="margin-bottom:12px">
            <button class="btn btn-primary" id="bulkRestockApply">📦 Apply Bulk Restock</button>
          </div>
        </div>`;

      document.getElementById('bulkRestockApply')?.addEventListener('click', async () => {
        const reason = document.getElementById('bulkReason')?.value.trim() || 'Bulk restock';
        const adjustments = [];
        document.querySelectorAll('.bulk-qty-input').forEach(inp => {
          const qty = parseInt(inp.value) || 0;
          if (qty > 0) adjustments.push({ product_id: inp.dataset.pid, delta: qty });
        });
        if (adjustments.length === 0) { showToast('No quantities entered', 'warning'); return; }
        try {
          const { error } = await sb.rpc('batch_adjust_stock', { p_adjustments: adjustments, p_reason: reason });
          if (error) throw error;
          showToast(`${adjustments.length} products restocked!`, 'success');
          loadStockData();
        } catch (err) { showToast(err.message, 'error'); }
      });
    }
  }

  document.querySelectorAll('#stockTabGroup .option-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#stockTabGroup .option-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      stockTab = btn.dataset.tab;
      renderStockTab();
    });
  });

  document.getElementById('stockSearch')?.addEventListener('input', renderStockTab);
  await loadStockData();
}

window.openStockAdjust = function(productId, productName, currentStock) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-header"><h3 class="modal-title">Adjust Stock — ${productName}</h3><button class="modal-close" onclick="this.closest('.modal-overlay').remove()">✕</button></div>
      <div class="modal-body">
        <p style="font-size:14px;margin-bottom:12px">Current stock: <strong>${currentStock}</strong></p>
        <div class="form-group"><label class="form-label">Quantity Change (positive to add, negative to remove)</label><input type="number" class="form-input" id="sa_delta" placeholder="e.g. 50 or -10"></div>
        <div class="form-group"><label class="form-label">Reason</label>
          <select class="form-select" id="sa_reason"><option>Restock</option><option>Write-off</option><option>Correction</option><option>Return</option><option>Damaged</option></select>
        </div>
      </div>
      <div class="modal-footer"><button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button><button class="btn btn-primary" id="sa_save">Apply</button></div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  modal.querySelector('#sa_save')?.addEventListener('click', async () => {
    const delta = parseInt(modal.querySelector('#sa_delta').value);
    const reason = modal.querySelector('#sa_reason').value;
    if (isNaN(delta) || delta === 0) { showToast('Enter a valid quantity', 'warning'); return; }
    try {
      const { error } = await sb.rpc('adjust_stock', { p_product_id: productId, p_delta: delta, p_reason: reason });
      if (error) throw error;
      showToast('Stock adjusted', 'success');
      modal.remove();
      // Refresh if on stock page
      if (currentPage === 'stock') renderStock();
    } catch (err) { showToast(err.message, 'error'); }
  });
};

// ============================================================
// USERS VERIFICATION PAGE
// ============================================================

async function renderUsers() {
  pageContent.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">
      <div class="option-pill-group" id="userFilterGroup">
        <button class="option-chip active" data-filter="pending">Pending</button>
        <button class="option-chip" data-filter="approved">Approved</button>
        <button class="option-chip" data-filter="all">All</button>
      </div>
      <input type="text" class="form-input" id="userSearch" placeholder="Search by name or phone..." style="margin:0;flex:1;min-width:180px">
    </div>
    <div id="usersTableContainer"><div class="text-center mt-3" style="color:var(--text-muted)">Loading...</div></div>
  `;

  let allUsers = [];
  let userFilter = 'pending';

  async function loadUsers() {
    try {
      const { data, error } = await sb.from('profiles').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      allUsers = data || [];
      renderUsersTable();
    } catch (err) { showToast('Failed to load users', 'error'); }
  }

  function renderUsersTable() {
    const search = (document.getElementById('userSearch')?.value || '').toLowerCase();
    let filtered = allUsers;
    if (userFilter === 'pending') filtered = filtered.filter(u => !u.approved);
    else if (userFilter === 'approved') filtered = filtered.filter(u => u.approved);

    if (search) filtered = filtered.filter(u => (u.name || '').toLowerCase().includes(search) || (u.phone || '').includes(search) || (u.business_name || '').toLowerCase().includes(search));

    const container = document.getElementById('usersTableContainer');
    if (!container) return;

    container.innerHTML = filtered.length === 0 ? '<div class="text-center mt-3" style="color:var(--text-muted);padding:40px">No users found</div>' : `
      <div class="table-responsive"><table class="data-table"><thead><tr><th>Name</th><th>Business</th><th>Phone</th><th>Role</th><th>Status</th><th>Registered</th><th>Actions</th></tr></thead><tbody>
      ${filtered.map(u => `<tr>
        <td style="font-weight:600">${u.name || '—'}</td>
        <td>${u.business_name || '—'}</td>
        <td>${u.phone || '—'}</td>
        <td><span class="badge badge-info">${u.role || '—'}</span></td>
        <td><span class="badge badge-${u.approved ? 'success' : 'warning'}">${u.approved ? 'Approved' : 'Pending'}</span></td>
        <td style="font-size:12px;color:var(--text-muted)">${fmtDate(u.created_at)}</td>
        <td style="display:flex;gap:6px">
          ${!u.approved ? `<button class="btn btn-success" style="padding:6px 10px;font-size:12px" onclick="toggleUserApproval('${u.id}',true)">✓ Approve</button>` : `<button class="btn btn-danger" style="padding:6px 10px;font-size:12px" onclick="toggleUserApproval('${u.id}',false)">✕ Suspend</button>`}
        </td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  document.querySelectorAll('#userFilterGroup .option-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#userFilterGroup .option-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      userFilter = btn.dataset.filter;
      renderUsersTable();
    });
  });
  document.getElementById('userSearch')?.addEventListener('input', renderUsersTable);
  window._refreshUsers = loadUsers;
  await loadUsers();
}

window.toggleUserApproval = async function(userId, approve) {
  try {
    const { error } = await sb.from('profiles').update({ approved: approve }).eq('id', userId);
    if (error) throw error;
    showToast(approve ? 'User approved!' : 'User suspended', approve ? 'success' : 'warning');
    if (window._refreshUsers) window._refreshUsers();
  } catch (err) { showToast(err.message, 'error'); }
};

// ============================================================
// RETAILERS PAGE
// ============================================================

async function renderRetailers() {
  pageContent.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">
      <input type="text" class="form-input" id="retailerSearch" placeholder="Search retailers..." style="margin:0;flex:1;min-width:200px">
    </div>
    <div id="retailersContent"><div class="text-center mt-3" style="color:var(--text-muted)">Loading retailers...</div></div>
  `;

  let retailers = [];

  async function loadRetailers() {
    try {
      const { data, error } = await sb.from('profiles').select('*').eq('role', 'retailer').order('business_name');
      if (error) throw error;
      retailers = data || [];
      renderRetailersList();
    } catch (err) { showToast('Failed to load retailers', 'error'); }
  }

  function renderRetailersList() {
    const search = (document.getElementById('retailerSearch')?.value || '').toLowerCase();
    let filtered = retailers;
    if (search) filtered = filtered.filter(r => (r.business_name || '').toLowerCase().includes(search) || (r.name || '').toLowerCase().includes(search) || (r.phone || '').includes(search));

    const container = document.getElementById('retailersContent');
    if (!container) return;

    container.innerHTML = filtered.length === 0 ? '<div class="text-center mt-3" style="color:var(--text-muted);padding:40px">No retailers found</div>' : `
      <div class="table-responsive"><table class="data-table"><thead><tr><th>Business</th><th>Contact</th><th>Phone</th><th>Area</th><th>Credit Limit</th><th>Credit Used</th><th>Status</th><th>Actions</th></tr></thead><tbody>
      ${filtered.map(r => {
        const limit = r.credit_limit || 0;
        const used = r.credit_used || 0;
        const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
        const barColor = pct > 80 ? 'var(--color-error)' : pct > 50 ? 'var(--color-warning)' : 'var(--color-success)';
        return `<tr>
          <td style="font-weight:600">${r.business_name || '—'}</td>
          <td>${r.name || '—'}</td>
          <td>${r.phone || '—'}</td>
          <td>${r.area || r.city || '—'}</td>
          <td>
            <div style="font-size:12px;font-weight:600">${fmtCurrency(limit)}</div>
            <div class="progress-track" style="width:80px"><div class="progress-fill" style="width:${pct}%;background:${barColor}"></div></div>
          </td>
          <td style="font-weight:600;color:${used > 0 ? 'var(--color-warning)' : 'var(--text-muted)'}">${fmtCurrency(used)}</td>
          <td><span class="badge badge-${r.approved ? 'success' : 'warning'}">${r.approved ? 'Active' : 'Suspended'}</span></td>
          <td><button class="btn btn-secondary" style="padding:6px 10px;font-size:12px" onclick="openRetailerDetail('${r.id}')">View</button></td>
        </tr>`;
      }).join('')}</tbody></table></div>`;
  }

  document.getElementById('retailerSearch')?.addEventListener('input', renderRetailersList);
  window._refreshRetailers = loadRetailers;
  await loadRetailers();
}

window.openRetailerDetail = async function(id) {
  const { data: r } = await sb.from('profiles').select('*').eq('id', id).single();
  if (!r) { showToast('Retailer not found', 'error'); return; }

  const limit = r.credit_limit || 0;
  const used = r.credit_used || 0;
  const available = Math.max(0, limit - used);

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card large">
      <div class="modal-header"><h3 class="modal-title">${r.business_name || r.name}</h3><button class="modal-close" onclick="this.closest('.modal-overlay').remove()">✕</button></div>
      <div class="modal-body">
        <div class="form-grid mb-2">
          <div><span style="font-size:12px;color:var(--text-muted)">Contact Person</span><div style="font-weight:600">${r.name || '—'}</div></div>
          <div><span style="font-size:12px;color:var(--text-muted)">Phone</span><div style="font-weight:600">${r.phone || '—'}</div></div>
          <div><span style="font-size:12px;color:var(--text-muted)">Email</span><div>${r.email || '—'}</div></div>
          <div><span style="font-size:12px;color:var(--text-muted)">Area / City</span><div>${r.area || '—'}, ${r.city || ''} ${r.state || ''} ${r.pincode || ''}</div></div>
          <div><span style="font-size:12px;color:var(--text-muted)">Address</span><div>${r.address || '—'}</div></div>
          <div><span style="font-size:12px;color:var(--text-muted)">GSTIN</span><div>${r.gstin || '—'}</div></div>
        </div>
        <div class="section-card" style="margin-bottom:16px">
          <h4 style="font-size:14px;font-weight:700;margin-bottom:12px">💳 Credit Account</h4>
          <div class="stats-grid" style="grid-template-columns:repeat(3,1fr)">
            <div class="stat-card primary" style="padding:12px"><div class="stat-card-value" style="font-size:18px">${fmtCurrency(limit)}</div><div class="stat-card-label">Total Limit</div></div>
            <div class="stat-card warning" style="padding:12px"><div class="stat-card-value" style="font-size:18px">${fmtCurrency(used)}</div><div class="stat-card-label">Used</div></div>
            <div class="stat-card success" style="padding:12px"><div class="stat-card-value" style="font-size:18px">${fmtCurrency(available)}</div><div class="stat-card-label">Available</div></div>
          </div>
        </div>
        <div id="retailerOutstandingOrders"><p style="color:var(--text-muted);font-size:12px">Loading outstanding orders...</p></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" onclick="openEditRetailerModal('${r.id}')">✏️ Edit Details</button>
        <button class="btn btn-secondary" onclick="adjustCreditLimit('${r.id}')">💳 Adjust Limit</button>
        <button class="btn btn-success" onclick="markPaymentReceived('${r.id}')">💰 Mark Payment</button>
        <button class="btn btn-${r.approved ? 'danger' : 'success'}" onclick="toggleRetailerStatus('${r.id}',${!r.approved})">${r.approved ? '✕ Suspend' : '✓ Activate'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  // Load outstanding credit orders
  try {
    const { data: creditOrders } = await sb.from('orders').select('id, grand_total, created_at, status').eq('user_id', id).eq('payment_mode', 'credit').in('status', ['pending', 'approved', 'packed', 'dispatched', 'delivered']).order('created_at', { ascending: false });
    const el = document.getElementById('retailerOutstandingOrders');
    if (el && creditOrders && creditOrders.length > 0) {
      el.innerHTML = `<h4 style="font-size:14px;font-weight:700;margin-bottom:8px">Outstanding Credit Orders</h4>
        <div class="table-responsive"><table class="data-table"><thead><tr><th>Order</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead><tbody>
        ${creditOrders.map(o => `<tr><td>#${o.id.slice(0,8)}</td><td style="font-weight:600">${fmtCurrency(o.grand_total)}</td><td><span class="badge badge-${getStatusBadgeClass(o.status)}">${o.status}</span></td><td style="font-size:12px">${fmtDate(o.created_at)}</td></tr>`).join('')}
        </tbody></table></div>`;
    } else if (el) {
      el.innerHTML = '<p style="color:var(--text-muted);font-size:12px">No outstanding credit orders</p>';
    }
  } catch(e) {}
};

window.openEditRetailerModal = async function(id) {
  try {
    const { data: r } = await sb.from('profiles').select('*').eq('id', id).single();
    if (!r) { showToast('Retailer not found', 'error'); return; }
    
    // Close detail modal if open
    document.querySelector('.modal-overlay')?.remove();

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-card large">
        <div class="modal-header">
          <h3 class="modal-title">Edit Retailer Details</h3>
          <button class="modal-close" onclick="this.closest('.modal-overlay').remove(); window.openRetailerDetail('${id}');">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="form-group"><label class="form-label">Business Name *</label><input class="form-input" id="er_business_name" value="${r.business_name || ''}"></div>
            <div class="form-group"><label class="form-label">Contact Person *</label><input class="form-input" id="er_name" value="${r.name || ''}"></div>
            <div class="form-group"><label class="form-label">Phone *</label><input class="form-input" id="er_phone" value="${r.phone || ''}"></div>
            <div class="form-group"><label class="form-label">Email</label><input class="form-input" id="er_email" value="${r.email || ''}"></div>
            <div class="form-group"><label class="form-label">Area / Zone</label><input class="form-input" id="er_area" value="${r.area || ''}"></div>
            <div class="form-group"><label class="form-label">City</label><input class="form-input" id="er_city" value="${r.city || ''}"></div>
            <div class="form-group"><label class="form-label">State</label><input class="form-input" id="er_state" value="${r.state || ''}"></div>
            <div class="form-group"><label class="form-label">Pincode</label><input class="form-input" id="er_pincode" value="${r.pincode || ''}"></div>
            <div class="form-group form-group-full"><label class="form-label">Address</label><input class="form-input" id="er_address" value="${r.address || ''}"></div>
            <div class="form-group"><label class="form-label">GSTIN</label><input class="form-input" id="er_gstin" value="${r.gstin || ''}"></div>
            <div class="form-group"><label class="form-label">Credit Limit (₹) *</label><input type="number" step="0.01" class="form-input" id="er_credit_limit" value="${r.credit_limit || 0}"></div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove(); window.openRetailerDetail('${id}');">Cancel</button>
          <button class="btn btn-primary" id="er_save">Save Changes</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    
    // Clicking outside modal content re-opens detail view
    modal.addEventListener('click', (e) => { 
      if (e.target === modal) { 
        modal.remove(); 
        window.openRetailerDetail(id); 
      } 
    });

    modal.querySelector('#er_save')?.addEventListener('click', async () => {
      const businessName = modal.querySelector('#er_business_name').value.trim();
      const name = modal.querySelector('#er_name').value.trim();
      const phone = modal.querySelector('#er_phone').value.trim();
      const email = modal.querySelector('#er_email').value.trim();
      const area = modal.querySelector('#er_area').value.trim();
      const city = modal.querySelector('#er_city').value.trim();
      const state = modal.querySelector('#er_state').value.trim();
      const pincode = modal.querySelector('#er_pincode').value.trim();
      const address = modal.querySelector('#er_address').value.trim();
      const gstin = modal.querySelector('#er_gstin').value.trim();
      const creditLimit = parseFloat(modal.querySelector('#er_credit_limit').value);

      if (!businessName) { showToast('Business name is required', 'warning'); return; }
      if (!name) { showToast('Contact person is required', 'warning'); return; }
      if (!phone) { showToast('Phone number is required', 'warning'); return; }
      if (isNaN(creditLimit) || creditLimit < 0) { showToast('Valid credit limit is required', 'warning'); return; }

      const oldLimit = r.credit_limit || 0;
      const limitDiff = creditLimit - oldLimit;

      try {
        // If credit limit changed, apply via adjust_credit_limit RPC first (keeps history and validates)
        if (limitDiff !== 0) {
          const { error: creditError } = await sb.rpc('adjust_credit_limit', {
            p_retailer_id: id,
            p_amount: limitDiff,
            p_reason: 'Admin manual credit limit adjustment'
          });
          if (creditError) throw creditError;
        }

        // Update profiles details
        const { error: profileError } = await sb.from('profiles').update({
          business_name: businessName,
          name: name,
          phone: phone,
          email: email || null,
          area: area || null,
          city: city || null,
          state: state || null,
          pincode: pincode || null,
          address: address || null,
          gstin: gstin || null
        }).eq('id', id);

        if (profileError) throw profileError;

        showToast('Retailer details updated successfully!', 'success');
        modal.remove();
        window.openRetailerDetail(id);
        if (window._refreshRetailers) window._refreshRetailers();
      } catch (err) {
        showToast(err.message || 'Failed to update retailer details', 'error');
      }
    });

  } catch (err) {
    showToast('Failed to load retailer details', 'error');
  }
};

window.adjustCreditLimit = async function(retailerId) {
  const amount = prompt('Enter new credit limit (or +/- amount to adjust):');
  if (!amount) return;
  try {
    const { error } = await sb.rpc('adjust_credit_limit', { p_retailer_id: retailerId, p_amount: parseFloat(amount), p_reason: 'Admin adjustment from dashboard' });
    if (error) throw error;
    showToast('Credit limit adjusted', 'success');
    document.querySelector('.modal-overlay')?.remove();
    if (window._refreshRetailers) window._refreshRetailers();
  } catch (err) { showToast(err.message, 'error'); }
};

window.markPaymentReceived = async function(retailerId) {
  // Find delivered credit orders for this retailer
  try {
    const { data: orders } = await sb.from('orders').select('id, grand_total, created_at').eq('user_id', retailerId).eq('payment_mode', 'credit').eq('status', 'delivered').order('created_at');
    if (!orders || orders.length === 0) { showToast('No outstanding credit orders to mark', 'info'); return; }

    document.querySelector('.modal-overlay')?.remove();
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-card">
        <div class="modal-header"><h3 class="modal-title">Mark Payment Received</h3><button class="modal-close" onclick="this.closest('.modal-overlay').remove()">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">Select orders for which payment has been received:</p>
          ${orders.map(o => `<label class="form-checkbox-row"><input type="checkbox" value="${o.id}" class="payment-order-cb"><span>#${o.id.slice(0,8)} — ${fmtCurrency(o.grand_total)} (${fmtDate(o.created_at)})</span></label>`).join('')}
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button><button class="btn btn-success" id="confirmPayment">💰 Confirm Payment</button></div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

    modal.querySelector('#confirmPayment')?.addEventListener('click', async () => {
      const checked = modal.querySelectorAll('.payment-order-cb:checked');
      if (checked.length === 0) { showToast('Select at least one order', 'warning'); return; }
      try {
        for (const cb of checked) {
          await sb.rpc('reset_credit_used', { p_order_id: cb.value });
        }
        showToast(`${checked.length} payment(s) recorded`, 'success');
        modal.remove();
        if (window._refreshRetailers) window._refreshRetailers();
      } catch (err) { showToast(err.message, 'error'); }
    });
  } catch (err) { showToast(err.message, 'error'); }
};

window.toggleRetailerStatus = async function(id, approve) {
  try {
    const { error } = await sb.from('profiles').update({ approved: approve }).eq('id', id);
    if (error) throw error;
    showToast(approve ? 'Retailer activated' : 'Retailer suspended', approve ? 'success' : 'warning');
    document.querySelector('.modal-overlay')?.remove();
    if (window._refreshRetailers) window._refreshRetailers();
  } catch (err) { showToast(err.message, 'error'); }
};

// ============================================================
// DELIVERY TRACKING PAGE
// ============================================================

async function renderDelivery() {
  pageContent.innerHTML = `
    <div class="delivery-tracker-layout">
      <div class="map-pane"><div id="leafletMap" style="width:100%;height:100%"></div></div>
      <div class="delivery-sidebar">
        <div class="driver-list-header">Active Riders</div>
        <div id="driverList"><div style="color:var(--text-muted);font-size:12px">Loading...</div></div>
      </div>
    </div>
  `;

  // Init Leaflet map
  setTimeout(() => {
    if (typeof L === 'undefined') {
      document.getElementById('leafletMap').innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted)">Leaflet library not loaded</div>';
      return;
    }

    _deliveryMap = L.map('leafletMap').setView([21.15016745169625, 79.09914048349087], 13); // Nagpur

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19,
    }).addTo(_deliveryMap);

    // Store marker: Thakkar Medico Warehouse
    L.marker([21.15016745169625, 79.09914048349087], {
      icon: L.divIcon({ className: '', html: '<div style="background:#6C63FF;color:#fff;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;box-shadow:0 4px 12px rgba(108,99,255,0.4)">🏪</div>', iconSize: [32, 32], iconAnchor: [16, 16] })
    }).addTo(_deliveryMap).bindPopup('<strong>Thakkar Medico Warehouse</strong><br>Sandesh Dawa Bazar, Ganjipeth, Nagpur');

    loadDriverLocations();
  }, 100);
}

async function loadDriverLocations() {
  try {
    const { data, error } = await sb.from('driver_locations').select(`
      profile_id, lat, lng, recorded_at, speed, heading, eta_next_stop_s,
      profile:profiles!driver_locations_profile_id_fkey(id, name, phone)
    `).order('recorded_at', { ascending: false });

    if (error) throw error;

    // Group by profile to get latest location per driver
    const latestByDriver = {};
    (data || []).forEach(loc => {
      const pid = loc.profile?.id;
      if (pid && !latestByDriver[pid]) latestByDriver[pid] = loc;
    });

    const drivers = Object.values(latestByDriver);
    const driverList = document.getElementById('driverList');

    if (driverList) {
      driverList.innerHTML = drivers.length === 0 ? '<div style="color:var(--text-muted);font-size:12px">No active riders</div>' :
        drivers.map(d => {
          let age = (Date.now() - new Date(d.recorded_at).getTime()) / 60000;
          let stateClass = age < 2 ? 'online' : (age < 5 ? 'stale' : 'offline');
          let stateColor = age < 2 ? '#10B981' : (age < 5 ? '#F59E0B' : '#9CA3AF');
          let speedText = d.speed ? Math.round(d.speed * 3.6) + ' km/h' : 'Stationary';

          return `<div class="driver-card" onclick="panToDriver(${d.lat},${d.lng})" style="border-left: 4px solid ${stateColor}; cursor:pointer; padding: 10px; margin-bottom: 8px; background: var(--bg-surface); border-radius: 8px;">
            <div class="driver-card-name" style="font-weight:700">🏍️ ${d.profile?.name || 'Unknown'} <span style="font-size:10px;padding:2px 6px;border-radius:4px;background:${stateColor};color:#fff;margin-left:6px">${stateClass.toUpperCase()}</span></div>
            <div class="driver-card-meta" style="font-size:11px;color:var(--text-muted);margin-top:4px">📱 ${d.profile?.phone || '—'} · Speed: ${speedText} · ${timeAgo(d.recorded_at)}</div>
          </div>`;
        }).join('');
    }

    // Add markers to map
    if (_deliveryMap) {
      if (!window._driverMarkers) window._driverMarkers = {};

      drivers.forEach(d => {
        if (d.lat && d.lng) {
          let age = (Date.now() - new Date(d.recorded_at).getTime()) / 60000;
          let stateColor = age < 2 ? '#10B981' : (age < 5 ? '#F59E0B' : '#9CA3AF');
          let speedText = d.speed ? Math.round(d.speed * 3.6) + ' km/h' : 'Stationary';
          let etaText = d.eta_next_stop_s ? `<br><strong>ETA next stop:</strong> ${Math.round(d.eta_next_stop_s / 60)} min` : '';

          if (window._driverMarkers[d.profile?.id]) {
            _deliveryMap.removeLayer(window._driverMarkers[d.profile?.id]);
          }

          const marker = L.marker([d.lat, d.lng], {
            icon: L.divIcon({ className: '', html: `<div style="background:${stateColor};color:#fff;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.15);border:2px solid white">🏍️</div>`, iconSize: [28, 28], iconAnchor: [14, 14] })
          }).addTo(_deliveryMap).bindPopup(`<strong>${d.profile?.name || 'Rider'}</strong><br>${d.profile?.phone || ''}<br>Last seen: ${timeAgo(d.recorded_at)}<br>Speed: ${speedText}${etaText}`);

          window._driverMarkers[d.profile?.id] = marker;
        }
      });
    }

    // Setup realtime for driver locations
    const ch = sb.channel('driver-locations-rt').on('postgres_changes', { event: '*', schema: 'public', table: 'driver_locations' }, () => {
      if (currentPage === 'delivery') loadDriverLocations();
    }).subscribe();
    _realtimeChannels.push(ch);

  } catch (err) { console.error('Driver locations error:', err); }
}

window.panToDriver = function(lat, lng) {
  if (_deliveryMap) _deliveryMap.flyTo([lat, lng], 16);
};

// ============================================================
// POS BILLING PAGE
// ============================================================

async function renderPOS() {
  _posState = { retailer: null, cart: [], fulfillment: 'self_pickup', payment: 'cod', redeemPoints: false, notes: '' };

  pageContent.innerHTML = `
    <div class="pos-container">
      <div>
        <!-- Retailer Search -->
        <div class="section-card mb-2">
          <h4 style="font-size:14px;font-weight:700;margin-bottom:8px">👤 Select Retailer</h4>
          <div class="search-dropdown-wrap">
            <input type="text" class="form-input" id="posRetailerSearch" placeholder="Search by name, business, or phone..." style="margin:0">
            <div class="search-dropdown-list hidden" id="posRetailerDropdown"></div>
          </div>
          <div id="posSelectedRetailer" style="margin-top:8px"></div>
        </div>
        <!-- Product Search -->
        <div class="section-card mb-2">
          <h4 style="font-size:14px;font-weight:700;margin-bottom:8px">💊 Add Products</h4>
          <div class="search-dropdown-wrap">
            <input type="text" class="form-input" id="posProductSearch" placeholder="Search products..." style="margin:0">
            <div class="search-dropdown-list hidden" id="posProductDropdown"></div>
          </div>
        </div>
        <!-- Cart -->
        <div class="section-card">
          <h4 style="font-size:14px;font-weight:700;margin-bottom:8px">🛒 Cart</h4>
          <div class="pos-cart-list" id="posCartList"><div style="color:var(--text-muted);font-size:13px;padding:20px;text-align:center">No items in cart</div></div>
        </div>
      </div>
      <!-- Checkout Sidebar -->
      <div class="pos-checkout-bar">
        <h4 style="font-size:14px;font-weight:700;margin-bottom:16px">📋 Order Summary</h4>
        <div class="form-group" style="margin-bottom:12px">
          <label class="form-label">Fulfillment</label>
          <select class="form-select" id="posFulfillment"><option value="self_pickup">Counter Pickup</option><option value="delivery">Delivery</option></select>
        </div>
        <div class="form-group" style="margin-bottom:12px">
          <label class="form-label">Payment Mode</label>
          <select class="form-select" id="posPayment"><option value="cod">Cash (COD)</option><option value="upi">UPI / Card</option><option value="credit">Credit</option></select>
        </div>
        <div class="form-group" style="margin-bottom:12px">
          <label class="form-label">Notes</label>
          <input class="form-input" id="posNotes" placeholder="Order notes (optional)" style="margin:0">
        </div>
        <div class="summary-list" id="posSummary"></div>
        <button class="btn btn-primary" style="width:100%;justify-content:center;padding:14px" id="posPlaceOrder" disabled>🧾 Place Order</button>
      </div>
    </div>
  `;

  // Retailer Search
  let retailerTimer;
  document.getElementById('posRetailerSearch')?.addEventListener('input', (e) => {
    clearTimeout(retailerTimer);
    retailerTimer = setTimeout(() => searchPosRetailers(e.target.value), 300);
  });

  // Product Search
  let productTimer;
  document.getElementById('posProductSearch')?.addEventListener('input', (e) => {
    clearTimeout(productTimer);
    productTimer = setTimeout(() => searchPosProducts(e.target.value), 300);
  });

  document.getElementById('posFulfillment')?.addEventListener('change', (e) => { _posState.fulfillment = e.target.value; updatePosSummary(); });
  document.getElementById('posPayment')?.addEventListener('change', (e) => { _posState.payment = e.target.value; updatePosSummary(); });
  document.getElementById('posNotes')?.addEventListener('input', (e) => { _posState.notes = e.target.value; });
  document.getElementById('posPlaceOrder')?.addEventListener('click', placePosOrder);

  updatePosSummary();
}

async function searchPosRetailers(q) {
  const dd = document.getElementById('posRetailerDropdown');
  if (!dd) return;
  if (!q || q.length < 2) { dd.classList.add('hidden'); return; }

  const { data } = await sb.from('profiles').select('id, name, business_name, phone, credit_limit, credit_used, loyalty_points').eq('role', 'retailer').eq('approved', true).or(`name.ilike.%${q}%,business_name.ilike.%${q}%,phone.ilike.%${q}%`).limit(10);
  if (!data || data.length === 0) { dd.classList.add('hidden'); return; }

  dd.classList.remove('hidden');
  dd.innerHTML = data.map(r => `<div class="search-dropdown-item" onclick="selectPosRetailer(${JSON.stringify(r).replace(/"/g,'&quot;')})"><h5>${r.business_name || r.name}</h5><p>${r.phone || ''} · Credit: ${fmtCurrency(r.credit_limit || 0)}</p></div>`).join('');
}

window.selectPosRetailer = function(r) {
  _posState.retailer = r;
  document.getElementById('posRetailerDropdown')?.classList.add('hidden');
  document.getElementById('posRetailerSearch').value = '';
  document.getElementById('posSelectedRetailer').innerHTML = `<div style="background:var(--bg-surface);padding:10px;border-radius:8px;display:flex;justify-content:space-between;align-items:center"><div><strong>${r.business_name || r.name}</strong><br><span style="font-size:12px;color:var(--text-muted)">${r.phone || ''} · Loyalty: ${r.loyalty_points || 0} pts</span></div><button class="btn btn-danger" style="padding:4px 8px;font-size:11px" onclick="_posState.retailer=null;this.parentElement.remove();updatePosSummary()">✕</button></div>`;
  updatePosSummary();
};

async function searchPosProducts(q) {
  const dd = document.getElementById('posProductDropdown');
  if (!dd) return;
  if (!q || q.length < 2) { dd.classList.add('hidden'); return; }

  const { data } = await sb.from('products').select('id, name, selling_price, mrp, gst_percent, stock_quantity, pack_size').eq('is_active', true).ilike('name', `%${q}%`).limit(10);
  if (!data || data.length === 0) { dd.classList.add('hidden'); return; }

  dd.classList.remove('hidden');
  dd.innerHTML = data.map(p => `<div class="search-dropdown-item" onclick='addPosProduct(${JSON.stringify(p).replace(/'/g,"\\'")})'><h5>${p.name}</h5><p>${fmtCurrency(p.selling_price)} · Stock: ${p.stock_quantity || 0}${p.pack_size ? ` · ${p.pack_size}` : ''}</p></div>`).join('');
}

window.addPosProduct = function(p) {
  document.getElementById('posProductDropdown')?.classList.add('hidden');
  document.getElementById('posProductSearch').value = '';

  const existing = _posState.cart.find(c => c.id === p.id);
  if (existing) { existing.quantity++; }
  else { _posState.cart.push({ ...p, quantity: 1 }); }
  renderPosCart();
  updatePosSummary();
};

function renderPosCart() {
  const el = document.getElementById('posCartList');
  if (!el) return;
  if (_posState.cart.length === 0) { el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:20px;text-align:center">No items in cart</div>'; return; }

  el.innerHTML = _posState.cart.map((item, i) => `
    <div class="cart-item-row">
      <div class="cart-item-info"><div style="font-weight:600;font-size:13px">${item.name}</div><div style="font-size:12px;color:var(--text-muted)">${fmtCurrency(item.selling_price)} × ${item.quantity} = ${fmtCurrency(item.selling_price * item.quantity)}</div></div>
      <div class="cart-item-qty">
        <div class="cart-item-qty-btn" onclick="updatePosQty(${i},-1)">−</div>
        <span class="cart-item-qty-val">${item.quantity}</span>
        <div class="cart-item-qty-btn" onclick="updatePosQty(${i},1)">+</div>
        <div class="cart-item-qty-btn" style="color:var(--color-error);margin-left:8px" onclick="removePosItem(${i})">✕</div>
      </div>
    </div>
  `).join('');
}

window.updatePosQty = function(i, delta) {
  _posState.cart[i].quantity = Math.max(1, _posState.cart[i].quantity + delta);
  renderPosCart();
  updatePosSummary();
};

window.removePosItem = function(i) {
  _posState.cart.splice(i, 1);
  renderPosCart();
  updatePosSummary();
};

function updatePosSummary() {
  const el = document.getElementById('posSummary');
  const btn = document.getElementById('posPlaceOrder');
  if (!el) return;

  const subtotal = _posState.cart.reduce((sum, item) => sum + (item.selling_price * item.quantity), 0);
  const gstTotal = _posState.cart.reduce((sum, item) => sum + (item.selling_price * item.quantity * (item.gst_percent || 0) / 100), 0);
  const total = subtotal + gstTotal;

  el.innerHTML = `
    <div class="summary-row"><span>Subtotal</span><span>${fmtCurrency(subtotal)}</span></div>
    <div class="summary-row"><span>GST</span><span>${fmtCurrency(gstTotal)}</span></div>
    <div class="summary-row total"><span>Grand Total</span><span>${fmtCurrency(total)}</span></div>
  `;

  if (btn) btn.disabled = !_posState.retailer || _posState.cart.length === 0;
}

async function placePosOrder() {
  if (!_posState.retailer || _posState.cart.length === 0) return;
  const btn = document.getElementById('posPlaceOrder');
  if (btn) { btn.disabled = true; btn.textContent = 'Placing order...'; }

  try {
    const items = _posState.cart.map(c => ({
      product_id: c.id,
      qty: c.quantity,
      packaging_level_id: null,
      units_per_level: 1,
    }));

    const idempotencyKey = `pos_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const { data, error } = await sb.rpc('place_order', {
      p_retailer_id: _posState.retailer.id,
      p_items: items,
      p_address: _posState.retailer.address || 'Counter pickup',
      p_idempotency_key: idempotencyKey,
      p_payment_mode: _posState.payment,
      p_redeem_points: 0,
      p_fulfillment_mode: _posState.fulfillment,
      p_delivery: null,
      p_notes: _posState.notes || 'POS Counter Order',
    });

    if (error) throw error;

    const orderId = data?.order_id;

    // For self_pickup, advance through status chain
    if (_posState.fulfillment === 'self_pickup' && orderId) {
      const statusChain = ['approved', 'packed', 'dispatched', 'delivered'];
      for (const status of statusChain) {
        await sb.from('orders').update({ status }).eq('id', orderId);
        await new Promise(r => setTimeout(r, 200)); // Small delay for triggers
      }
    }

    showToast('Order placed successfully!', 'success');
    _posState.cart = [];
    _posState.retailer = null;
    renderPOS();
  } catch (err) {
    showToast(err.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '🧾 Place Order'; }
  }
}

// ============================================================
// INVOICE IMPORT PAGE
// ============================================================

async function renderInvoice() {
  _invoiceState = { step: 1, uploadId: null, parsedData: null, validationResult: null, editedItems: [] };

  pageContent.innerHTML = `
    <div class="invoice-import-layout">
      <div class="progress-header">
        <span class="progress-step-text active" data-step="1">1. Upload</span>
        <span style="color:var(--text-muted)">→</span>
        <span class="progress-step-text" data-step="2">2. Parse</span>
        <span style="color:var(--text-muted)">→</span>
        <span class="progress-step-text" data-step="3">3. Validate</span>
        <span style="color:var(--text-muted)">→</span>
        <span class="progress-step-text" data-step="4">4. Review & Import</span>
      </div>
      <div id="invoiceStepContent"></div>
    </div>
  `;
  renderInvoiceStep();
}

function updateInvoiceProgress(step) {
  document.querySelectorAll('.progress-step-text').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.step) <= step);
  });
}

function renderInvoiceStep() {
  const container = document.getElementById('invoiceStepContent');
  if (!container) return;

  updateInvoiceProgress(_invoiceState.step);

  if (_invoiceState.step === 1) {
    container.innerHTML = `
      <div class="section-card">
        <h4 style="font-size:14px;font-weight:700;margin-bottom:12px">📤 Upload Invoice Document</h4>
        <div class="invoice-upload-box" id="invoiceUploadBox">
          <div class="invoice-upload-icon">📄</div>
          <p style="font-size:14px;font-weight:600">Click to select a file or drag & drop</p>
          <p style="font-size:12px;color:var(--text-muted);margin-top:4px">Supports images (JPG, PNG) and PDF</p>
          <input type="file" id="invoiceFileInput" accept="image/*,.pdf" style="display:none">
        </div>
        <div style="text-align:center;margin-top:16px;color:var(--text-muted)">— or —</div>
        <button class="btn btn-secondary mt-1" style="width:100%;justify-content:center" onclick="_invoiceState.step=2;renderInvoiceStep()">Skip Upload → Paste JSON Directly</button>
      </div>
    `;

    const box = document.getElementById('invoiceUploadBox');
    const input = document.getElementById('invoiceFileInput');
    box?.addEventListener('click', () => input?.click());
    input?.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const filePath = `invoice-uploads/${Date.now()}_${file.name}`;
        const { error: uploadErr } = await sb.storage.from('invoice-uploads').upload(filePath, file);
        if (uploadErr) throw uploadErr;

        const { data: record, error: dbErr } = await sb.from('invoice_uploads').insert({ file_path: filePath, original_filename: file.name, processing_status: 'uploaded' }).select().single();
        if (dbErr) throw dbErr;

        _invoiceState.uploadId = record.id;
        showToast('File uploaded!', 'success');
        _invoiceState.step = 2;
        renderInvoiceStep();
      } catch (err) { showToast(`Upload failed: ${err.message}`, 'error'); }
    });
  } else if (_invoiceState.step === 2) {
    container.innerHTML = `
      <div class="section-card">
        <h4 style="font-size:14px;font-weight:700;margin-bottom:12px">📋 Paste Extracted Invoice JSON</h4>
        <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px">Paste the JSON output from ChatGPT or any OCR tool. The system will clean and normalize it automatically.</p>
        <textarea class="form-input" id="invoiceJsonInput" rows="12" placeholder='Paste JSON here... e.g. { "party": { "name": "..." }, "items": [...], "totals": {...} }' style="font-family:monospace;font-size:12px;resize:vertical"></textarea>
        <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end">
          <button class="btn btn-secondary" onclick="_invoiceState.step=1;renderInvoiceStep()">← Back</button>
          <button class="btn btn-primary" id="invoiceParseBtn">Parse & Validate →</button>
        </div>
      </div>
    `;

    document.getElementById('invoiceParseBtn')?.addEventListener('click', async () => {
      const raw = document.getElementById('invoiceJsonInput')?.value;
      if (!raw || !raw.trim()) { showToast('Please paste JSON data', 'warning'); return; }

      try {
        // Clean and parse JSON (tolerant parser)
        const parsed = cleanAndParseJson(raw);
        const normalized = normalizeExtractedInvoice(parsed);
        _invoiceState.parsedData = normalized;
        _invoiceState.editedItems = JSON.parse(JSON.stringify(normalized.items));
        _invoiceState.step = 3;
        renderInvoiceStep();
      } catch (err) { showToast(`Parse error: ${err.message}`, 'error'); }
    });
  } else if (_invoiceState.step === 3) {
    container.innerHTML = `<div class="section-card"><div class="text-center" style="padding:40px;color:var(--text-muted)">Validating invoice data...</div></div>`;
    runInvoiceValidation();
  } else if (_invoiceState.step === 4) {
    renderInvoiceReview();
  }
}

// JSON cleaning/normalizing functions (mirrored from invoiceExtraction.ts)
function cleanAndParseJson(text) {
  let cleaned = text.trim();
  const mdMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (mdMatch) cleaned = mdMatch[1].trim();
  const fb = cleaned.indexOf('{'); const lb = cleaned.lastIndexOf('}');
  if (fb !== -1 && lb !== -1 && lb > fb) cleaned = cleaned.substring(fb, lb + 1);
  cleaned = cleaned.replace(/,\s*([\]}])/g, '$1');
  return JSON.parse(cleaned);
}

function normalizeExtractedInvoice(json) {
  const party = json.party || {};
  const invoice = json.invoice || {};
  const rawItems = Array.isArray(json.items) ? json.items : [];
  const totals = json.totals || {};
  return {
    party: { code: String(party.code || '').trim(), name: String(party.name || '').trim(), gst: String(party.gst || '').trim(), address: String(party.address || '').trim() },
    invoice: { number: String(invoice.number || '').trim(), date: String(invoice.date || '').trim() },
    items: rawItems.map(item => ({
      product_name: String(item.product_name || item.name || '').trim(),
      product_code: String(item.product_code || item.sku || item.code || '').trim(),
      batch: String(item.batch || '').trim(), expiry: String(item.expiry || '').trim(),
      quantity: Number(item.quantity || 0), free_quantity: Number(item.free_quantity || 0),
      rate: Number(item.rate || item.price || item.selling_price || 0),
      discount: Number(item.discount || 0), gst: Number(item.gst || item.gst_percent || 0),
      amount: Number(item.amount || item.total || 0),
    })),
    totals: {
      subtotal: Number(totals.subtotal || 0), gst_total: Number(totals.gst_total || totals.gst || 0),
      discount_total: Number(totals.discount_total || totals.discount || 0), round_off: Number(totals.round_off || 0),
      grand_total: Number(totals.grand_total || totals.total || 0),
    },
  };
}

async function runInvoiceValidation() {
  const inv = _invoiceState.parsedData;
  if (!inv) return;

  const result = { customerMatch: null, productMatches: [], warnings: [], overallStatus: 'success' };

  // Customer matching
  try {
    if (inv.party.code) {
      const { data } = await sb.from('profiles').select('*').eq('retailer_code', inv.party.code).eq('role', 'retailer').limit(1).maybeSingle();
      if (data) { result.customerMatch = { customer: data, confidence: 1.0, method: 'code' }; }
    }
    if (!result.customerMatch && inv.party.gst) {
      const { data } = await sb.from('profiles').select('*').eq('gstin', inv.party.gst.toUpperCase().trim()).eq('role', 'retailer').limit(1).maybeSingle();
      if (data) { result.customerMatch = { customer: data, confidence: 0.95, method: 'gstin' }; }
    }
    if (!result.customerMatch && inv.party.name) {
      const { data } = await sb.from('profiles').select('*').eq('role', 'retailer').or(`business_name.ilike.%${inv.party.name}%,name.ilike.%${inv.party.name}%`).limit(5);
      if (data && data.length > 0) result.customerMatch = { customer: data[0], confidence: 0.7, method: 'fuzzy' };
    }
    if (!result.customerMatch) { result.overallStatus = 'failed'; result.warnings.push('No customer match found'); }
  } catch(e) { result.warnings.push('Customer match error'); }

  // Product matching
  for (let i = 0; i < inv.items.length; i++) {
    const item = inv.items[i];
    let matched = null;
    try {
      if (item.product_code) {
        const { data } = await sb.from('products').select('*').eq('sku', item.product_code).limit(1).maybeSingle();
        if (data) matched = { product: data, confidence: 1.0 };
      }
      if (!matched && item.product_name) {
        const { data } = await sb.from('products').select('*').ilike('name', `%${item.product_name}%`).eq('is_active', true).limit(1).maybeSingle();
        if (data) matched = { product: data, confidence: 0.8 };
      }
      result.productMatches.push({ index: i, item, matched: matched?.product || null, confidence: matched?.confidence || 0 });
      if (!matched) { result.overallStatus = result.overallStatus === 'failed' ? 'failed' : 'warning'; }
    } catch(e) { result.productMatches.push({ index: i, item, matched: null, confidence: 0 }); }
  }

  _invoiceState.validationResult = result;
  _invoiceState.step = 4;
  renderInvoiceStep();
}

function renderInvoiceReview() {
  const container = document.getElementById('invoiceStepContent');
  const inv = _invoiceState.parsedData;
  const val = _invoiceState.validationResult;
  if (!container || !inv || !val) return;

  const customer = val.customerMatch?.customer;

  container.innerHTML = `
    <div class="section-card mb-2">
      <h4 style="font-size:14px;font-weight:700;margin-bottom:12px">👤 Customer Match</h4>
      ${customer ? `<div style="display:flex;justify-content:space-between;align-items:center"><div><strong>${customer.business_name || customer.name}</strong><br><span style="font-size:12px;color:var(--text-muted)">${customer.phone || ''} · ${customer.gstin || 'No GSTIN'}</span></div><span class="badge badge-${val.customerMatch.confidence >= 0.9 ? 'success' : 'warning'}">${(val.customerMatch.confidence * 100).toFixed(0)}% match (${val.customerMatch.method})</span></div>` : `<div style="color:var(--color-error)">⚠️ No customer match found. <strong>Extracted name: ${inv.party.name}</strong></div>`}
    </div>

    <div class="section-card mb-2">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h4 style="font-size:14px;font-weight:700">📦 Items (${inv.items.length})</h4>
        <span style="font-size:12px;color:var(--text-muted)">Invoice #${inv.invoice.number} · ${inv.invoice.date}</span>
      </div>
      <div class="invoice-items-grid">
        <div class="invoice-item-edit-row header"><span>Product</span><span>Qty</span><span>Rate</span><span>GST%</span><span>Disc</span><span>Amount</span><span>✓</span></div>
        ${val.productMatches.map((pm, i) => {
          const matchIcon = pm.matched ? (pm.confidence >= 0.9 ? '✅' : '⚠️') : '❌';
          return `<div class="invoice-item-edit-row">
            <input class="text-left inv-edit" data-i="${i}" data-field="product_name" value="${pm.item.product_name}">
            <input type="number" class="inv-edit" data-i="${i}" data-field="quantity" value="${pm.item.quantity}">
            <input type="number" class="inv-edit" data-i="${i}" data-field="rate" value="${pm.item.rate}">
            <input type="number" class="inv-edit" data-i="${i}" data-field="gst" value="${pm.item.gst}">
            <input type="number" class="inv-edit" data-i="${i}" data-field="discount" value="${pm.item.discount}">
            <input type="number" class="inv-edit" data-i="${i}" data-field="amount" value="${pm.item.amount}">
            <span title="${pm.matched ? `Matched: ${pm.matched.name}` : 'No match'}">${matchIcon}</span>
          </div>`;
        }).join('')}
      </div>
    </div>

    <div class="section-card mb-2">
      <h4 style="font-size:14px;font-weight:700;margin-bottom:8px">💰 Totals</h4>
      <div class="summary-list">
        <div class="summary-row"><span>Subtotal</span><span>${fmtCurrency(inv.totals.subtotal)}</span></div>
        <div class="summary-row"><span>GST</span><span>${fmtCurrency(inv.totals.gst_total)}</span></div>
        <div class="summary-row"><span>Discount</span><span>-${fmtCurrency(inv.totals.discount_total)}</span></div>
        <div class="summary-row"><span>Round Off</span><span>${fmtCurrency(inv.totals.round_off)}</span></div>
        <div class="summary-row total"><span>Grand Total</span><span>${fmtCurrency(inv.totals.grand_total)}</span></div>
      </div>
    </div>

    ${val.warnings.length > 0 ? `<div style="background:var(--color-warning-subtle);border:1px solid var(--color-warning);border-radius:8px;padding:12px;margin-bottom:12px;font-size:13px">${val.warnings.map(w => `⚠️ ${w}`).join('<br>')}</div>` : ''}

    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btn btn-secondary" onclick="_invoiceState.step=2;renderInvoiceStep()">← Back to Edit</button>
      ${customer ? `<button class="btn btn-primary" id="invoiceImportBtn">📥 Create Order from Invoice</button>` : `<p style="color:var(--color-error);font-size:13px;align-self:center">Cannot import without customer match</p>`}
    </div>
  `;

  // Wire edit inputs to update state
  container.querySelectorAll('.inv-edit').forEach(inp => {
    inp.addEventListener('change', (e) => {
      const i = parseInt(e.target.dataset.i);
      const field = e.target.dataset.field;
      if (_invoiceState.editedItems[i]) {
        _invoiceState.editedItems[i][field] = field === 'product_name' ? e.target.value : Number(e.target.value);
      }
    });
  });

  document.getElementById('invoiceImportBtn')?.addEventListener('click', createOrderFromInvoice);
}

async function createOrderFromInvoice() {
  const inv = _invoiceState.parsedData;
  const val = _invoiceState.validationResult;
  const customer = val?.customerMatch?.customer;
  if (!inv || !customer) return;

  const btn = document.getElementById('invoiceImportBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Importing...'; }

  try {
    const items = _invoiceState.editedItems.map(item => {
      const pm = val.productMatches.find(p => p.item.product_name === item.product_name);
      return {
        product_id: pm?.matched?.id || null,
        qty: item.quantity,
        packaging_level_id: null,
        units_per_level: 1,
      };
    }).filter(i => i.product_id);

    if (items.length === 0) { showToast('No matched products to import', 'error'); if (btn) { btn.disabled = false; btn.textContent = '📥 Create Order from Invoice'; } return; }

    const idempotencyKey = `inv_${inv.invoice.number}_${Date.now()}`;

    const { data, error } = await sb.rpc('place_order', {
      p_retailer_id: customer.id,
      p_items: items,
      p_address: customer.address || 'Invoice import',
      p_idempotency_key: idempotencyKey,
      p_payment_mode: 'credit',
      p_redeem_points: 0,
      p_fulfillment_mode: 'delivery',
      p_delivery: null,
      p_notes: `Imported from Invoice #${inv.invoice.number}`,
    });

    if (error) throw error;

    const orderId = data?.order_id;

    // Update invoice_uploads if we have one
    if (_invoiceState.uploadId) {
      await sb.from('invoice_uploads').update({ linked_order_id: orderId, processing_status: 'completed' }).eq('id', _invoiceState.uploadId);
    }

    showToast('Order created from invoice!', 'success');
    _invoiceState = { step: 1 };
    renderInvoice();
  } catch (err) {
    showToast(err.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '📥 Create Order from Invoice'; }
  }
}

// ============================================================
// SETTINGS PAGE
// ============================================================

async function renderSettings() {
  pageContent.innerHTML = `<div class="text-center mt-3" style="color:var(--text-muted)">Loading settings...</div>`;

  try {
    const { data, error } = await sb.from('settings').select('*');
    if (error) throw error;

    const settings = {};
    (data || []).forEach(s => { settings[s.key] = s.value; });

    pageContent.innerHTML = `
      <div style="max-width:700px">
        <!-- General -->
        <div class="section-card mb-2">
          <h4 style="font-size:14px;font-weight:700;margin-bottom:12px">🏪 General</h4>
          ${renderSettingToggle('gst_enabled', 'Enable GST', settings)}
          ${renderSettingInput('gst_rate', 'Default GST Rate (%)', settings, 'number')}
          ${renderSettingToggle('show_prices_to_unverified', 'Show Prices to Unverified Users', settings)}
        </div>

        <!-- Ordering -->
        <div class="section-card mb-2">
          <h4 style="font-size:14px;font-weight:700;margin-bottom:12px">📦 Ordering</h4>
          ${renderSettingToggle('delivery_enabled', 'Enable Delivery', settings)}
          ${renderSettingToggle('pickup_enabled', 'Enable Self Pickup', settings)}
          ${renderSettingInput('delivery_address', 'Store Address', settings, 'text')}
          ${renderSettingInput('operating_hours', 'Operating Hours', settings, 'text')}
        </div>

        <!-- Payments -->
        <div class="section-card mb-2">
          <h4 style="font-size:14px;font-weight:700;margin-bottom:12px">💳 Payments</h4>
          ${renderSettingToggle('cod_enabled', 'Cash on Delivery (COD)', settings)}
          ${renderSettingToggle('upi_enabled', 'UPI / Card Payments', settings)}
          ${renderSettingToggle('credit_enabled', 'Credit System', settings)}
        </div>

        <!-- Loyalty -->
        <div class="section-card mb-2">
          <h4 style="font-size:14px;font-weight:700;margin-bottom:12px">⭐ Loyalty Program</h4>
          ${renderSettingToggle('loyalty_enabled', 'Enable Loyalty Points', settings)}
          ${renderSettingInput('loyalty_rate', 'Points Earned per ₹100', settings, 'number')}
          ${renderSettingInput('loyalty_redemption_rate', 'Redemption Rate (pts per ₹1)', settings, 'number')}
          ${renderSettingInput('max_redeem_percent', 'Max Redeem % per Order', settings, 'number')}
        </div>

        <!-- Support -->
        <div class="section-card mb-2">
          <h4 style="font-size:14px;font-weight:700;margin-bottom:12px">📞 Support</h4>
          ${renderSettingInput('support_phone', 'Support Phone', settings, 'text')}
          ${renderSettingInput('support_email', 'Support Email', settings, 'email')}
        </div>
      </div>
    `;

    // Wire up toggle & input event handlers
    document.querySelectorAll('.setting-toggle').forEach(el => {
      el.addEventListener('change', async (e) => {
        const key = e.target.dataset.key;
        const val = e.target.checked;
        await saveSetting(key, val);
      });
    });

    document.querySelectorAll('.setting-input').forEach(el => {
      el.addEventListener('blur', async (e) => {
        const key = e.target.dataset.key;
        const type = e.target.type;
        let val = e.target.value;
        if (type === 'number') val = parseFloat(val) || 0;
        await saveSetting(key, val);
      });
    });

  } catch (err) {
    pageContent.innerHTML = `<div class="text-center mt-3" style="color:var(--color-error)">Failed to load settings: ${err.message}</div>`;
  }
}

function renderSettingToggle(key, label, settings) {
  const val = settings[key];
  const checked = val === true || val === 'true';
  return `<div class="switch-container"><span>${label}</span><label class="switch"><input type="checkbox" class="setting-toggle" data-key="${key}" ${checked ? 'checked' : ''}><span class="slider"></span></label></div>`;
}

function renderSettingInput(key, label, settings, type = 'text') {
  const val = settings[key] ?? '';
  return `<div class="form-group" style="margin-bottom:12px"><label class="form-label">${label}</label><input type="${type}" class="form-input setting-input" data-key="${key}" value="${val}" style="margin:0"></div>`;
}

async function saveSetting(key, value) {
  try {
    const { error } = await sb.rpc('update_settings', { p_key: key, p_value: JSON.stringify(value) });
    if (error) throw error;
    showToast(`${key.replace(/_/g,' ')} updated`, 'success');
  } catch (err) {
    showToast(`Failed to save: ${err.message}`, 'error');
  }
}

// ============================================================
// MANAGE OVERVIEW PAGE
// ============================================================

async function renderManage() {
  pageContent.innerHTML = `
    <div class="management-grid">
      <!-- Orders Card -->
      <div class="management-card">
        <div>
          <div class="management-card-header">
            <div class="management-card-icon">📋</div>
            <h3 class="management-card-title">Orders Management</h3>
          </div>
          <p class="management-card-body">Process incoming retailer orders, approve/pack items, dispatch deliveries, and review cancellation requests.</p>
          <div class="management-card-stats">
            <div class="management-card-stat">
              <div class="management-card-stat-val" id="m_pending_orders">—</div>
              <div class="management-card-stat-lbl">Pending Review</div>
            </div>
            <div class="management-card-stat">
              <div class="management-card-stat-val" id="m_today_orders">—</div>
              <div class="management-card-stat-lbl">Today's Orders</div>
            </div>
          </div>
        </div>
        <div class="management-card-footer">
          <button class="btn btn-primary" onclick="navigateTo('orders')">📋 Go to Orders Pipeline</button>
          <button class="btn btn-secondary" onclick="navigateTo('pos')">🧮 POS Billing</button>
        </div>
      </div>

      <!-- Products Card -->
      <div class="management-card">
        <div>
          <div class="management-card-header">
            <div class="management-card-icon">💊</div>
            <h3 class="management-card-title">Product Catalog</h3>
          </div>
          <p class="management-card-body">Add new medicines/products, update pricing (MRP/selling price), manage tax rates (GST), and toggle visibility to retailers.</p>
          <div class="management-card-stats">
            <div class="management-card-stat">
              <div class="management-card-stat-val" id="m_total_products">—</div>
              <div class="management-card-stat-lbl">Total Products</div>
            </div>
            <div class="management-card-stat">
              <div class="management-card-stat-val" id="m_active_products">—</div>
              <div class="management-card-stat-lbl">Active Products</div>
            </div>
          </div>
        </div>
        <div class="management-card-footer">
          <button class="btn btn-primary" onclick="navigateTo('products')">💊 View Catalog</button>
          <button class="btn btn-secondary" onclick="openProductForm(null)">+ Add Product</button>
        </div>
      </div>

      <!-- Stock Card -->
      <div class="management-card">
        <div>
          <div class="management-card-header">
            <div class="management-card-icon">📦</div>
            <h3 class="management-card-title">Stock & Inventory</h3>
          </div>
          <p class="management-card-body">Monitor product stock levels, view critical low stock alerts, adjust item balances, and perform bulk restock operations.</p>
          <div class="management-card-stats">
            <div class="management-card-stat">
              <div class="management-card-stat-val" id="m_low_stock">—</div>
              <div class="management-card-stat-lbl">Low Stock Alerts</div>
            </div>
            <div class="management-card-stat">
              <div class="management-card-stat-val" id="m_out_of_stock">—</div>
              <div class="management-card-stat-lbl">Out of Stock</div>
            </div>
          </div>
        </div>
        <div class="management-card-footer">
          <button class="btn btn-primary" onclick="navigateTo('stock')">📦 Manage Stock</button>
        </div>
      </div>

      <!-- Users & Retailers Card -->
      <div class="management-card">
        <div>
          <div class="management-card-header">
            <div class="management-card-icon">👥</div>
            <h3 class="management-card-title">Retailers & Users</h3>
          </div>
          <p class="management-card-body">Verify pending retailer registrations, configure credit account limits, record customer payments, and view outstanding accounts.</p>
          <div class="management-card-stats">
            <div class="management-card-stat">
              <div class="management-card-stat-val" id="m_pending_users">—</div>
              <div class="management-card-stat-lbl">Pending Verification</div>
            </div>
            <div class="management-card-stat">
              <div class="management-card-stat-val" id="m_total_retailers">—</div>
              <div class="management-card-stat-lbl">Total Retailers</div>
            </div>
          </div>
        </div>
        <div class="management-card-footer">
          <button class="btn btn-primary" onclick="navigateTo('users')">👥 Verify Users</button>
          <button class="btn btn-secondary" onclick="navigateTo('retailers')">🏪 Manage Credit</button>
        </div>
      </div>
    </div>
  `;

  // Fetch real-time numbers
  try {
    const today = new Date(); today.setHours(0,0,0,0);
    const [statsRes, allProds, lowStockRes, retailersRes] = await Promise.all([
      sb.rpc('get_admin_dashboard_stats', { p_today: today.toISOString() }),
      fetchAllProducts('is_active, stock_quantity, selling_price', false),
      sb.rpc('get_low_stock_products'),
      sb.from('profiles').select('approved').eq('role', 'retailer')
    ]);

    if (statsRes.data) {
      document.getElementById('m_pending_orders').textContent = statsRes.data.pendingOrders || 0;
      document.getElementById('m_today_orders').textContent = statsRes.data.todayOrders || 0;
      document.getElementById('m_total_products').textContent = allProds?.length || statsRes.data.totalProducts || 0;
      document.getElementById('m_pending_users').textContent = statsRes.data.pendingUsers || 0;
    }

    if (allProds) {
      const activeCount = allProds.filter(p => p.is_active).length;
      document.getElementById('m_active_products').textContent = activeCount;
      const outOfStockCount = allProds.filter(p => p.is_active && ((p.stock_quantity || 0) <= 0 || (p.selling_price || 0) <= 0)).length;
      document.getElementById('m_out_of_stock').textContent = outOfStockCount;
    }

    if (lowStockRes.data) {
      document.getElementById('m_low_stock').textContent = lowStockRes.data.length;
    }

    if (retailersRes.data) {
      document.getElementById('m_total_retailers').textContent = retailersRes.data.length;
    }
  } catch (err) {
    console.error('Failed to load manage overview stats:', err);
  }
}

// ============================================================
// AUDIT LOGS PAGE
// ============================================================

async function renderAudit() {
  pageContent.innerHTML = `
    <div class="section-card mb-2">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div class="option-pill-group" id="auditTabGroup">
          <button class="option-chip active" data-tab="logins">📧 User Logins</button>
          <button class="option-chip" data-tab="stock">📦 Stock Actions</button>
          <button class="option-chip" data-tab="credit">💳 Credit Limits</button>
          <button class="option-chip" data-tab="orders">📋 Order Lifecycle</button>
          <button class="option-chip" data-tab="resets">🔒 Password Resets</button>
        </div>
        <input type="text" class="form-input" id="auditSearch" placeholder="Search logs..." style="margin:0;max-width:260px">
      </div>
    </div>
    <div id="auditLogsContent"><div class="text-center mt-3" style="color:var(--text-muted)">Loading audit trail...</div></div>
  `;

  let currentTab = 'logins';
  let searchTerm = '';
  let logsData = { logins: [], stock: [], credit: [], orders: [], resets: [] };

  // Fetch audits
  async function fetchAudits() {
    const container = document.getElementById('auditLogsContent');
    if (container) container.innerHTML = `<div class="text-center mt-3" style="padding:40px;color:var(--text-muted)">Loading logs...</div>`;

    try {
      if (currentTab === 'logins') {
        const { data, error } = await sb.from('login_audit').select(`
          id, event, ip_text, user_agent, created_at,
          profiles(name, email, role)
        `).order('created_at', { ascending: false }).limit(200);
        if (error) throw error;
        logsData.logins = data || [];
      } 
      else if (currentTab === 'stock') {
        const { data, error } = await sb.from('stock_history').select(`
          id, change, reason, created_at,
          products(name, sku)
        `).order('created_at', { ascending: false }).limit(200);
        if (error) throw error;
        logsData.stock = data || [];
      }
      else if (currentTab === 'credit') {
        const { data, error } = await sb.from('credit_adjustments').select(`
          id, amount, reason, created_at,
          retailer:profiles!credit_adjustments_retailer_id_fkey(name, business_name),
          adjuster:profiles!credit_adjustments_adjusted_by_fkey(name)
        `).order('created_at', { ascending: false }).limit(200);
        if (error) throw error;
        logsData.credit = data || [];
      }
      else if (currentTab === 'orders') {
        const { data, error } = await sb.from('order_status_events').select(`
          id, from_status, to_status, created_at,
          orders(order_number),
          profiles(name, role)
        `).order('created_at', { ascending: false }).limit(200);
        if (error) throw error;
        logsData.orders = data || [];
      }
      else if (currentTab === 'resets') {
        const { data, error } = await sb.from('password_reset_events').select(`
          id, ip_text, user_agent, created_at,
          profiles(name, email)
        `).order('created_at', { ascending: false }).limit(200);
        if (error) throw error;
        logsData.resets = data || [];
      }

      renderLogsTable();
    } catch (err) {
      console.error('Audit logs fetch error:', err);
      if (container) container.innerHTML = `<div class="text-center mt-3" style="color:var(--color-error)">Failed to load logs: ${err.message}</div>`;
    }
  }

  function renderLogsTable() {
    const container = document.getElementById('auditLogsContent');
    if (!container) return;

    const q = searchTerm.toLowerCase();

    if (currentTab === 'logins') {
      let filtered = logsData.logins;
      if (q) {
        filtered = filtered.filter(l => 
          (l.event || '').toLowerCase().includes(q) ||
          (l.ip_text || '').toLowerCase().includes(q) ||
          (l.profiles?.name || '').toLowerCase().includes(q) ||
          (l.profiles?.email || '').toLowerCase().includes(q)
        );
      }

      container.innerHTML = filtered.length === 0 ? `<div class="text-center" style="padding:40px;color:var(--text-muted)">No login logs found</div>` : `
        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr><th>User</th><th>Email</th><th>Role</th><th>Event</th><th>IP Address</th><th>User Agent</th><th>Timestamp</th></tr>
            </thead>
            <tbody>
              ${filtered.map(l => `
                <tr>
                  <td style="font-weight:600">${l.profiles?.name || '—'}</td>
                  <td>${l.profiles?.email || '—'}</td>
                  <td><span class="badge badge-info">${l.profiles?.role || '—'}</span></td>
                  <td><span class="audit-log-badge ${l.event}">${l.event}</span></td>
                  <td><span class="audit-log-detail-txt">${l.ip_text || '—'}</span></td>
                  <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--text-muted)" title="${l.user_agent || ''}">${l.user_agent || '—'}</td>
                  <td style="font-size:12px;color:var(--text-muted)">${fmtDateTime(l.created_at)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    } 
    else if (currentTab === 'stock') {
      let filtered = logsData.stock;
      if (q) {
        filtered = filtered.filter(s => 
          (s.reason || '').toLowerCase().includes(q) ||
          (s.products?.name || '').toLowerCase().includes(q) ||
          (s.products?.sku || '').toLowerCase().includes(q)
        );
      }

      container.innerHTML = filtered.length === 0 ? `<div class="text-center" style="padding:40px;color:var(--text-muted)">No stock logs found</div>` : `
        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr><th>Product</th><th>SKU</th><th>Stock Change</th><th>Reason</th><th>Timestamp</th></tr>
            </thead>
            <tbody>
              ${filtered.map(s => {
                const changeColor = s.change > 0 ? 'var(--color-success)' : 'var(--color-error)';
                const prefix = s.change > 0 ? '+' : '';
                return `
                  <tr>
                    <td style="font-weight:600">${s.products?.name || '—'}</td>
                    <td><span class="audit-log-detail-txt">${s.products?.sku || '—'}</span></td>
                    <td style="font-weight:700;color:${changeColor}">${prefix}${s.change}</td>
                    <td>${s.reason || '—'}</td>
                    <td style="font-size:12px;color:var(--text-muted)">${fmtDateTime(s.created_at)}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      `;
    }
    else if (currentTab === 'credit') {
      let filtered = logsData.credit;
      if (q) {
        filtered = filtered.filter(c => 
          (c.reason || '').toLowerCase().includes(q) ||
          (c.retailer?.name || '').toLowerCase().includes(q) ||
          (c.retailer?.business_name || '').toLowerCase().includes(q) ||
          (c.adjuster?.name || '').toLowerCase().includes(q)
        );
      }

      container.innerHTML = filtered.length === 0 ? `<div class="text-center" style="padding:40px;color:var(--text-muted)">No credit logs found</div>` : `
        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr><th>Retailer</th><th>Business</th><th>Adjustment</th><th>Reason</th><th>Adjusted By</th><th>Timestamp</th></tr>
            </thead>
            <tbody>
              ${filtered.map(c => {
                const changeColor = c.amount > 0 ? 'var(--color-success)' : 'var(--color-error)';
                const prefix = c.amount > 0 ? '+' : '';
                return `
                  <tr>
                    <td style="font-weight:600">${c.retailer?.name || '—'}</td>
                    <td>${c.retailer?.business_name || '—'}</td>
                    <td style="font-weight:700;color:${changeColor}">${prefix}${fmtCurrency(c.amount)}</td>
                    <td>${c.reason || '—'}</td>
                    <td>${c.adjuster?.name || 'Admin'}</td>
                    <td style="font-size:12px;color:var(--text-muted)">${fmtDateTime(c.created_at)}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      `;
    }
    else if (currentTab === 'orders') {
      let filtered = logsData.orders;
      if (q) {
        filtered = filtered.filter(o => 
          (o.from_status || '').toLowerCase().includes(q) ||
          (o.to_status || '').toLowerCase().includes(q) ||
          (o.orders?.order_number || '').toLowerCase().includes(q) ||
          (o.profiles?.name || '').toLowerCase().includes(q)
        );
      }

      container.innerHTML = filtered.length === 0 ? `<div class="text-center" style="padding:40px;color:var(--text-muted)">No order lifecycle events found</div>` : `
        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr><th>Order #</th><th>From Status</th><th>To Status</th><th>Action By</th><th>Role</th><th>Timestamp</th></tr>
            </thead>
            <tbody>
              ${filtered.map(o => `
                <tr>
                  <td style="font-weight:600">${o.orders?.order_number || '—'}</td>
                  <td><span class="badge badge-${getStatusBadgeClass(o.from_status || '')}">${o.from_status ? o.from_status.replace(/_/g,' ') : 'None'}</span></td>
                  <td><span class="badge badge-${getStatusBadgeClass(o.to_status || '')}">${o.to_status ? o.to_status.replace(/_/g,' ') : 'None'}</span></td>
                  <td style="font-weight:600">${o.profiles?.name || 'System'}</td>
                  <td><span class="badge badge-info">${o.profiles?.role || 'Trigger'}</span></td>
                  <td style="font-size:12px;color:var(--text-muted)">${fmtDateTime(o.created_at)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }
    else if (currentTab === 'resets') {
      let filtered = logsData.resets;
      if (q) {
        filtered = filtered.filter(r => 
          (r.ip_text || '').toLowerCase().includes(q) ||
          (r.profiles?.name || '').toLowerCase().includes(q) ||
          (r.profiles?.email || '').toLowerCase().includes(q)
        );
      }

      container.innerHTML = filtered.length === 0 ? `<div class="text-center" style="padding:40px;color:var(--text-muted)">No password reset logs found</div>` : `
        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr><th>User</th><th>Email</th><th>IP Address</th><th>User Agent</th><th>Timestamp</th></tr>
            </thead>
            <tbody>
              ${filtered.map(r => `
                <tr>
                  <td style="font-weight:600">${r.profiles?.name || '—'}</td>
                  <td>${r.profiles?.email || '—'}</td>
                  <td><span class="audit-log-detail-txt">${r.ip_text || '—'}</span></td>
                  <td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--text-muted)" title="${r.user_agent || ''}">${r.user_agent || '—'}</td>
                  <td style="font-size:12px;color:var(--text-muted)">${fmtDateTime(r.created_at)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }
  }

  // Tab Group listener
  document.querySelectorAll('#auditTabGroup .option-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#auditTabGroup .option-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTab = btn.dataset.tab;
      fetchAudits();
    });
  });

  // Search input listener
  document.getElementById('auditSearch')?.addEventListener('input', (e) => {
    searchTerm = e.target.value;
    renderLogsTable();
  });

  await fetchAudits();
}
// Make navigateTo globally accessible for onclick handlers
window.navigateTo = navigateTo;
