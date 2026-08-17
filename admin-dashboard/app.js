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

// Helper: fetch all profiles in chunks of 1000 to bypass PostgREST max_rows cap
async function fetchAllProfiles(selectCols = '*', role = null) {
  let all = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    let q = sb.from('profiles').select(selectCols).order('created_at', { ascending: false }).range(from, from + pageSize - 1);
    if (role) q = q.eq('role', role);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// Helper: Generate valid UUID v4 (for RPC idempotency keys)
function generateUUID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Page-level state objects
let _ordersState = {};
let _posState = {};
let _invoiceState = {};
let _deliveryMap = null;
let _realtimeChannels = [];
let _dashboardPollTimer = null;

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

  // If token was refreshed or user updated in background, DO NOT reload dashboard or re-render page
  if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
    currentUser = session.user;
    updateUserUI();
    return;
  }

  // If dashboard is already active and user profile is loaded, preserve user state
  if (dashboard.classList.contains('active') && currentProfile && currentProfile.id === session.user.id) {
    currentUser = session.user;
    updateUserUI();
    return;
  }

  try {
    const { data: profile, error: profileError } = await sb
      .from('profiles')
      .select('*')
      .eq('id', session.user.id)
      .single();

    if (profileError) throw profileError;

    if (!profile || profile.role !== 'admin') {
      await sb.auth.signOut();
      showError('Access denied. Only admin accounts can access this dashboard.');
      return;
    }

    currentUser = session.user;
    currentProfile = profile;
    showDashboard();
  } catch (err) {
    console.error('Profile verification error:', err);
    await sb.auth.signOut();
    showError('Failed to verify admin profile: ' + (err.message || 'Access denied'));
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

    // Direct profile validation fallback
    if (authData && authData.user) {
      const { data: profile, error: profErr } = await sb
        .from('profiles')
        .select('*')
        .eq('id', authData.user.id)
        .single();

      if (profErr || !profile || profile.role !== 'admin') {
        await sb.auth.signOut();
        showError('Access denied. Only admin accounts can access this dashboard.');
        setLoginLoading(false);
        return;
      }

      currentUser = authData.user;
      currentProfile = profile;
      showDashboard();
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

function getPageFromHash() {
  const hash = window.location.hash.replace(/^#\/?/, '').trim();
  const path = window.location.pathname.replace(/^\//, '').replace(/\/$/, '').toLowerCase();
  
  if (
    hash === 'address_correction' ||
    hash === 'address-correction' ||
    path === 'address-correction' ||
    path === 'admin/address-correction' ||
    path === 'admin-dashboard/address-correction'
  ) {
    return 'address-correction';
  }

  const validPages = ['dashboard', 'analytics', 'manage', 'orders', 'products', 'stock', 'users', 'retailers', 'address-correction', 'delivery', 'pos', 'invoice', 'audit', 'settings'];

  if (validPages.includes(hash)) return hash;
  if (validPages.includes(path)) return path;

  return 'dashboard';
}

function showDashboard() {
  loginPage.style.display = 'none';
  dashboard.classList.add('active');
  setLoginLoading(false);
  updateUserUI();
  navigateTo(getPageFromHash(), false);
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
  if (_deliveryDebounceTimer) {
    clearTimeout(_deliveryDebounceTimer);
    _deliveryDebounceTimer = null;
  }
  if (_deliveryRealtimeChannel) {
    try { sb.removeChannel(_deliveryRealtimeChannel); } catch (e) {}
    _deliveryRealtimeChannel = null;
  }
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
function escapeHtml(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}
function debounce(fn, waitMs = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
}
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
// NAVIGATION & CHUNKED URL ROUTING
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
  retailers: 'Retailers', 'address-correction': 'Address Correction Portal', delivery: 'Delivery Tracking',
  pos: 'POS Counter Billing', invoice: 'Invoice Import', audit: 'Audit Logs', settings: 'Settings',
};

function navigateTo(page, updateHash = true) {
  cleanupRealtimeChannels();
  if (_dashboardPollTimer) {
    clearInterval(_dashboardPollTimer);
    _dashboardPollTimer = null;
  }
  if (_deliveryMap) { _deliveryMap.remove(); _deliveryMap = null; }
  if (_correctionMap) { _correctionMap.remove(); _correctionMap = null; }
  currentPage = page;

  if (updateHash && window.location.hash !== '#' + page) {
    window.location.hash = '#' + page;
  }

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
    'address-correction': renderAddressCorrection,
    delivery: renderDelivery,
    pos: renderPOS,
    invoice: renderInvoice,
    audit: renderAudit,
    settings: renderSettings,
  };

  (renderers[page] || renderDashboard)();
}

window.addEventListener('hashchange', () => {
  const page = getPageFromHash();
  if (page !== currentPage) {
    navigateTo(page, false);
  }
});

// ============================================================
// DASHBOARD PAGE
// ============================================================

async function renderDashboard() {
  pageContent.innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:8px">
      <button type="button" class="btn btn-secondary" id="dashboardRefreshBtn" style="padding:8px 14px;font-size:13px" title="Refresh stats">↻ Refresh</button>
    </div>
    <div class="stats-grid" id="statsGrid">${renderStatCardSkeleton(6)}</div>
    <div class="section-card mb-2" id="deliveryOpsPanel" style="margin-top:16px">
      <div class="section-card-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <h3 class="section-card-title">🚚 Live Delivery Operations</h3>
        <button type="button" class="btn btn-secondary" style="padding:6px 12px;font-size:12px" onclick="navigateTo('delivery')">Open Fleet Map →</button>
      </div>
      <div class="stats-grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));margin-top:12px" id="deliveryOpsGrid">
        ${renderStatCardSkeleton(6)}
      </div>
    </div>
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
  document.getElementById('dashboardRefreshBtn')?.addEventListener('click', () => {
    const grid = document.getElementById('statsGrid');
    const opsGrid = document.getElementById('deliveryOpsGrid');
    if (grid) grid.innerHTML = renderStatCardSkeleton(6);
    if (opsGrid) opsGrid.innerHTML = renderStatCardSkeleton(6);
    fetchDashboardStats();
  });
  await fetchDashboardStats();
  if (_dashboardPollTimer) clearInterval(_dashboardPollTimer);
  _dashboardPollTimer = setInterval(() => {
    if (currentPage === 'dashboard') fetchDashboardStats(true);
  }, 45000);
}

async function fetchDashboardStats(silent = false) {
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const { data, error } = await sb.rpc('get_admin_dashboard_stats', { p_today: today.toISOString() });
    if (error) throw error;
    dashboardStats = data || {};
    let ops = deliveryOpsFromStats(dashboardStats);
    if (!ops) ops = await fetchDeliveryOpsSummary();
    if (!silent) {
      renderStatsCards(dashboardStats);
      renderDeliveryOpsCards(ops);
      renderSystemStatusPanel(ops);
    } else {
      renderDeliveryOpsCards(ops);
      renderSystemStatusPanel(ops);
    }
    updateBadges({ ...dashboardStats, ...(ops || {}) });
  } catch (err) {
    console.error('Dashboard stats error:', err);
    if (!silent) renderStatsCardsFallback();
  }
}

function deliveryOpsFromStats(s) {
  if (!s || s.activeDeliveries == null) return null;
  return {
    activeDeliveries: s.activeDeliveries || 0,
    unassignedDelivery: s.unassignedDelivery || 0,
    deliveredToday: s.deliveredToday || 0,
    failedToday: s.failedToday || 0,
    ridersOnDuty: s.ridersOnDuty || 0,
    ridersOnline: s.ridersOnline || 0,
  };
}

function renderDeliveryOpsCards(ops) {
  const grid = document.getElementById('deliveryOpsGrid');
  if (!grid || !ops) return;
  grid.innerHTML = `
    <div class="stat-card info"><div class="stat-card-header"><div class="stat-card-icon">🚚</div></div><div class="stat-card-value">${ops.activeDeliveries}</div><div class="stat-card-label">In Flight Deliveries</div></div>
    <div class="stat-card warning"><div class="stat-card-header"><div class="stat-card-icon">📦</div></div><div class="stat-card-value">${ops.unassignedDelivery}</div><div class="stat-card-label">Awaiting Rider</div></div>
    <div class="stat-card success"><div class="stat-card-header"><div class="stat-card-icon">✅</div></div><div class="stat-card-value">${ops.deliveredToday}</div><div class="stat-card-label">Delivered Today</div></div>
    <div class="stat-card error"><div class="stat-card-header"><div class="stat-card-icon">⚠️</div></div><div class="stat-card-value">${ops.failedToday}</div><div class="stat-card-label">Failed Today</div></div>
    <div class="stat-card primary"><div class="stat-card-header"><div class="stat-card-icon">🏍️</div></div><div class="stat-card-value">${ops.ridersOnDuty}</div><div class="stat-card-label">Riders On Duty</div></div>
    <div class="stat-card success"><div class="stat-card-header"><div class="stat-card-icon">📡</div></div><div class="stat-card-value">${ops.ridersOnline}</div><div class="stat-card-label">GPS Live (5m)</div></div>
  `;
}

function renderSystemStatusPanel(ops) {
  const el = document.getElementById('systemStatusList');
  if (!el) return;
  const fleetOk = (ops?.ridersOnline || 0) > 0 || (ops?.activeDeliveries || 0) === 0;
  const unassigned = ops?.unassignedDelivery || 0;
  el.innerHTML = `
    <li class="activity-item"><span class="activity-dot success"></span><span class="activity-text">Supabase & auth connected</span><span class="activity-time">Live</span></li>
    <li class="activity-item"><span class="activity-dot ${fleetOk ? 'success' : 'warning'}"></span><span class="activity-text">Fleet GPS telemetry</span><span class="activity-time">${ops?.ridersOnline || 0} online</span></li>
    <li class="activity-item"><span class="activity-dot ${unassigned > 0 ? 'warning' : 'success'}"></span><span class="activity-text">Delivery queue</span><span class="activity-time">${ops?.activeDeliveries || 0} in flight · ${unassigned} need rider</span></li>
    <li class="activity-item"><span class="activity-dot ${(ops?.failedToday || 0) > 0 ? 'error' : 'success'}"></span><span class="activity-text">Failed deliveries today</span><span class="activity-time">${ops?.failedToday || 0}</span></li>
  `;
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
  const db = document.getElementById('activeDeliveryBadge');
  if (db && s.activeDeliveries != null) {
    if (s.activeDeliveries > 0) { db.textContent = s.activeDeliveries; db.style.display = ''; }
    else db.style.display = 'none';
  }
}

function orderHasAssignedRider(order) {
  if (!order) return false;
  return Boolean(order.assigned_to || order.rider_id || order.rider?.id);
}

function isDeliveryFulfillment(order) {
  const mode = (order?.fulfillment_mode || 'delivery').toLowerCase();
  return mode === 'delivery' || mode === 'doorstep';
}

async function fetchDeliveryOpsSummary() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const inFlightStatuses = ['assigned', 'accepted', 'packed', 'dispatched', 'in_transit', 'out_for_delivery', 'picked_up'];
  try {
    const [
      inFlightRes,
      unassignedRes,
      failedTodayRes,
      deliveredTodayRes,
      ridersOnDutyRes,
      onlineTrackingRes,
    ] = await Promise.all([
      sb.from('orders').select('*', { count: 'exact', head: true })
        .in('status', inFlightStatuses)
        .neq('fulfillment_mode', 'pickup')
        .neq('fulfillment_mode', 'self_pickup'),
      sb.from('orders').select('*', { count: 'exact', head: true })
        .in('status', ['approved', 'packed'])
        .neq('fulfillment_mode', 'pickup')
        .neq('fulfillment_mode', 'self_pickup')
        .is('assigned_to', null),
      sb.from('orders').select('*', { count: 'exact', head: true })
        .eq('status', 'delivery_failed')
        .gte('updated_at', today.toISOString()),
      sb.from('orders').select('*', { count: 'exact', head: true })
        .eq('status', 'delivered')
        .gte('delivered_at', today.toISOString()),
      sb.from('profiles').select('*', { count: 'exact', head: true })
        .or('role.eq.delivery,role.eq.driver')
        .eq('is_on_duty', true),
      sb.from('delivery_tracking').select('rider_id', { count: 'exact', head: true })
        .gte('updated_at', new Date(Date.now() - 5 * 60 * 1000).toISOString()),
    ]);

    return {
      activeDeliveries: inFlightRes.count || 0,
      unassignedDelivery: unassignedRes.count || 0,
      failedToday: failedTodayRes.count || 0,
      deliveredToday: deliveredTodayRes.count || 0,
      ridersOnDuty: ridersOnDutyRes.count || 0,
      ridersOnline: onlineTrackingRes.count || 0,
    };
  } catch (err) {
    console.warn('Delivery ops summary error:', err);
    return null;
  }
}

function renderQuickActionCards() {
  const actions = [
    { icon: '📋', title: 'Process Orders', desc: 'Review and process pending orders', page: 'orders' },
    { icon: '🚚', title: 'Live Deliveries', desc: 'Fleet map, GPS & proof of delivery', page: 'delivery' },
    { icon: '📍', title: 'Address Pins', desc: 'Verify retailer shop locations', page: 'address-correction' },
    { icon: '📦', title: 'Check Stock', desc: 'View low stock alerts', page: 'stock' },
    { icon: '👥', title: 'Verify Users', desc: 'Approve pending registrations', page: 'users' },
    { icon: '📈', title: 'View Analytics', desc: 'Sales & revenue insights', page: 'analytics' },
  ];
  return actions.map(a => `<div class="quick-action-card" onclick="navigateTo('${a.page}')" style="cursor:pointer"><div class="quick-action-icon">${a.icon}</div><div class="quick-action-info"><h4>${a.title}</h4><p>${a.desc}</p></div></div>`).join('');
}

function renderSystemStatus() {
  return `<ul class="activity-list" id="systemStatusList">${renderSystemStatusSkeleton()}</ul>`;
}

function renderSystemStatusSkeleton() {
  return `<li class="activity-item"><span class="activity-dot primary"></span><span class="activity-text">Loading fleet status...</span><span class="activity-time">—</span></li>`;
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
      else { customBox.style.display = 'none'; customBox.classList.add('hidden'); loadAnalytics(r); }
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
    await renderDeliveryOpsAnalyticsSection(container, fromDate, toDate);
  } catch (err) {
    console.error('Analytics error:', err);
    container.innerHTML = `<div class="text-center mt-3" style="color:var(--color-error)">Failed to load analytics: ${escapeHtml(err.message)}</div>`;
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
    a.download = `analytics_${fmtDate(fromDate)}_${fmtDate(toDate)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

async function renderDeliveryOpsAnalyticsSection(container, fromDate, toDate) {
  const host = document.createElement('div');
  host.id = 'deliveryAnalyticsSection';
  host.innerHTML = `<div class="section-card mt-2"><div class="section-card-header"><h3 class="section-card-title">🚚 Delivery & Logistics Performance</h3></div><div id="deliveryAnalyticsBody" style="padding:8px 0;color:var(--text-muted);font-size:13px">Loading delivery metrics...</div></div>`;
  container.appendChild(host);

  try {
    const { data, error } = await sb.rpc('get_delivery_ops_analytics', {
      p_from_date: fromDate.toISOString(),
      p_to_date: toDate.toISOString(),
    });
    if (error) throw error;

    const summary = data?.summary || {};
    const topRiders = data?.top_riders || [];
    const body = document.getElementById('deliveryAnalyticsBody');
    if (!body) return;

    body.innerHTML = `
      <div class="stats-grid mb-2" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">
        <div class="stat-card success"><div class="stat-card-value">${summary.delivered_count || 0}</div><div class="stat-card-label">Delivered</div></div>
        <div class="stat-card error"><div class="stat-card-value">${summary.failed_count || 0}</div><div class="stat-card-label">Failed</div></div>
        <div class="stat-card info"><div class="stat-card-value">${summary.in_transit_count || 0}</div><div class="stat-card-label">In Transit (created in range)</div></div>
        <div class="stat-card primary"><div class="stat-card-value">${summary.avg_delivery_minutes || 0}m</div><div class="stat-card-label">Avg Dispatch→Deliver</div></div>
        <div class="stat-card warning"><div class="stat-card-value">${summary.pod_count || 0}</div><div class="stat-card-label">POD Photos</div></div>
        <div class="stat-card"><div class="stat-card-value">${summary.delivery_orders || 0}/${(summary.delivery_orders || 0) + (summary.pickup_orders || 0)}</div><div class="stat-card-label">Delivery vs Pickup</div></div>
      </div>
      ${topRiders.length === 0 ? '<p style="color:var(--text-muted);font-size:13px">No rider delivery data in this period.</p>' : `
        <div class="table-responsive" style="border:none;margin-top:8px">
          <table class="data-table"><thead><tr><th>#</th><th>Rider</th><th>Deliveries</th></tr></thead><tbody>
          ${topRiders.map((r, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(r.rider_name || '—')}</td><td>${r.delivered_count || 0}</td></tr>`).join('')}
          </tbody></table>
        </div>`}
    `;
  } catch (err) {
    const body = document.getElementById('deliveryAnalyticsBody');
    if (body) {
      body.innerHTML = `<p style="color:var(--color-warning);font-size:13px">Delivery analytics unavailable. Apply migration <code>migration-admin-production-v86.sql</code> on Supabase, then refresh.</p>`;
    }
    console.warn('Delivery analytics:', err);
  }
}

function getStatusColor(status) {
  const m = { pending: '#FFA500', pending_payment: '#FFD700', approved: '#4A90D9', packed: '#8B83FF', dispatched: '#00C896', delivered: '#00A67E', cancelled: '#FF6B6B', rejected: '#EE5A24', delivery_failed: '#FF6B6B' };
  return m[status] || '#6C63FF';
}

// ============================================================
// ORDERS PAGE
// ============================================================

async function renderOrders() {
  _ordersState = { orders: [], selected: new Set(), batchMode: false, searchTerm: '', logisticsFilter: 'all' };

  pageContent.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px">
      <input type="text" class="form-input" id="ordersSearch" placeholder="Search by customer, phone, or order #..." style="margin:0;max-width:320px;flex:1;min-width:200px">
      <div class="option-pill-group" id="ordersLogisticsFilter">
        <button class="option-chip active" data-logistics="all">All</button>
        <button class="option-chip" data-logistics="delivery">🚚 Delivery</button>
        <button class="option-chip" data-logistics="pickup">🏪 Pickup</button>
        <button class="option-chip" data-logistics="unassigned">⚠️ No Rider</button>
        <button class="option-chip" data-logistics="in_transit">📡 In Transit</button>
      </div>
    </div>
    <div style="display:flex;align-items:center;justify-content:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:16px">
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

  document.getElementById('ordersSearch')?.addEventListener('input', debounce((e) => {
    _ordersState.searchTerm = e.target.value.toLowerCase().trim();
    renderOrderCards();
  }, 200));

  document.querySelectorAll('#ordersLogisticsFilter .option-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#ordersLogisticsFilter .option-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _ordersState.logisticsFilter = btn.dataset.logistics || 'all';
      renderOrderCards();
    });
  });

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
      let rpcSuccess = false;
      try {
        const { error } = await sb.rpc('batch_update_order_status', { p_order_ids: ids, p_new_status: status });
        if (!error) rpcSuccess = true;
      } catch(e) {}

      if (!rpcSuccess) {
        const { error } = await sb.from('orders').update({ status }).in('id', ids);
        if (error) throw error;
      }

      showToast(`${ids.length} order(s) updated to ${status.replace(/_/g, ' ')}`, 'success');
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
      id, order_number, status, delivery_status, grand_total, subtotal, gst, payment_mode, fulfillment_mode,
      created_at, notes, items, assigned_to,
      user:profiles!orders_user_id_fkey(id, name, business_name, phone, area, city),
      rider:profiles!orders_rider_id_fkey(id, name, phone),
      order_items(id, qty, unit_price, line_total, product:products(name, sku, pack_size))
    `).order('created_at', { ascending: false }).limit(500);
    if (error) throw error;
    _ordersState.orders = (data || []).map(o => ({
      ...o,
      order_items: (o.order_items || []).map(it => ({
        ...it,
        product_name: it.product?.name || 'Product',
        pack_size: it.product?.pack_size || '',
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

  const q = _ordersState.searchTerm || '';
  const lf = _ordersState.logisticsFilter || 'all';
  let filteredOrders = _ordersState.orders;

  if (lf === 'delivery') {
    filteredOrders = filteredOrders.filter(o => isDeliveryFulfillment(o));
  } else if (lf === 'pickup') {
    filteredOrders = filteredOrders.filter(o => !isDeliveryFulfillment(o));
  } else if (lf === 'unassigned') {
    filteredOrders = filteredOrders.filter(o => isDeliveryFulfillment(o) && !orderHasAssignedRider(o) && ['approved', 'packed'].includes(o.status));
  } else if (lf === 'in_transit') {
    filteredOrders = filteredOrders.filter(o => ['dispatched', 'in_transit', 'out_for_delivery', 'picked_up'].includes(o.status));
  }

  if (q) {
    filteredOrders = filteredOrders.filter(o =>
      (o.order_number || o.id || '').toLowerCase().includes(q) ||
      (o.user?.business_name || '').toLowerCase().includes(q) ||
      (o.user?.name || '').toLowerCase().includes(q) ||
      (o.user?.phone || '').includes(q) ||
      (o.status || '').toLowerCase().includes(q) ||
      (o.order_items || []).some(it => (it.product_name || '').toLowerCase().includes(q))
    );
  }

  const groups = { incoming: [], active: [], completed: [] };
  filteredOrders.forEach(o => {
    if (incoming.includes(o.status)) groups.incoming.push(o);
    else if (active.includes(o.status)) groups.active.push(o);
    else groups.completed.push(o);
  });

  const renderCard = (o) => {
    const customerName = escapeHtml(o.user?.business_name || o.user?.name || 'Unknown');
    const orderId = escapeAttr(o.id);
    const orderLabel = escapeHtml(o.order_number || o.id.slice(0, 8));
    const itemCount = (o.order_items?.length || (Array.isArray(o.items) ? o.items.length : 0)) || 0;
    const sel = _ordersState.selected.has(o.id) ? 'pipeline-card-selected' : '';
    const checkbox = _ordersState.batchMode ? `<input type="checkbox" ${_ordersState.selected.has(o.id) ? 'checked' : ''} style="accent-color:var(--color-primary);width:16px;height:16px;margin-right:8px" onclick="event.stopPropagation();toggleOrderSelect('${orderId}')">` : '';
    const fulfillTag = isDeliveryFulfillment(o) ? '🚚' : '🏪';
    const riderLine = isDeliveryFulfillment(o)
      ? (orderHasAssignedRider(o) ? ` · ${escapeHtml(o.rider?.name || 'Rider assigned')}` : ' · <span style="color:var(--color-warning)">No rider</span>')
      : '';

    return `<div class="pipeline-card ${sel}" onclick="${_ordersState.batchMode ? `toggleOrderSelect('${orderId}')` : `openOrderDetail('${orderId}')`}">
      <div class="pipeline-card-header">${checkbox}<span class="pipeline-card-id">#${orderLabel}</span><span class="pipeline-card-time">${timeAgo(o.created_at)}</span></div>
      <div class="pipeline-card-body">${fulfillTag} ${customerName}${riderLine} · ${itemCount} items</div>
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
  let order = _ordersState.orders.find(o => o.id === id);
  let orderItems = [];
  let podProof = null;
  let timeline = [];

  try {
    const [orderRes, itemsRes, podRes, timelineRes] = await Promise.all([
      sb.from('orders').select(`
        id, order_number, status, grand_total, subtotal, gst, delivery_fee, discount, payment_mode, fulfillment_mode, created_at, notes, delivery_address, items,
        user:profiles!orders_user_id_fkey(id, name, business_name, phone, address, area, city, pincode),
        rider:profiles!orders_rider_id_fkey(id, name, phone)
      `).eq('id', id).single(),
      sb.from('order_items').select(`
        id, qty, unit_price, gst_percent, line_total, product_id,
        product:products(id, name, sku, pack_size, selling_price)
      `).eq('order_id', id),
      sb.from('delivery_proofs').select('*').eq('order_id', id).maybeSingle(),
      sb.rpc('get_order_timeline', { p_order_id: id })
    ]);

    if (orderRes.data) order = orderRes.data;
    podProof = podRes?.data || null;
    timeline = timelineRes?.data || [];

    if (itemsRes.data && itemsRes.data.length > 0) {
      orderItems = itemsRes.data.map(it => ({
        name: it.product?.name || 'Product',
        sku: it.product?.sku || '',
        pack_size: it.product?.pack_size || '',
        quantity: it.qty || 1,
        unit_price: it.unit_price || 0,
        gst_percent: it.gst_percent || 0,
        line_total: it.line_total || (it.qty * it.unit_price) || 0
      }));
    } else if (order.items && Array.isArray(order.items) && order.items.length > 0) {
      const productIds = order.items.map(it => it.product_id).filter(Boolean);
      let prodNameMap = {};
      if (productIds.length > 0) {
        const { data: prods } = await sb.from('products').select('id, name, sku, pack_size').in('id', productIds);
        (prods || []).forEach(p => { prodNameMap[p.id] = p; });
      }

      orderItems = order.items.map(it => {
        const pInfo = prodNameMap[it.product_id] || {};
        return {
          name: it.name || it.product_name || pInfo.name || 'Product',
          sku: it.sku || pInfo.sku || '',
          pack_size: it.pack_size || pInfo.pack_size || '',
          quantity: it.qty || it.quantity || 1,
          unit_price: it.price || it.unit_price || 0,
          gst_percent: it.gst || it.gst_percent || 0,
          line_total: it.total || it.line_total || ((it.qty || 1) * (it.price || it.unit_price || 0))
        };
      });
    }
  } catch (err) {
    console.error('Error fetching order detail:', err);
  }

  if (!order) return;

  const nextStatus = getNextStatus(order.status);
  const customerName = order.user?.business_name || order.user?.name || 'Unknown Customer';
  const customerPhone = order.user?.phone || '';
  const customerAddress = order.delivery_address || order.user?.address || `${order.user?.area || ''} ${order.user?.city || ''} ${order.user?.pincode || ''}`.trim() || 'No address provided';
  const riderName = order.rider?.name || 'Unassigned';
  const riderPhone = order.rider?.phone || '';
  const trackShareUrl = `${window.location.origin}/track.html?id=${order.id}`;

  let timelineHtml = '<p style="color:var(--text-muted);font-size:12px">No timeline events</p>';
  if (timeline && timeline.length > 0) {
    timelineHtml = `<div class="timeline">${timeline.map((t, i) => `
      <div class="timeline-step ${i === 0 ? 'active' : 'success'}">
        <div class="timeline-step-title">${(t.status || '').replace(/_/g,' ')}</div>
        <div class="timeline-step-desc">${fmtDateTime(t.created_at)}${t.changed_by_name ? ` · by ${t.changed_by_name}` : ''}</div>
      </div>
    `).join('')}</div>`;
  }

  let podHtml = '';
  if (podProof && podProof.photo_url) {
    podHtml = `
      <div style="margin-top:14px;padding:12px;background:var(--bg-surface);border-radius:10px">
        <h4 style="font-size:13px;font-weight:700;margin-bottom:8px">📸 Proof of Delivery</h4>
        <div style="display:flex;align-items:center;gap:12px">
          <img src="${podProof.photo_url}" alt="POD" style="width:72px;height:72px;object-fit:cover;border-radius:8px;cursor:pointer;border:1px solid var(--border-color)" onclick="window.open('${podProof.photo_url}','_blank')">
          <div>
            <div style="font-size:12px;font-weight:600">Delivered by ${podProof.rider_name || riderName}</div>
            <div style="font-size:11px;color:var(--text-muted)">${fmtDateTime(podProof.created_at)}</div>
            <a href="${podProof.photo_url}" target="_blank" style="font-size:11px;color:var(--color-primary);font-weight:600;margin-top:4px;display:inline-block">View Full Image ↗</a>
          </div>
        </div>
      </div>
    `;
  }

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card large" style="max-height:90vh;overflow-y:auto">
      <div class="modal-header">
        <div>
          <h3 class="modal-title">Order #${order.order_number || order.id.slice(0,8)}</h3>
          <span style="font-size:12px;color:var(--text-muted)">Placed on ${fmtDateTime(order.created_at)}</span>
        </div>
        <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">✕</button>
      </div>

      <div class="modal-body">
        <!-- Customer & Order Grid -->
        <div class="form-grid mb-2" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px">
          <div style="background:var(--bg-surface);padding:10px;border-radius:8px">
            <span style="font-size:11px;color:var(--text-muted);font-weight:600">CUSTOMER</span>
            <div style="font-weight:700;font-size:14px;margin-top:2px">${customerName}</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:2px">📱 ${customerPhone || '—'}</div>
          </div>

          <div style="background:var(--bg-surface);padding:10px;border-radius:8px">
            <span style="font-size:11px;color:var(--text-muted);font-weight:600">STATUS & PAYMENT</span>
            <div style="margin-top:2px"><span class="badge badge-${getStatusBadgeClass(order.status)}">${order.status.replace(/_/g,' ')}</span></div>
            <div style="font-size:12px;font-weight:600;margin-top:4px;text-transform:uppercase">💳 ${order.payment_mode || 'COD'}</div>
          </div>

          <div style="background:var(--bg-surface);padding:10px;border-radius:8px">
            <span style="font-size:11px;color:var(--text-muted);font-weight:600">FULFILLMENT & RIDER</span>
            <div style="font-weight:700;font-size:13px;margin-top:2px;text-transform:capitalize">🚚 ${(order.fulfillment_mode || 'delivery').replace(/_/g,' ')}</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:2px">🏍️ ${riderName} ${riderPhone ? `(${riderPhone})` : ''}</div>
          </div>

          <div style="background:var(--bg-surface);padding:10px;border-radius:8px">
            <span style="font-size:11px;color:var(--text-muted);font-weight:600">TOTAL AMOUNT</span>
            <div style="font-weight:800;font-size:18px;color:var(--color-primary);margin-top:2px">${fmtCurrency(order.grand_total)}</div>
            <div style="font-size:11px;color:var(--text-muted)">${orderItems.length} product(s)</div>
          </div>
        </div>

        <!-- Address Box -->
        <div style="background:var(--bg-surface);padding:10px 14px;border-radius:8px;margin-bottom:14px">
          <div style="font-size:11px;color:var(--text-muted);font-weight:600">DELIVERY ADDRESS</div>
          <div style="font-size:13px;font-weight:500;margin-top:2px">📍 ${customerAddress}</div>
        </div>

        <!-- Share Live Tracking Link -->
        <div style="display:flex;align-items:center;justify-content:space-between;background:rgba(108,99,255,0.08);border:1px solid rgba(108,99,255,0.25);padding:10px 14px;border-radius:8px;margin-bottom:14px;flex-wrap:wrap;gap:8px">
          <div>
            <div style="font-size:12px;font-weight:700;color:var(--color-primary)">📍 Retailer Live Tracking Webpage</div>
            <div style="font-size:11px;color:var(--text-muted);word-break:break-all">${trackShareUrl}</div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn btn-secondary" style="padding:6px 12px;font-size:12px" onclick="navigator.clipboard.writeText('${trackShareUrl}');showToast('Tracking link copied!','success')">📋 Copy Link</button>
            <a href="${trackShareUrl}" target="_blank" class="btn btn-primary" style="padding:6px 12px;font-size:12px;text-decoration:none;display:inline-flex;align-items:center">Live Track ↗</a>
          </div>
        </div>

        ${order.notes ? `<div style="background:var(--bg-surface);padding:10px;border-radius:8px;margin-bottom:14px;font-size:13px">📝 <strong>Notes:</strong> ${order.notes}</div>` : ''}

        <!-- Product Items Table -->
        <h4 style="margin-bottom:8px;font-size:14px;font-weight:700">📦 Products in Order (${orderItems.length})</h4>
        <div class="table-responsive mb-2">
          <table class="data-table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Pack Size</th>
                <th>Qty</th>
                <th>Price</th>
                <th>GST %</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              ${orderItems.length === 0 ? '<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text-muted)">No items found in this order</td></tr>' :
                orderItems.map(it => `
                  <tr>
                    <td style="font-weight:600">
                      ${it.name}
                      ${it.sku ? `<div style="font-size:11px;color:var(--text-muted)">SKU: ${it.sku}</div>` : ''}
                    </td>
                    <td style="font-size:12px">${it.pack_size || '—'}</td>
                    <td style="font-weight:700">${it.quantity}</td>
                    <td>${fmtCurrency(it.unit_price)}</td>
                    <td>${it.gst_percent || 0}%</td>
                    <td style="font-weight:700">${fmtCurrency(it.line_total)}</td>
                  </tr>
                `).join('')
              }
            </tbody>
          </table>
        </div>

        <!-- Financial Breakdown -->
        <div style="background:var(--bg-surface);padding:12px 16px;border-radius:10px;margin-bottom:14px;margin-left:auto;max-width:320px">
          ${order.subtotal != null ? `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px"><span style="color:var(--text-muted)">Subtotal:</span><span>${fmtCurrency(order.subtotal)}</span></div>` : ''}
          ${order.gst != null ? `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px"><span style="color:var(--text-muted)">GST Total:</span><span>${fmtCurrency(order.gst)}</span></div>` : ''}
          ${order.delivery_fee ? `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px"><span style="color:var(--text-muted)">Delivery Fee:</span><span>${fmtCurrency(order.delivery_fee)}</span></div>` : ''}
          ${order.discount ? `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;color:var(--color-success)"><span>Discount:</span><span>-${fmtCurrency(order.discount)}</span></div>` : ''}
          <div style="display:flex;justify-content:space-between;font-size:15px;font-weight:800;border-top:1px solid var(--border-color);padding-top:6px;margin-top:6px"><span>Grand Total:</span><span style="color:var(--color-primary)">${fmtCurrency(order.grand_total)}</span></div>
        </div>

        ${podHtml}

        <!-- Order Timeline -->
        <h4 style="margin-top:16px;margin-bottom:8px;font-size:14px;font-weight:700">⏱️ Status History & Timeline</h4>
        ${timelineHtml}
      </div>

      <div class="modal-footer" style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
        ${renderOrderActionButtons(order)}
        ${!['delivered','cancelled','rejected'].includes(order.status) ? `<button class="btn btn-danger" onclick="advanceOrderStatus('${id}','cancelled')">✕ Cancel Order</button>` : ''}
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
};

function renderOrderActionButtons(order) {
  const isPickup = order.fulfillment_mode === 'pickup' || order.fulfillment_mode === 'self_pickup';
  const hasRider = orderHasAssignedRider(order);
  const s = order.status;
  const id = order.id;

  if (s === 'pending' || s === 'pending_payment') {
    return `<button class="btn btn-primary" onclick="advanceOrderStatus('${id}','approved')">✓ Approve Order</button>`;
  }
  if (s === 'approved') {
    return `<button class="btn btn-primary" onclick="advanceOrderStatus('${id}','packed')">✓ Mark Packed</button>`;
  }
  if (s === 'packed') {
    if (isPickup) {
      return `<button class="btn btn-primary" onclick="advanceOrderStatus('${id}','dispatched')">✓ Ready for Pickup</button>`;
    }
    if (!hasRider) {
      return `<button class="btn btn-primary" style="background:#0284C7;border-color:#0284C7" onclick="assignRiderModal('${id}')">🚚 Assign Rider to Dispatch ➔</button>`;
    }
    return `
      <button class="btn btn-secondary" onclick="assignRiderModal('${id}')">🔄 Reassign (${order.rider?.name || 'Rider'})</button>
      <button class="btn btn-primary" onclick="advanceOrderStatus('${id}','dispatched')">✓ Mark Dispatched</button>
    `;
  }
  if (s === 'assigned') {
    return `
      <button class="btn btn-secondary" onclick="assignRiderModal('${id}')">🔄 Reassign (${order.rider?.name || 'Rider'})</button>
      <button class="btn btn-primary" onclick="advanceOrderStatus('${id}','dispatched')">✓ Mark Dispatched</button>
    `;
  }
  if (s === 'accepted') {
    return `
      <button class="btn btn-secondary" onclick="assignRiderModal('${id}')">🔄 Reassign</button>
      <button class="btn btn-primary" onclick="advanceOrderStatus('${id}','dispatched')">✓ Confirm Dispatched / In Transit</button>
    `;
  }
  if (s === 'picked_up') {
    return `
      <button class="btn btn-primary" onclick="advanceOrderStatus('${id}','dispatched')">✓ Confirm Dispatched / In Transit</button>
    `;
  }
  if (s === 'dispatched' || s === 'in_transit' || s === 'out_for_delivery') {
    return `
      <a href="/track.html?id=${id}" target="_blank" class="btn btn-secondary" style="text-decoration:none;display:inline-flex;align-items:center;gap:4px">📍 Live Track ↗</a>
      <button class="btn btn-warning" style="background:#F59E0B;color:#FFF;border-color:#D97706;font-size:11px" onclick="advanceOrderStatus('${id}','delivered',true)">⚠️ Admin Force Delivered</button>
    `;
  }
  return '';
}

function getNextStatus(s) {
  const flow = { pending: 'approved', pending_payment: 'pending', approved: 'packed', packed: 'assigned', assigned: 'dispatched', accepted: 'dispatched', cancellation_requested: 'cancelled' };
  return flow[s] || null;
}

window.advanceOrderStatus = async function(id, newStatus, isForce = false) {
  let order = _ordersState?.orders?.find(o => o.id === id);
  if (!order) {
    const { data } = await sb.from('orders').select('id, status, assigned_to, fulfillment_mode, delivery_type, delivery_status').eq('id', id).single();
    order = data;
  }

  const isPickup = order?.fulfillment_mode === 'pickup' || order?.fulfillment_mode === 'self_pickup';

  if (newStatus === 'cancelled') {
    if (!confirm('Are you sure you want to cancel this order? Associated stock and credit balances will be restored.')) {
      return;
    }
  }

  // Guard: Cannot dispatch delivery order without assigned rider
  if (newStatus === 'dispatched' && !isPickup && !orderHasAssignedRider(order)) {
    showToast('⚠️ Please assign a delivery driver before dispatching.', 'warning');
    assignRiderModal(id);
    return;
  }

  // Guard: Deliveries with assigned rider must normally be completed via driver OTP/POD app
  if (newStatus === 'delivered' && !isPickup && orderHasAssignedRider(order) && isForce) {
    if (!confirm('⚠️ Standard deliveries must be marked Delivered by the assigned driver via OTP / photo verification on their app.\n\nAre you sure you want to force-mark this order as Delivered from Admin?')) {
      return;
    }
  }

  try {
    const { error } = await sb.from('orders').update({
      status: newStatus,
      ...(newStatus === 'dispatched' ? { dispatched_at: new Date().toISOString(), delivery_status: 'in_transit' } : {}),
      ...(newStatus === 'delivered' ? { delivered_at: new Date().toISOString(), delivery_status: 'delivered' } : {})
    }).eq('id', id);
    if (error) throw error;
    showToast(`Order updated to ${newStatus.replace(/_/g, ' ')}`, 'success');
    document.querySelector('.modal-overlay')?.remove();
    loadOrders();
  } catch (err) { showToast(err.message, 'error'); }
};

window.assignRiderModal = async function(orderId) {
  try {
    let riders = [];
    const { data: rpcRiders, error: rpcErr } = await sb.rpc('list_delivery_staff', { p_on_duty_only: false });
    if (!rpcErr && rpcRiders && rpcRiders.length > 0) {
      riders = rpcRiders;
    } else {
      const { data: profRiders } = await sb.from('profiles')
        .select('id, name, business_name, phone, is_on_duty, current_order_count')
        .or('role.eq.delivery,role.eq.driver')
        .order('name', { ascending: true });
      riders = (profRiders || []).map(r => ({
        id: r.id,
        name: r.name || r.business_name || 'Delivery Driver',
        phone: r.phone,
        is_on_duty: r.is_on_duty ?? false,
        current_order_count: r.current_order_count ?? 0
      }));
    }

    if (!riders || riders.length === 0) {
      showToast('No delivery personnel found in system', 'warning');
      return;
    }

    // Remove existing modal first
    document.querySelector('.modal-overlay')?.remove();

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-card">
        <div class="modal-header">
          <h3 class="modal-title">🚚 Assign Delivery Driver</h3>
          <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">✕</button>
        </div>
        <div class="modal-body" style="max-height:400px;overflow-y:auto">
          <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px">Select a driver below to assign this order (${riders.length} driver(s) available):</p>
          ${riders.map(r => `
            <div class="driver-card" onclick="doAssignRider('${orderId}','${r.id}')" style="display:flex;align-items:center;justify-content:space-between;padding:12px;margin-bottom:8px;background:var(--bg-surface);border:1px solid var(--border-color);border-radius:8px;cursor:pointer;transition:all 0.15s ease">
              <div>
                <div class="driver-card-name" style="font-weight:700;font-size:14px">${r.name || 'Delivery Driver'}</div>
                <div class="driver-card-meta" style="font-size:12px;color:var(--text-muted);margin-top:2px">
                  📱 ${r.phone || 'No phone'} · <span style="color:${r.is_on_duty ? 'var(--color-success)' : 'var(--text-muted)'};font-weight:600">${r.is_on_duty ? '🟢 On duty' : '⚪ Off duty'}</span> · ${r.current_order_count || 0} active order(s)
                </div>
              </div>
              <button class="btn btn-primary" style="padding:6px 12px;font-size:12px">Assign ➔</button>
            </div>
          `).join('')}
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  } catch (err) { showToast(err.message, 'error'); }
};

window.doAssignRider = async function(orderId, riderId) {
  try {
    const { data: order, error: fetchErr } = await sb
      .from('orders')
      .select('id, status, fulfillment_mode, delivery_status, assigned_to')
      .eq('id', orderId)
      .single();
    if (fetchErr || !order) throw fetchErr || new Error('Order not found');

    const { error: rpcErr } = await sb.rpc('assign_order_to_delivery', {
      p_order_id: orderId,
      p_delivery_profile_id: riderId,
    });

    if (rpcErr) {
      const isReassign = ['assigned', 'accepted', 'picked_up', 'dispatched', 'in_transit', 'out_for_delivery'].includes(order.status);
      const isFirstAssign = ['pending', 'approved', 'packed'].includes(order.status);

      if (!isReassign && !isFirstAssign) {
        throw rpcErr;
      }

      const validDeliveryStatuses = ['pending', 'dispatched', 'in_transit', 'arriving_soon', 'signal_lost', 'delivered', 'failed'];
      const safeDeliveryStatus = validDeliveryStatuses.includes(order.delivery_status)
        ? order.delivery_status
        : 'pending';

      const patch = {
        assigned_to: riderId,
        assigned_at: new Date().toISOString(),
      };

      if (isFirstAssign) {
        patch.status = 'assigned';
        patch.delivery_status = safeDeliveryStatus === 'delivered' || safeDeliveryStatus === 'failed'
          ? 'pending'
          : safeDeliveryStatus;
      }

      const { error } = await sb.from('orders').update(patch).eq('id', orderId);
      if (error) throw error;
    }

    const msg = order.assigned_to && order.assigned_to !== riderId
      ? 'Rider reassigned successfully.'
      : 'Rider assigned successfully! Order moved to Assigned.';
    showToast(msg, 'success');
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
  let productsDisplayLimit = 150;
  let productsTotalCount = 0;

  async function loadProducts(reset = true) {
    try {
      const container = document.getElementById('productsTableContainer');
      if (container) container.innerHTML = '<div class="text-center mt-3" style="color:var(--text-muted)">Loading products...</div>';
      if (reset) {
        allProducts = [];
        productsDisplayLimit = 150;
      }

      const batchSize = 200;
      let q;
      const trimmedSearch = (searchTerm || '').trim();

      if (trimmedSearch) {
        const { data, error } = await sb.rpc('search_products', {
          p_query: trimmedSearch,
          p_cursor: allProducts.length,
          p_page_size: batchSize,
          p_category: null,
          p_hide_out_of_stock: false,
        });
        if (error) throw error;
        const rows = data || [];
        productsTotalCount = allProducts.length + rows.length + (rows.length >= batchSize ? batchSize : 0);
        allProducts = allProducts.concat(rows);
      } else {
        q = sb.from('products').select('*', { count: 'exact' }).order('name').range(allProducts.length, allProducts.length + batchSize - 1);
        if (filterMode === 'active') q = q.eq('is_active', true);
        else if (filterMode === 'inactive') q = q.eq('is_active', false);
        else if (filterMode === 'low_stock') q = q.eq('is_active', true).lt('stock_quantity', 10);
        const { data, error, count } = await q;
        if (error) throw error;
        productsTotalCount = count != null ? count : (data || []).length;
        allProducts = allProducts.concat(data || []);
      }

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

    const container = document.getElementById('productsTableContainer');
    if (!container) return;

    if (filtered.length === 0) {
      container.innerHTML = '<div class="text-center mt-3" style="color:var(--text-muted);padding:40px">No products found</div>';
      return;
    }

    const visible = filtered.slice(0, productsDisplayLimit);
    const totalLabel = productsTotalCount ? productsTotalCount.toLocaleString('en-IN') : filtered.length.toLocaleString('en-IN');
    const canLoadMoreLocal = productsDisplayLimit < filtered.length;
    const canLoadMoreRemote = !searchTerm && allProducts.length < productsTotalCount;

    container.innerHTML = `
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;font-weight:600">
        Showing ${visible.length.toLocaleString('en-IN')} loaded · ${totalLabel} total in catalog
      </div>
      <div class="table-responsive">
        <table class="data-table"><thead><tr><th>Name</th><th>SKU</th><th>Category</th><th>MRP</th><th>Price</th><th>GST%</th><th>Stock</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${visible.map(p => {
          const isZeroPrice = (p.selling_price || 0) <= 0 || (p.mrp || 0) <= 0;
          const pid = escapeAttr(p.id);
          return `<tr>
          <td style="font-weight:600">
            ${escapeHtml(p.name)}
            ${isZeroPrice ? '<span style="display:inline-block;font-size:10px;color:var(--color-error);background:rgba(239,68,68,0.1);padding:2px 6px;border-radius:4px;margin-left:6px;font-weight:700">0 Price (Out of Stock)</span>' : ''}
          </td>
          <td style="font-size:12px;color:var(--text-muted)">${escapeHtml(p.sku || p.barcode_sku || '—')}</td>
          <td><span class="badge badge-info">${escapeHtml(p.category || '—')}</span></td>
          <td>${fmtCurrency(p.mrp)}</td>
          <td style="font-weight:600;color:${isZeroPrice ? 'var(--color-error)' : 'inherit'}">${fmtCurrency(p.selling_price)}</td>
          <td>${p.gst_percent || 0}%</td>
          <td style="font-weight:600;color:${(p.stock_quantity || 0) < 10 || isZeroPrice ? 'var(--color-error)' : 'var(--color-success)'}">
            ${p.stock_quantity || 0}
          </td>
          <td><span class="badge badge-${p.is_active && !isZeroPrice ? 'success' : 'danger'}">${p.is_active ? (isZeroPrice ? 'Out of Stock' : 'Active') : 'Inactive'}</span></td>
          <td><button class="btn btn-secondary" style="padding:6px 10px;font-size:12px" onclick="openProductForm('${pid}')">Edit</button></td>
        </tr>`;
        }).join('')}</tbody></table>
      </div>
      ${(canLoadMoreLocal || canLoadMoreRemote) ? `
        <div style="text-align:center;margin-top:16px">
          <button type="button" class="btn btn-secondary" id="productsLoadMoreBtn">${canLoadMoreLocal ? 'Show more loaded rows' : 'Fetch next batch from server'}</button>
        </div>` : ''}
    `;

    document.getElementById('productsLoadMoreBtn')?.addEventListener('click', async () => {
      if (productsDisplayLimit < filtered.length) {
        productsDisplayLimit = Math.min(productsDisplayLimit + 150, filtered.length);
        renderProductsTable();
      } else if (canLoadMoreRemote) {
        await loadProducts(false);
      }
    });
  }

  // Filter buttons
  document.querySelectorAll('#productStatusFilter .option-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#productStatusFilter .option-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      filterMode = btn.dataset.filter;
      productsDisplayLimit = 150;
      loadProducts(true);
    });
  });

  // Search
  document.getElementById('productSearch')?.addEventListener('input', debounce((e) => {
    searchTerm = e.target.value;
    productsDisplayLimit = 150;
    loadProducts(true);
  }, 300));

  // Add product
  document.getElementById('addProductBtn')?.addEventListener('click', () => openProductForm(null));

  // Store loadProducts for refresh
  window._refreshProducts = loadProducts;
  await loadProducts(true);
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
          <div class="form-group"><label class="form-label">Scheme — Buy qty</label><input type="number" min="0" class="form-input" id="pf_scheme_buy" value="${f.scheme_buy_qty ?? ''}" placeholder="e.g. 10 (optional)"></div>
          <div class="form-group"><label class="form-label">Scheme — Free qty</label><input type="number" min="0" class="form-input" id="pf_scheme_free" value="${f.scheme_free_qty ?? ''}" placeholder="e.g. 1 (optional)"></div>
          <div class="form-group form-group-full" style="font-size:12px;color:var(--text-muted);margin-top:-8px">If both are set, POS shows an optional free-qty field (not auto-applied). Example: buy 10, get 1 free.</div>
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
      const is_active = modal.querySelector('#pf_active').checked;
      const barcode_sku = modal.querySelector('#pf_barcode').value.trim() || null;
      const company = modal.querySelector('#pf_company').value.trim() || null;
      const category = modal.querySelector('#pf_category').value.trim() || null;
      const pack_size = modal.querySelector('#pf_unit').value.trim() || null;
      const stock_quantity = parseInt(modal.querySelector('#pf_stock').value) || 0;
      const schemeBuyRaw = modal.querySelector('#pf_scheme_buy').value.trim();
      const schemeFreeRaw = modal.querySelector('#pf_scheme_free').value.trim();
      let scheme_buy_qty = schemeBuyRaw === '' ? null : parseInt(schemeBuyRaw, 10);
      let scheme_free_qty = schemeFreeRaw === '' ? null : parseInt(schemeFreeRaw, 10);
      if (scheme_buy_qty != null && (isNaN(scheme_buy_qty) || scheme_buy_qty <= 0)) scheme_buy_qty = null;
      if (scheme_free_qty != null && (isNaN(scheme_free_qty) || scheme_free_qty <= 0)) scheme_free_qty = null;
      if ((scheme_buy_qty == null) !== (scheme_free_qty == null)) {
        showToast('Set both scheme buy and free qty, or leave both empty', 'warning');
        return;
      }

      let rpcSuccess = false;
      try {
        const payload = {
          p_name: name,
          p_company: company,
          p_category: category,
          p_selling_price: price,
          p_mrp: mrp,
          p_gst_percent: selectedGst,
          p_unit: pack_size,
          p_stock_quantity: stock_quantity,
          p_active: is_active,
        };
        if (!isNew) payload.p_id = productId;

        const { error: rpcErr } = await sb.rpc('upsert_product', payload);
        if (!rpcErr) rpcSuccess = true;
      } catch (rpcErr) {
        console.warn('upsert_product RPC error, falling back to direct table mutation:', rpcErr);
      }

      if (!rpcSuccess) {
        // Resilient fallback direct upsert/update
        if (isNew) {
          const { error: insErr } = await sb.from('products').insert({
            name,
            company,
            category,
            selling_price: price,
            mrp,
            gst_percent: selectedGst,
            pack_size,
            stock_quantity,
            is_active,
            barcode_sku,
            sku: barcode_sku,
            scheme_buy_qty,
            scheme_free_qty,
          });
          if (insErr) throw insErr;
        } else {
          const { error: upErr } = await sb.from('products').update({
            name,
            company,
            category,
            selling_price: price,
            mrp,
            gst_percent: selectedGst,
            pack_size,
            stock_quantity,
            is_active,
            barcode_sku,
            sku: barcode_sku,
            scheme_buy_qty,
            scheme_free_qty,
          }).eq('id', productId);
          if (upErr) throw upErr;
        }
      }

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
        fetchAllProducts('id, name, sku, barcode_sku, stock_quantity, is_active, selling_price, category', false),
        sb.rpc('get_low_stock_products'),
      ]);
      allProducts = all || [];
      lowStockProducts = lowStockRes.data || [];
      renderStockTab();
    } catch (err) { showToast('Failed to load stock data', 'error'); }
  }

  function matchStockSearch(p, search) {
    if (!search) return true;
    return (p.name || '').toLowerCase().includes(search) ||
           (p.sku || '').toLowerCase().includes(search) ||
           (p.barcode_sku || '').toLowerCase().includes(search) ||
           (p.category || '').toLowerCase().includes(search);
  }

  function renderStockTab() {
    const container = document.getElementById('stockContent');
    if (!container) return;
    const search = (document.getElementById('stockSearch')?.value || '').toLowerCase();

    if (stockTab === 'low') {
      let items = lowStockProducts;
      if (search) items = items.filter(p => matchStockSearch(p, search));
      container.innerHTML = items.length === 0 ? '<div class="text-center mt-3" style="color:var(--text-muted);padding:40px">✅ No low stock items</div>' : `
        <div class="table-responsive"><table class="data-table"><thead><tr><th>Product</th><th>Current Stock</th><th>Category</th><th>Action</th></tr></thead><tbody>
        ${items.map(p => `<tr><td style="font-weight:600">${p.name}</td><td style="color:var(--color-error);font-weight:700">${p.stock_quantity}</td><td>${p.category || '—'}</td><td><button class="btn btn-primary" style="padding:6px 12px;font-size:12px" onclick="openStockAdjust('${p.id}','${(p.name||'').replace(/'/g,"\\'")}',${p.stock_quantity})">Adjust</button></td></tr>`).join('')}
        </tbody></table></div>`;
    } else if (stockTab === 'all') {
      let items = allProducts;
      if (search) items = items.filter(p => matchStockSearch(p, search));
      container.innerHTML = `
        <div class="table-responsive"><table class="data-table"><thead><tr><th>Product</th><th>SKU</th><th>Stock</th><th>Action</th></tr></thead><tbody>
        ${items.map(p => `<tr><td style="font-weight:600">${p.name} ${!p.is_active ? '<span style="font-size:10px;color:var(--text-muted);background:rgba(255,255,255,0.1);padding:2px 4px;border-radius:4px">(Inactive)</span>' : ''}</td><td style="font-size:12px;color:var(--text-muted)">${p.sku || p.barcode_sku || '—'}</td><td style="font-weight:600;color:${(p.stock_quantity||0)<10?'var(--color-error)':'var(--color-success)'}">${p.stock_quantity || 0}</td><td><button class="btn btn-secondary" style="padding:6px 10px;font-size:12px" onclick="openStockAdjust('${p.id}','${(p.name||'').replace(/'/g,"\\'")}',${p.stock_quantity||0})">Adjust</button></td></tr>`).join('')}
        </tbody></table></div>`;
    } else if (stockTab === 'bulk') {
      let items = allProducts;
      if (search) items = items.filter(p => matchStockSearch(p, search));
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
      const container = document.getElementById('usersTableContainer');
      if (container) container.innerHTML = '<div class="text-center mt-3" style="color:var(--text-muted)">Loading registered users...</div>';
      allUsers = await fetchAllProfiles('*', null);
      renderUsersTable();
    } catch (err) {
      console.error('Failed to load users:', err);
      showToast('Failed to load users', 'error');
    }
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
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;font-weight:600">
        Showing ${filtered.length.toLocaleString('en-IN')} of ${allUsers.length.toLocaleString('en-IN')} total registered users
      </div>
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
  document.getElementById('userSearch')?.addEventListener('input', debounce(renderUsersTable, 200));
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
    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center">
      <input type="text" class="form-input" id="retailerSearch" placeholder="Search by name, phone, code, area..." style="margin:0;flex:1;min-width:200px">
      <span id="retailersResultMeta" style="font-size:12px;color:var(--text-muted);font-weight:600"></span>
    </div>
    <div id="retailersContent"><div class="text-center mt-3" style="color:var(--text-muted)">Loading retailers...</div></div>
    <div style="display:flex;justify-content:center;gap:8px;margin-top:12px">
      <button type="button" class="btn btn-secondary" id="retailersPrevBtn" disabled>← Prev</button>
      <button type="button" class="btn btn-secondary" id="retailersNextBtn">Next →</button>
    </div>
  `;

  const PAGE_SIZE = 50;
  let retailersPage = 0;
  let retailersTotal = 0;
  let retailersRows = [];

  async function fetchRetailersPage() {
    const container = document.getElementById('retailersContent');
    const search = (document.getElementById('retailerSearch')?.value || '').trim() || null;
    if (container) container.innerHTML = '<div class="text-center mt-3" style="color:var(--text-muted)">Loading retailers...</div>';

    try {
      const { data, error } = await sb.rpc('admin_list_retailers', {
        p_query: search,
        p_offset: retailersPage * PAGE_SIZE,
        p_limit: PAGE_SIZE,
      });
      if (error) throw error;
      retailersRows = data || [];
      retailersTotal = retailersRows[0]?.total_count != null ? Number(retailersRows[0].total_count) : retailersRows.length;
      renderRetailersTable();
    } catch (err) {
      console.error('Failed to load retailers:', err);
      if (container) container.innerHTML = `<div class="text-center mt-3" style="color:var(--color-error)">Failed to load retailers. Apply migration-admin-production-v86.sql if RPC is missing.</div>`;
    }
  }

  function renderRetailersTable() {
    const container = document.getElementById('retailersContent');
    const meta = document.getElementById('retailersResultMeta');
    const prevBtn = document.getElementById('retailersPrevBtn');
    const nextBtn = document.getElementById('retailersNextBtn');
    if (!container) return;

    const from = retailersTotal === 0 ? 0 : retailersPage * PAGE_SIZE + 1;
    const to = Math.min(retailersTotal, (retailersPage + 1) * PAGE_SIZE);
    if (meta) meta.textContent = retailersTotal ? `Showing ${from}–${to} of ${Number(retailersTotal).toLocaleString('en-IN')}` : '';

    if (prevBtn) prevBtn.disabled = retailersPage <= 0;
    if (nextBtn) nextBtn.disabled = (retailersPage + 1) * PAGE_SIZE >= retailersTotal;

    container.innerHTML = retailersRows.length === 0 ? '<div class="text-center mt-3" style="color:var(--text-muted);padding:40px">No retailers found</div>' : `
      <div class="table-responsive"><table class="data-table"><thead><tr><th>Business</th><th>Contact</th><th>Phone</th><th>Area</th><th>Credit Limit</th><th>Credit Used</th><th>Status</th><th>Actions</th></tr></thead><tbody>
      ${retailersRows.map(r => {
        const limit = r.credit_limit || 0;
        const used = r.credit_used || 0;
        const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
        const barColor = pct > 80 ? 'var(--color-error)' : pct > 50 ? 'var(--color-warning)' : 'var(--color-success)';
        const rid = escapeAttr(r.id);
        return `<tr>
          <td style="font-weight:600">${escapeHtml(r.business_name || '—')}</td>
          <td>${escapeHtml(r.name || '—')}</td>
          <td>${escapeHtml(r.phone || '—')}</td>
          <td>${escapeHtml(r.area || r.city || '—')}</td>
          <td>
            <div style="font-size:12px;font-weight:600">${fmtCurrency(limit)}</div>
            <div class="progress-track" style="width:80px"><div class="progress-fill" style="width:${pct}%;background:${barColor}"></div></div>
          </td>
          <td style="font-weight:600;color:${used > 0 ? 'var(--color-warning)' : 'var(--text-muted)'}">${fmtCurrency(used)}</td>
          <td><span class="badge badge-${r.approved ? 'success' : 'warning'}">${r.approved ? 'Active' : 'Suspended'}</span></td>
          <td><button class="btn btn-secondary" style="padding:6px 10px;font-size:12px" onclick="openRetailerDetail('${rid}')">View</button></td>
        </tr>`;
      }).join('')}</tbody></table></div>`;
  }

  document.getElementById('retailerSearch')?.addEventListener('input', debounce(() => {
    retailersPage = 0;
    fetchRetailersPage();
  }, 300));
  document.getElementById('retailersPrevBtn')?.addEventListener('click', () => {
    if (retailersPage > 0) { retailersPage -= 1; fetchRetailersPage(); }
  });
  document.getElementById('retailersNextBtn')?.addEventListener('click', () => {
    if ((retailersPage + 1) * PAGE_SIZE < retailersTotal) { retailersPage += 1; fetchRetailersPage(); }
  });

  window._refreshRetailers = () => fetchRetailersPage();
  await fetchRetailersPage();
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
// DELIVERY TRACKING & FLEET COMMAND CENTER
// ============================================================
// DELIVERY FLEET & LIVE TRACKING DASHBOARD (#delivery)
// ============================================================

let _deliveryRoutes = {};
let _deliveryRouteCache = {};

// In-place marker maps — keyed by order_id for flicker-free updates
const riderMarkersMap = {};
const shopMarkersMap = {};
const routePolylinesMap = {};
let _fleetRealtimeChannel = null;
let _ordersRealtimeChannel = null;

/** Approved → in-flight delivery (excludes pending, delivered, cancelled). Shared with Address Correction. */
const IN_FLIGHT_DELIVERY_ORDER_STATUSES = Object.freeze([
  'approved',
  'packed',
  'assigned',
  'accepted',
  'picked_up',
  'dispatched',
]);

/** Delivery Tracking map/list — includes pending queue + in-flight (excludes pickup & terminal). */
const DELIVERY_TRACKING_ORDER_STATUSES = Object.freeze([
  'pending',
  'pending_payment',
  ...IN_FLIGHT_DELIVERY_ORDER_STATUSES,
]);

const DELIVERY_MAP_WAREHOUSE_LAT = 21.150167;
const DELIVERY_MAP_WAREHOUSE_LNG = 79.099140;

function deliveryMapHaversineMeters(lat1, lon1, lat2, lon2) {
  if (!Number.isFinite(lat1) || !Number.isFinite(lon1) || !Number.isFinite(lat2) || !Number.isFinite(lon2)) return Infinity;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isDeliveryMapWarehousePin(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return true;
  return deliveryMapHaversineMeters(lat, lng, DELIVERY_MAP_WAREHOUSE_LAT, DELIVERY_MAP_WAREHOUSE_LNG) <= 220;
}

function shopLocationAdminVerified(loc) {
  return Boolean(loc?.is_verified && loc?.verified_by);
}

function coordsFromOrderDeliverySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const lat = Number(snapshot.lat ?? snapshot.latitude);
  const lng = Number(snapshot.lng ?? snapshot.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
  const address = snapshot.full_address || snapshot.formatted_address || snapshot.address || '';
  return { lat, lng, address };
}

function isInFlightDeliveryOrder(order) {
  if (!order) return false;
  if (order.delivered_at) return false;
  const status = (order.status || '').toLowerCase();
  if (!IN_FLIGHT_DELIVERY_ORDER_STATUSES.includes(status)) return false;
  if (['cancelled', 'rejected', 'delivery_failed', 'payment_failed'].includes(status)) return false;
  const ds = (order.delivery_status || '').toLowerCase();
  if (['delivered', 'failed', 'cancelled', 'rejected', 'delivery_failed'].includes(ds)) return false;
  return orderIsDeliveryFulfillment(order);
}

function orderIsDeliveryFulfillment(order) {
  const fm = String(order?.fulfillment_mode || order?.delivery_type || 'delivery').toLowerCase();
  return !['pickup', 'self_pickup', 'counter_pickup'].includes(fm);
}

/** Matches get_public_order_tracking v_is_active (track.html). */
function isOrderActiveLikePublicTracking(order) {
  if (!order) return false;
  if (order.delivered_at) return false;
  const ds = String(order.delivery_status || order.status || '').toLowerCase();
  if (['delivered', 'cancelled', 'failed', 'delivery_failed', 'returned'].includes(ds)) return false;
  if (!orderIsDeliveryFulfillment(order)) return false;
  const st = String(order.status || '').toLowerCase();
  if (['cancelled', 'rejected', 'delivery_failed', 'payment_failed'].includes(st)) return false;
  return true;
}

function isAddressPortalActiveOrder(order) {
  if (!isOrderActiveLikePublicTracking(order)) return false;
  const status = String(order.status || '').toLowerCase();
  return IN_FLIGHT_DELIVERY_ORDER_STATUSES.includes(status);
}

function isBundleOrderDelivered(bundleOrder) {
  if (!bundleOrder) return false;
  return bundleOrder.delivery_status === 'delivered' || bundleOrder.status === 'delivered';
}

async function fetchOrderTrackingBundle(orderId) {
  if (!orderId) return null;
  try {
    const { data, error } = await sb.rpc('get_order_tracking_bundle', { p_order_id: orderId });
    if (error || !data || data.error) return null;
    return data;
  } catch (e) {
    console.warn('get_order_tracking_bundle failed for', orderId, e);
    return null;
  }
}

async function fetchTrackingBundlesForOrders(orders, concurrency = 10) {
  const bundleMap = new Map();
  const ids = (orders || []).map((o) => o.id).filter(Boolean);
  for (let i = 0; i < ids.length; i += concurrency) {
    const chunk = ids.slice(i, i + concurrency);
    const pairs = await Promise.all(
      chunk.map((id) => fetchOrderTrackingBundle(id).then((bundle) => [id, bundle])),
    );
    pairs.forEach(([id, bundle]) => {
      if (bundle) bundleMap.set(id, bundle);
    });
  }
  return bundleMap;
}

/** Shop + rider coords from get_order_tracking_bundle (same fields as track.html). */
function resolvedDestFromTrackingBundle(bundle, orderRow, shopLocations) {
  const order = bundle?.order;
  if (order?.destination_lat != null && order?.destination_lng != null) {
    const lat = Number(order.destination_lat);
    const lng = Number(order.destination_lng);
    if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
      return {
        lat: isDeliveryMapWarehousePin(lat, lng) ? null : lat,
        lng: isDeliveryMapWarehousePin(lat, lng) ? null : lng,
        shopName: order.user_name || orderRow?.user_name || 'Retailer Shop',
        address: order.delivery_address || orderRow?.delivery_address || '',
        isVerified: Boolean(order.is_destination_verified),
        source: 'tracking_bundle',
      };
    }
  }
  const fallback = resolveOrderDestination(orderRow, shopLocations);
  return { ...fallback, source: 'client_resolve' };
}

function trackingRowFromTrackingBundle(bundle) {
  const t = bundle?.tracking;
  if (!t) return {};
  return {
    ...t,
    lat: t.lat,
    lng: t.lng,
    current_lat: t.lat,
    current_lng: t.lng,
    rider_name: bundle?.rider?.name,
    battery_pct: t.battery_level,
    battery_level: t.battery_level,
  };
}

function isActiveDeliveryTrackingOrder(order) {
  if (!order) return false;
  if (order.delivered_at) return false;
  const status = (order.status || '').toLowerCase();
  if (!DELIVERY_TRACKING_ORDER_STATUSES.includes(status)) return false;
  if (['cancelled', 'rejected', 'delivery_failed', 'payment_failed'].includes(status)) return false;
  const ds = (order.delivery_status || '').toLowerCase();
  if (['delivered', 'failed', 'cancelled', 'rejected', 'delivery_failed'].includes(ds)) return false;
  return orderIsDeliveryFulfillment(order);
}

async function fetchActiveDeliveryOrdersForTracking() {
  const statusFilter = DELIVERY_TRACKING_ORDER_STATUSES;

  const selectWithJoins = `
        id, order_number, status, delivery_status, delivered_at, grand_total, fulfillment_mode, delivery_type,
        delivery_address, delivery_address_id, delivery_snapshot, user_id, user_name,
        destination_lat, destination_lng, created_at, dispatched_at, assigned_to,
        user:profiles!orders_user_id_fkey(name, business_name, phone, area, city, address),
        rider:profiles!orders_rider_id_fkey(id, name, phone)
      `;

  const selectCore = `
        id, order_number, status, delivery_status, grand_total, fulfillment_mode, delivery_type,
        delivery_address, delivery_address_id, delivery_snapshot, user_id, user_name,
        created_at, dispatched_at, assigned_to
      `;

  let res = await sb
    .from('orders')
    .select(selectWithJoins)
    .in('status', statusFilter)
    .order('created_at', { ascending: true });

  if (res.error) {
    console.warn('Delivery tracking orders query (full) failed, retrying core select:', res.error.message);
    res = await sb
      .from('orders')
      .select(selectCore)
      .in('status', statusFilter)
      .order('created_at', { ascending: true });
  }

  if (res.error) {
    console.warn('Delivery tracking orders query (core) failed, retrying minimal:', res.error.message);
    res = await sb
      .from('orders')
      .select('id, order_number, status, delivery_status, grand_total, fulfillment_mode, delivery_type, delivery_address, delivery_address_id, user_id, user_name, created_at, assigned_to')
      .in('status', statusFilter)
      .order('created_at', { ascending: true });
  }

  return res;
}

async function renderDelivery() {
  pageContent.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 400px;gap:18px;min-height:calc(100vh - 140px);align-items:start" class="delivery-tracker-grid">
      <!-- Left Map Canvas -->
      <div style="background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:var(--radius-lg);overflow:hidden;position:relative;height:740px;display:flex;flex-direction:column">
        <div style="padding:12px 16px;background:rgba(255,255,255,0.03);border-bottom:1px solid var(--border-subtle);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
          <div style="display:flex;align-items:center;gap:10px">
            <span style="font-size:16px">🚚</span>
            <span style="font-weight:700;font-size:14px">Live Fleet & Active Delivery Route Map</span>
            <span class="badge badge-success" style="font-size:11px">● LIVE GPS</span>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn btn-secondary" style="padding:4px 10px;font-size:12px" onclick="fitAllDeliveriesOnMap()">🗺️ Fit All Deliveries</button>
            <button class="btn btn-secondary" style="padding:4px 10px;font-size:12px" onclick="resetDeliveryMapView()">📍 Center Warehouse</button>
            <button class="btn btn-secondary" style="padding:4px 10px;font-size:12px" onclick="loadDeliveryData()">🔄 Refresh</button>
          </div>
        </div>

        <!-- Map container -->
        <div id="leafletMap" style="flex:1;width:100%;min-height:540px;background:#0F172A"></div>

        <!-- Map Bottom Route Legend -->
        <div style="padding:8px 14px;background:var(--bg-surface);border-top:1px solid var(--border-subtle);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;font-size:11px;color:var(--text-muted)">
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
            <span style="display:inline-flex;align-items:center;gap:4px"><span style="width:10px;height:10px;border-radius:50%;background:#3B82F6;display:inline-block"></span> Dispatched</span>
            <span style="display:inline-flex;align-items:center;gap:4px"><span style="width:10px;height:10px;border-radius:50%;background:#1565C0;display:inline-block;box-shadow:0 0 4px #1565C0"></span> In Transit</span>
            <span style="display:inline-flex;align-items:center;gap:4px"><span style="width:10px;height:10px;border-radius:50%;background:#10B981;display:inline-block;box-shadow:0 0 4px #10B981"></span> Arriving Soon</span>
            <span style="display:inline-flex;align-items:center;gap:4px"><span style="width:10px;height:10px;border-radius:50%;background:#F59E0B;display:inline-block"></span> Signal Lost</span>
            <span style="display:inline-flex;align-items:center;gap:4px"><span style="width:10px;height:10px;border-radius:50%;background:#9CA3AF;display:inline-block"></span> Delivered</span>
            <span style="display:inline-flex;align-items:center;gap:4px"><span style="width:10px;height:10px;border-radius:50%;background:#EF4444;display:inline-block"></span> Failed</span>
            <span style="display:inline-flex;align-items:center;gap:4px"><span style="width:16px;height:3px;background:#2563EB;border-radius:2px;display:inline-block"></span> Road Route</span>
            <span style="display:inline-flex;align-items:center;gap:4px"><span style="color:#10B981;font-weight:700">✓</span> Verified Pin</span>
          </div>
        </div>
      </div>

      <!-- Right Control Sidebar -->
      <div style="display:flex;flex-direction:column;gap:16px">
        <!-- Live Deliveries Card -->
        <div class="section-card" style="margin-bottom:0;padding:16px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
            <h4 style="font-size:14px;font-weight:700">📦 Active Deliveries (<span id="activeDeliveryCount">0</span>)</h4>
            <span style="font-size:11px;color:var(--text-muted)">Ranked by dispatch priority</span>
          </div>
          <div id="activeDeliveryList" style="display:flex;flex-direction:column;gap:10px;max-height:360px;overflow-y:auto;padding-right:4px">
            <div style="color:var(--text-muted);font-size:12px;text-align:center;padding:20px">Loading active deliveries...</div>
          </div>
        </div>

        <!-- Registered Riders Fleet -->
        <div class="section-card" style="margin-bottom:0;padding:16px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
            <h4 style="font-size:14px;font-weight:700">🏍️ Active Fleet (<span id="activeRiderCount">0</span>)</h4>
          </div>
          <div id="activeFleetList" style="display:flex;flex-direction:column;gap:8px;max-height:200px;overflow-y:auto;padding-right:4px">
            <div style="color:var(--text-muted);font-size:12px;text-align:center;padding:20px">Loading fleet...</div>
          </div>
        </div>

        <!-- Recent Delivery Proofs -->
        <div class="section-card" style="margin-bottom:0;padding:16px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
            <h4 style="font-size:14px;font-weight:700">📸 Verified Proofs of Delivery</h4>
          </div>
          <div id="deliveryProofsList" style="display:flex;gap:8px;overflow-x:auto;padding-bottom:4px">
            <div style="color:var(--text-muted);font-size:12px">Loading proofs...</div>
          </div>
        </div>

        <!-- Delivery Subsystem Integrity & Health Monitoring -->
        <div class="section-card" style="margin-bottom:0;padding:16px;border:1px solid rgba(59,130,246,0.2);background:linear-gradient(180deg, rgba(30,58,138,0.06) 0%, rgba(15,23,42,0.4) 100%)">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
            <h4 style="font-size:14px;font-weight:700;display:flex;align-items:center;gap:6px">
              🛡️ System Integrity & Health
            </h4>
            <div style="display:flex;gap:4px">
              <button class="btn btn-secondary" id="canaryScopeBtn" style="padding:2px 8px;font-size:11px" onclick="toggleCanaryScopeFilter()">🧪 Canary View</button>
              <button class="btn btn-secondary" style="padding:2px 8px;font-size:11px" onclick="runDeliveryHealthAudit(true)">🔍 Run Audit</button>
              <button class="btn btn-secondary" style="padding:2px 8px;font-size:11px" onclick="runSubsystemMaintenance()">🧹 Maintenance</button>
            </div>
          </div>
          <div id="healthScopeLabel" style="font-size:11px;color:#3B82F6;margin-bottom:8px;font-weight:600">● Viewing Fleet-Wide Metrics</div>

          <div id="deliveryHealthMetrics" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;font-size:11px">
            <div style="background:var(--bg-surface);padding:8px 10px;border-radius:8px;border:1px solid var(--border-subtle)">
              <div style="color:var(--text-muted)">Snapshot Integrity</div>
              <div id="healthSnapshotStatus" style="font-weight:700;font-size:12px;color:#10B981;margin-top:2px">● 0 Mismatches</div>
            </div>
            <div style="background:var(--bg-surface);padding:8px 10px;border-radius:8px;border:1px solid var(--border-subtle)">
              <div style="color:var(--text-muted)">Rider Reconnects (24h)</div>
              <div id="healthReconnectsCount" style="font-weight:700;font-size:12px;color:#3B82F6;margin-top:2px">0 events</div>
            </div>
            <div style="background:var(--bg-surface);padding:8px 10px;border-radius:8px;border:1px solid var(--border-subtle)">
              <div style="color:var(--text-muted)">Off-Route Triggers (24h)</div>
              <div id="healthOffRouteCount" style="font-weight:700;font-size:12px;color:#F59E0B;margin-top:2px">0 triggers</div>
            </div>
            <div style="background:var(--bg-surface);padding:8px 10px;border-radius:8px;border:1px solid var(--border-subtle)">
              <div style="color:var(--text-muted)">Pin Shifts (24h)</div>
              <div id="healthShiftsCount" style="font-weight:700;font-size:12px;color:#8B5CF6;margin-top:2px">0 shifts</div>
            </div>
            <div style="background:var(--bg-surface);padding:8px 10px;border-radius:8px;border:1px solid var(--border-subtle)">
              <div style="color:var(--text-muted)">Auto Breakers (24h)</div>
              <div id="healthBreakersCount" style="font-weight:700;font-size:12px;color:#EF4444;margin-top:2px">0 tripped</div>
            </div>
            <div style="background:var(--bg-surface);padding:8px 10px;border-radius:8px;border:1px solid var(--border-subtle)">
              <div style="color:var(--text-muted)">Rider Reports (24h)</div>
              <div id="healthRiderIssuesCount" style="font-weight:700;font-size:12px;color:#D97706;margin-top:2px">0 reported</div>
            </div>
          </div>
          <div id="healthLastAuditTime" style="font-size:10px;color:var(--text-muted);margin-top:8px;text-align:right">Last Audit: Checking...</div>
        </div>

        <!-- Canary Rollout Management & Rollback Panel -->
        <div class="section-card" style="margin-bottom:0;padding:16px;border:1px solid rgba(16,185,129,0.2)">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
            <h4 style="font-size:14px;font-weight:700;display:flex;align-items:center;gap:6px">
              🧪 Canary Rollout (Rider Allowlist)
            </h4>
            <span class="badge badge-success" id="canaryActiveCountBadge" style="font-size:10px">0 Active</span>
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:10px;line-height:16px">
            Enables AppState reconnect, 30s off-route debounce, and destination change modal for selected riders only.
          </div>
          <div id="canaryRidersList" style="display:flex;flex-direction:column;gap:6px;max-height:160px;overflow-y:auto;padding-right:2px">
            <div style="color:var(--text-muted);font-size:11px;text-align:center;padding:10px">Loading riders...</div>
          </div>

          <!-- Rollback Thresholds Reference Box -->
          <div style="margin-top:12px;background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.2);border-radius:8px;padding:8px 10px;font-size:10px;color:var(--text-secondary)">
            <div style="font-weight:800;color:#EF4444;margin-bottom:4px">⚠️ 48-Hour Rollback Thresholds:</div>
            • <strong>Reconnects:</strong> &gt; 2 reconnects/rider/shift &rarr; Toggle rider OFF<br>
            • <strong>Off-Route:</strong> &gt; 1 recalc/min sustained &rarr; Toggle rider OFF<br>
            • <strong>UX:</strong> Any rider reported map disorientation &rarr; Toggle rider OFF
          </div>
        </div>
      </div>
    </div>
  `;

  // Init Leaflet map
  setTimeout(() => {
    if (typeof L === 'undefined') {
      const mapEl = document.getElementById('leafletMap');
      if (mapEl) mapEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted)">Leaflet library not loaded</div>';
      return;
    }

    if (_deliveryMap) {
      try { _deliveryMap.remove(); } catch(e) {}
      _deliveryMap = null;
    }
    window._deliveryMarkers = [];
    _deliveryRoutes = {};

    _deliveryMap = L.map('leafletMap', {
      zoomControl: true,
      attributionControl: false
    }).setView([DELIVERY_MAP_WAREHOUSE_LAT, DELIVERY_MAP_WAREHOUSE_LNG], 13);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, &copy; <a href="https://carto.com/">CARTO</a>',
      maxZoom: 19,
    }).on('tileerror', function(e) {
      // Tile error retry with exponential backoff
      const tile = e.tile;
      const retryCount = parseInt(tile.dataset.retryCount || '0');
      if (retryCount < 3) {
        tile.dataset.retryCount = retryCount + 1;
        const delay = 2000 * Math.pow(2, retryCount);
        setTimeout(() => { tile.src = tile.src; }, delay);
      }
    }).addTo(_deliveryMap);

    // Warehouse Pin: Thakkar Medico Warehouse
    L.marker([DELIVERY_MAP_WAREHOUSE_LAT, DELIVERY_MAP_WAREHOUSE_LNG], {
      icon: L.divIcon({
        className: '',
        html: '<div style="background:#6C63FF;color:#fff;width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:0 4px 14px rgba(108,99,255,0.6);border:2.5px solid #fff">🏪</div>',
        iconSize: [36, 36],
        iconAnchor: [18, 18]
      })
    }).addTo(_deliveryMap).bindPopup('<strong>🏪 Thakkar Medico Central Warehouse</strong><br>Sandesh Dawa Bazar, Ganjipeth, Nagpur');

    setTimeout(() => {
      if (_deliveryMap) _deliveryMap.invalidateSize();
    }, 200);

    loadDeliveryData();
  }, 100);
}

window.resetDeliveryMapView = function() {
  if (_deliveryMap) _deliveryMap.flyTo([DELIVERY_MAP_WAREHOUSE_LAT, DELIVERY_MAP_WAREHOUSE_LNG], 13);
};

/** Resolve retailer drop pin (mirrors orderDeliveryCoords.ts priority for active orders). */
function resolveOrderDestination(order, shopLocations) {
  let shopName = order.user?.business_name || order.user?.name || order.user_name || 'Retailer Shop';
  let address = order.delivery_address || '';
  let isVerified = false;
  let heldUnverifiedLat = null;
  let heldUnverifiedLng = null;

  const locs = Array.isArray(shopLocations) ? shopLocations : [];
  const formatLocAddress = (loc) =>
    loc.formatted_address || [loc.street, loc.area, loc.city, loc.pincode].filter(Boolean).join(', ') || address;

  const tryCoords = (loc, verifiedFlag) => {
    const vLat = Number(loc.lat);
    const vLng = Number(loc.lng);
    if (!Number.isFinite(vLat) || !Number.isFinite(vLng) || (vLat === 0 && vLng === 0)) return null;
    if (isDeliveryMapWarehousePin(vLat, vLng)) return null;
    return {
      lat: vLat,
      lng: vLng,
      shopName: loc.shop_name || shopName,
      address: formatLocAddress(loc),
      isVerified: verifiedFlag,
    };
  };

  // 1. Order's delivery_address_id → verified shop pin is authoritative
  if (order.delivery_address_id) {
    const match = locs.find((l) => l.id === order.delivery_address_id);
    if (match) {
      shopName = match.shop_name || shopName;
      address = formatLocAddress(match);
      isVerified = shopLocationAdminVerified(match);
      if (isVerified) {
        const resolved = tryCoords(match, true);
        if (resolved) return resolved;
      } else {
        const resolved = tryCoords(match, false);
        if (resolved) {
          heldUnverifiedLat = resolved.lat;
          heldUnverifiedLng = resolved.lng;
        }
      }
    }
  }

  // 2. Retailer's admin-verified shop (default first)
  if (order.user_id) {
    const verifiedUserLocs = locs
      .filter((l) => l.retailer_account_id === order.user_id && shopLocationAdminVerified(l))
      .sort((a, b) => (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0));
    for (const loc of verifiedUserLocs) {
      const resolved = tryCoords(loc, true);
      if (resolved) return resolved;
    }
  }

  // 3. delivery_snapshot coordinates (in-flight fallback)
  const snap = coordsFromOrderDeliverySnapshot(order.delivery_snapshot);
  if (snap && !isDeliveryMapWarehousePin(snap.lat, snap.lng)) {
    return { lat: snap.lat, lng: snap.lng, shopName, address: snap.address || address, isVerified: false };
  }

  // 4. Unverified pin from delivery_address_id
  if (heldUnverifiedLat != null && heldUnverifiedLng != null) {
    return { lat: heldUnverifiedLat, lng: heldUnverifiedLng, shopName, address, isVerified: false };
  }

  // 5. Any shop row for retailer (default first)
  if (order.user_id) {
    const userLocs = locs
      .filter((l) => l.retailer_account_id === order.user_id)
      .sort(
        (a, b) =>
          (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0) ||
          (shopLocationAdminVerified(b) ? 1 : 0) - (shopLocationAdminVerified(a) ? 1 : 0),
      );
    for (const loc of userLocs) {
      const resolved = tryCoords(loc, shopLocationAdminVerified(loc));
      if (resolved) return resolved;
    }
  }

  // 6. Persisted order destination fields
  if (order.destination_lat != null && order.destination_lng != null) {
    const vLat = Number(order.destination_lat);
    const vLng = Number(order.destination_lng);
    if (Number.isFinite(vLat) && Number.isFinite(vLng) && !isDeliveryMapWarehousePin(vLat, vLng)) {
      return { lat: vLat, lng: vLng, shopName, address, isVerified: false };
    }
  }

  return { lat: null, lng: null, shopName, address, isVerified: false };
}

// Helper: Fetch driving road route geometry via OSRM
async function fetchDeliveryRoute(startLat, startLng, destLat, destLng) {
  const key = `${startLat.toFixed(4)},${startLng.toFixed(4)}_${destLat.toFixed(4)},${destLng.toFixed(4)}`;
  if (_deliveryRouteCache[key]) return _deliveryRouteCache[key];

  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${startLng},${startLat};${destLng},${destLat}?overview=full&geometries=geojson`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('OSRM error');
    const data = await res.json();
    if (data.code === 'Ok' && data.routes && data.routes.length > 0) {
      const route = data.routes[0];
      const coords = (route.geometry?.coordinates || []).map(([lng, lat]) => [lat, lng]);
      const result = {
        coords,
        distanceMeters: Math.round(route.distance || 0),
        durationSeconds: Math.round(route.duration || 0)
      };
      _deliveryRouteCache[key] = result;
      return result;
    }
  } catch (err) {
    console.warn('Route fetch fallback to straight line:', err);
  }

  // Fallback straight line
  return {
    coords: [[startLat, startLng], [destLat, destLng]],
    distanceMeters: 3000,
    durationSeconds: 600
  };
}

async function loadDeliveryData() {
  try {
    const activeOrdersRes = await fetchActiveDeliveryOrdersForTracking();
    if (activeOrdersRes.error) {
      showToast(`Failed to load deliveries: ${activeOrdersRes.error.message}`, 'error');
      console.error('Delivery tracking orders error:', activeOrdersRes.error);
    }

    const activeOrdersRaw = (activeOrdersRes.data || []).filter(isActiveDeliveryTrackingOrder);

    const userIds = [...new Set(activeOrdersRaw.map(o => o.user_id).filter(Boolean))];
    const addrIds = [...new Set(activeOrdersRaw.map(o => o.delivery_address_id).filter(Boolean))];

    const shopLocQueries = [];
    if (addrIds.length > 0) {
      shopLocQueries.push(
        sb.from('retailer_shop_locations').select('id, retailer_account_id, shop_name, formatted_address, street, area, city, pincode, lat, lng, is_verified, verified_by, is_default').in('id', addrIds)
      );
    }
    if (userIds.length > 0) {
      shopLocQueries.push(
        sb.from('retailer_shop_locations').select('id, retailer_account_id, shop_name, formatted_address, street, area, city, pincode, lat, lng, is_verified, verified_by, is_default').in('retailer_account_id', userIds)
      );
    }

    const activeOrderIds = new Set(activeOrdersRaw.map((o) => o.id));

    const [trackingRes, proofsRes, ridersRes, trackingBundles, ...shopLocResults] = await Promise.all([
      sb.from('delivery_tracking').select('*').order('updated_at', { ascending: false }).limit(200),
      sb.from('delivery_proofs').select('*').order('created_at', { ascending: false }).limit(8),
      sb.from('profiles').select('id, name, phone, is_on_duty, current_order_count').or('role.eq.delivery,role.eq.driver'),
      fetchTrackingBundlesForOrders(activeOrdersRaw),
      ...shopLocQueries,
    ]);

    const shopLocationMap = new Map();
    shopLocResults.forEach(res => {
      (res.data || []).forEach(loc => shopLocationMap.set(loc.id, loc));
    });
    const shopLocations = [...shopLocationMap.values()];

    const trackings = trackingRes.data || [];
    const proofs = proofsRes.data || [];
    const riders = ridersRes.data || [];

    const activeOrders = activeOrdersRaw.filter((o) => {
      const bundle = trackingBundles.get(o.id);
      if (bundle?.order && isBundleOrderDelivered(bundle.order)) return false;
      if (bundle?.order) return isOrderActiveLikePublicTracking({ ...o, ...bundle.order, delivery_status: bundle.order.delivery_status, status: bundle.order.status, delivered_at: bundle.order.delivered_at });
      return isOrderActiveLikePublicTracking(o);
    });

    const activeRiderIds = new Set(activeOrders.map((o) => o.assigned_to).filter(Boolean));

    // Sort: in-transit/dispatched first, then rider-assigned, then warehouse prep
    activeOrders.sort((a, b) => {
      const rank = (o) => {
        const ds = (o.delivery_status || '').toLowerCase();
        const st = (o.status || '').toLowerCase();
        if (['in_transit', 'dispatched', 'arriving_soon', 'out_for_delivery'].includes(ds) || st === 'dispatched') return 1;
        if (['picked_up', 'assigned', 'accepted'].includes(st) || ds === 'pending') return 2;
        if (st === 'packed' || st === 'approved') return 3;
        return 4;
      };
      return rank(a) - rank(b) || new Date(a.created_at) - new Date(b.created_at);
    });

    // 1. Track which order_ids are still active — stale markers removed below
    const activeOrderIdSet = new Set(enrichedOrders.map(o => o.id));
    if (_deliveryMap) {
      // Remove markers for orders no longer active (greyed out for 30min then auto-remove)
      for (const orderId of Object.keys(riderMarkersMap)) {
        if (!activeOrderIdSet.has(orderId)) {
          // Grey out delivered/failed markers, auto-remove after 30min
          const m = riderMarkersMap[orderId];
          if (m && m._greyedAt) {
            if (Date.now() - m._greyedAt > 30 * 60 * 1000) {
              try { _deliveryMap.removeLayer(m); } catch(e) {}
              delete riderMarkersMap[orderId];
            }
          } else if (m) {
            m._greyedAt = Date.now();
            // Grey out but keep on map
            try {
              m.setOpacity(0.4);
            } catch(e) {}
          }
        }
      }
      for (const orderId of Object.keys(shopMarkersMap)) {
        if (!activeOrderIdSet.has(orderId)) {
          const m = shopMarkersMap[orderId];
          if (m && m._greyedAt) {
            if (Date.now() - m._greyedAt > 30 * 60 * 1000) {
              try { _deliveryMap.removeLayer(m); } catch(e) {}
              delete shopMarkersMap[orderId];
            }
          } else if (m) {
            m._greyedAt = Date.now();
            try { m.setOpacity(0.4); } catch(e) {}
          }
        }
      }
      _deliveryRoutes = {};
    }

    const allMapPoints = [[DELIVERY_MAP_WAREHOUSE_LAT, DELIVERY_MAP_WAREHOUSE_LNG]];

    // 2. Process each active delivery with Priority & Store Pin
    const enrichedOrders = [];

    for (let i = 0; i < activeOrders.length; i++) {
      const o = activeOrders[i];
      const priorityNum = i + 1;
      const priorityColor = priorityNum === 1 ? '#EF4444' : (priorityNum === 2 ? '#F59E0B' : '#3B82F6');
      const priorityLabel = priorityNum === 1 ? 'Priority 1 (Urgent)' : (priorityNum === 2 ? 'Priority 2 (High)' : `Priority ${priorityNum}`);

      const bundle = trackingBundles.get(o.id);
      const dest = resolvedDestFromTrackingBundle(bundle, o, shopLocations);
      const trackingRow = bundle
        ? trackingRowFromTrackingBundle(bundle)
        : trackings.find((tr) => tr.order_id === o.id) ||
          trackings.find(
            (tr) =>
              tr.rider_id &&
              tr.rider_id === o.assigned_to &&
              (!tr.order_id || activeOrderIds.has(tr.order_id)),
          ) ||
          {};
      const riderName = bundle?.rider?.name || o.rider?.name || trackingRow.rider_name || 'Unassigned';

      enrichedOrders.push({
        ...o,
        priorityNum,
        priorityColor,
        priorityLabel,
        resolvedDest: dest,
        tracking: trackingRow,
        riderName,
        trackingBundle: bundle,
      });
    }

    // 3. Render Active Deliveries Sidebar
    const deliveryListEl = document.getElementById('activeDeliveryList');
    const deliveryCountEl = document.getElementById('activeDeliveryCount');
    if (deliveryCountEl) deliveryCountEl.textContent = activeOrders.length;

    if (deliveryListEl) {
      if (enrichedOrders.length === 0) {
        deliveryListEl.innerHTML = '<div style="color:var(--text-muted);font-size:12px;text-align:center;padding:20px">No active deliveries right now</div>';
      } else {
        deliveryListEl.innerHTML = enrichedOrders.map(o => {
          const t = o.tracking;
          const customerName = o.resolvedDest.shopName || o.user?.business_name || o.user?.name || 'Customer';
          const isVer = o.resolvedDest.isVerified;
          const etaText = t.eta_minutes ? `⏱️ ~${Math.round(t.eta_minutes)} min` : (o.status === 'dispatched' ? '⏱️ In Transit' : '⏱️ Preparing');
          const distText = t.distance_remaining_km ? `📍 ${t.distance_remaining_km.toFixed(1)} km` : '';
          const batteryText = t.battery_level != null ? `🔋 ${Math.round(t.battery_level)}%` : (t.battery_pct != null ? `🔋 ${Math.round(t.battery_pct)}%` : '');
          const shareUrl = `${window.location.origin}/track.html?id=${o.id}`;

          return `
            <div class="delivery-order-card" id="deliveryCard_${o.id}" style="background:var(--bg-surface);border:1px solid var(--border-subtle);border-left:4px solid ${o.priorityColor};border-radius:8px;padding:12px;transition:all var(--transition-fast)" onmouseenter="highlightDeliveryRoute('${o.id}')" onmouseleave="unhighlightDeliveryRoute('${o.id}')">
              <!-- Top Row: Priority Badge & Order Number -->
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
                <div style="display:flex;align-items:center;gap:6px">
                  <span class="badge" style="background:${o.priorityColor};color:#fff;font-weight:800;font-size:11px;padding:2px 8px;border-radius:12px">P${o.priorityNum}</span>
                  <span style="font-weight:800;font-size:13px">#${o.order_number || o.id.slice(0,8)}</span>
                </div>
                <span class="badge badge-${getStatusBadgeClass(o.status)}" style="font-size:10px;text-transform:uppercase">${o.status}</span>
              </div>

              <!-- Shop Name & Verified Pin -->
              <div style="display:flex;align-items:center;justify-content:space-between;gap:6px">
                <div style="font-size:13px;font-weight:700;color:var(--text-primary)">${customerName}</div>
                ${isVer ? '<span style="background:#ECFDF5;color:#065F46;border:1px solid #A7F3D0;font-size:9.5px;font-weight:800;padding:1px 6px;border-radius:8px;flex-shrink:0">✓ Verified</span>' : '<span style="background:#FEF3C7;color:#92400E;border:1px solid #FCD34D;font-size:9.5px;font-weight:800;padding:1px 6px;border-radius:8px;flex-shrink:0">⚠ Unverified Pin</span>'}
              </div>

              <!-- Address snippet -->
              <div style="font-size:11px;color:var(--text-muted);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${o.resolvedDest.address}">
                📍 ${o.resolvedDest.address || 'No address provided'}
              </div>
              ${(!o.resolvedDest.lat || !o.resolvedDest.lng) ? '<div style="font-size:10px;color:var(--color-warning);margin-top:4px;font-weight:700">⚠ No valid shop pin — fix in Address Correction Portal</div>' : ''}

              <!-- Rider & Telemetry -->
              <div style="display:flex;align-items:center;justify-content:space-between;margin-top:6px;font-size:11px;color:var(--text-muted)">
                <span>🏍️ Rider: <strong>${o.riderName}</strong></span>
                <span>${fmtCurrency(o.grand_total)}</span>
              </div>

              <div style="display:flex;gap:8px;margin-top:6px;font-size:11px;font-weight:700;color:var(--color-primary);flex-wrap:wrap">
                <span>${etaText}</span>
                ${distText ? `<span>· ${distText}</span>` : ''}
                ${batteryText ? `<span>· ${batteryText}</span>` : ''}
              </div>

              <!-- Actions -->
              <div style="display:flex;gap:6px;margin-top:10px">
                <button class="btn btn-secondary" style="padding:5px 10px;font-size:11px;flex:1" onclick="focusDeliveryOrder('${o.id}')">📍 Focus Route</button>
                <a href="${shareUrl}" target="_blank" class="btn btn-primary" style="padding:5px 10px;font-size:11px;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;flex:1">Live Track ↗</a>
              </div>
            </div>
          `;
        }).join('');
      }
    }

    // 4. Render Active Fleet Sidebar
    const fleetListEl = document.getElementById('activeFleetList');
    const riderCountEl = document.getElementById('activeRiderCount');
    if (riderCountEl) riderCountEl.textContent = riders.length;

    if (fleetListEl) {
      if (riders.length === 0) {
        fleetListEl.innerHTML = '<div style="color:var(--text-muted);font-size:12px;text-align:center;padding:10px">No registered riders</div>';
      } else {
        fleetListEl.innerHTML = riders.map(r => {
          const t = trackings.find(tr => tr.rider_id === r.id);
          const rLat = t?.lat ?? t?.current_lat;
          const rLng = t?.lng ?? t?.current_lng;
          const isOnline = t && (Date.now() - new Date(t.updated_at).getTime() < 300000); // within 5 min
          const speed = t?.speed ? `${Math.round(t.speed * 3.6)} km/h` : (t?.speed_kmh ? `${Math.round(t.speed_kmh)} km/h` : 'Stationary');

          return `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:var(--bg-surface);border-radius:6px;border-left:3px solid ${isOnline ? 'var(--color-success)' : 'var(--border-color)'}">
              <div>
                <div style="font-size:12px;font-weight:700">${r.name}</div>
                <div style="font-size:10px;color:var(--text-muted)">📱 ${r.phone || 'No phone'} · ${isOnline ? `Online (${speed})` : 'Offline'}</div>
              </div>
              ${rLat && rLng ? `<button class="btn btn-secondary" style="padding:3px 8px;font-size:10px" onclick="panToDriver(${rLat},${rLng})">Track</button>` : ''}
            </div>
          `;
        }).join('');
      }
    }

    // 5. Render Proofs Gallery
    const proofsListEl = document.getElementById('deliveryProofsList');
    if (proofsListEl) {
      if (proofs.length === 0) {
        proofsListEl.innerHTML = '<div style="color:var(--text-muted);font-size:11px">No recent delivery proofs uploaded</div>';
      } else {
        proofsListEl.innerHTML = proofs.map(p => `
          <div style="flex-shrink:0;cursor:pointer;text-align:center" onclick="window.open('${p.photo_url}','_blank')">
            <img src="${p.photo_url}" alt="POD" style="width:64px;height:64px;object-fit:cover;border-radius:8px;border:1px solid var(--border-color)">
            <div style="font-size:9px;color:var(--text-muted);margin-top:2px;max-width:64px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${fmtDate(p.created_at)}</div>
          </div>
        `).join('');
      }
    }

    // 6. Place rider + destination markers with 6-state pin system
    if (_deliveryMap) {
      const renderedDrivers = new Set();

      // Helper: determine rider pin state and colors
      function getRiderPinState(o, t) {
        const ds = (o.delivery_status || '').toLowerCase();
        const st = (o.status || '').toLowerCase();
        const lastUpdate = t.updated_at ? new Date(t.updated_at).getTime() : 0;
        const staleMs = lastUpdate ? Date.now() - lastUpdate : Infinity;

        if (st === 'delivered' || ds === 'delivered') return { state: 'delivered', bg: '#9CA3AF', pulse: 'none', border: '#D1D5DB', shadow: 'rgba(156,163,175,0.3)' };
        if (st === 'delivery_failed' || ds === 'failed') return { state: 'failed', bg: '#EF4444', pulse: 'none', border: '#FCA5A5', shadow: 'rgba(239,68,68,0.4)' };
        if (staleMs > 120000) return { state: 'signal_lost', bg: '#F59E0B', pulse: 'blink 1s infinite', border: '#FCD34D', shadow: 'rgba(245,158,11,0.5)' };
        if (ds === 'arriving_soon' || (t.geofence_arrived)) return { state: 'arriving_soon', bg: '#10B981', pulse: 'pulse 1s infinite', border: '#A7F3D0', shadow: 'rgba(16,185,129,0.5)' };
        if (ds === 'in_transit' || ds === 'dispatched' || st === 'dispatched') return { state: 'in_transit', bg: '#1565C0', pulse: 'pulse 2s infinite', border: '#BBDEFB', shadow: 'rgba(21,101,192,0.5)' };
        return { state: 'dispatched', bg: '#3B82F6', pulse: 'none', border: '#93C5FD', shadow: 'rgba(59,130,246,0.4)' };
      }

      for (const o of enrichedOrders) {
        const t = o.tracking || {};
        const rLat = t.lat ?? t.current_lat;
        const rLng = t.lng ?? t.current_lng;
        const riderKey = o.assigned_to || t.rider_id || o.id;

        if (rLat != null && rLng != null && !renderedDrivers.has(riderKey)) {
          renderedDrivers.add(riderKey);
          allMapPoints.push([rLat, rLng]);

          const headingDeg = t.heading != null && t.heading >= 0 ? Math.round(t.heading) : 0;
          const speedText = t.speed ? `${Math.round(t.speed * 3.6)} km/h` : (t.speed_kmh ? `${Math.round(t.speed_kmh)} km/h` : 'Active');
          const pin = getRiderPinState(o, t);

          const riderIconHtml = `
            <div style="position:relative;width:36px;height:36px;display:flex;align-items:center;justify-content:center">
              <div style="position:absolute;width:100%;height:100%;border-radius:50%;background:${pin.bg}33;animation:${pin.pulse}"></div>
              <div style="background:${pin.bg};color:#fff;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;box-shadow:0 4px 12px ${pin.shadow};border:2.5px solid ${pin.border};transform:rotate(${headingDeg}deg)">
                🏍️
              </div>
            </div>
          `;

          const popupHtml = `
            <div style="min-width:160px;font-family:Inter,sans-serif">
              <div style="font-weight:800;font-size:13px;color:#0F172A">🏍️ ${escapeHtml(o.riderName || t.rider_name || 'Delivery Partner')}</div>
              <div style="font-size:11px;color:#64748B;margin-top:2px">Order #${escapeHtml(o.order_number || o.id.slice(0, 8))}</div>
              <div style="font-size:11px;color:#64748B">Speed: ${speedText}</div>
              <div style="font-size:11px;color:#64748B">Battery: ${t.battery_level ?? t.battery_pct ?? '—'}%</div>
              <div style="font-size:11px;color:#64748B">Last Update: ${t.updated_at ? timeAgo(t.updated_at) : '—'}</div>
              <div style="margin-top:4px"><span style="background:${pin.bg}22;color:${pin.bg};font-size:10px;font-weight:700;padding:2px 6px;border-radius:8px;border:1px solid ${pin.bg}44">${pin.state.replace(/_/g,' ').toUpperCase()}</span></div>
            </div>
          `;

          // In-place update or create
          if (riderMarkersMap[o.id]) {
            const existing = riderMarkersMap[o.id];
            existing.setLatLng([rLat, rLng]);
            existing.setIcon(L.divIcon({ className: '', html: riderIconHtml, iconSize: [36, 36], iconAnchor: [18, 18] }));
            existing.setPopupContent(popupHtml);
            existing.setOpacity(1);
            delete existing._greyedAt;
          } else {
            const riderMarker = L.marker([rLat, rLng], {
              icon: L.divIcon({ className: '', html: riderIconHtml, iconSize: [36, 36], iconAnchor: [18, 18] }),
              zIndexOffset: 600
            }).addTo(_deliveryMap).bindPopup(popupHtml);
            riderMarkersMap[o.id] = riderMarker;
          }
        }
      }

      // 7. Place Destination Store Pins & Draw Highlighted Driving Routes
      for (const o of enrichedOrders) {
        let dLat = o.resolvedDest.lat;
        let dLng = o.resolvedDest.lng;

        if ((!dLat || !dLng) && o.trackingBundle?.order) {
          dLat = Number(o.trackingBundle.order.destination_lat);
          dLng = Number(o.trackingBundle.order.destination_lng);
        }

        if ((!dLat || !dLng) && o.tracking) {
          const tLat = Number(o.tracking.destination_lat ?? o.tracking.dest_lat);
          const tLng = Number(o.tracking.destination_lng ?? o.tracking.dest_lng);
          if (Number.isFinite(tLat) && Number.isFinite(tLng) && !isDeliveryMapWarehousePin(tLat, tLng)) {
            dLat = tLat;
            dLng = tLng;
          }
        }

        if (dLat && dLng && (dLat !== 0 || dLng !== 0)) {
          allMapPoints.push([dLat, dLng]);

          // Priority Marker Pin (Numbered circle on top of pin)
          const isVer = o.resolvedDest.isVerified;
          const storeMarker = L.marker([dLat, dLng], {
            icon: L.divIcon({
              className: '',
              html: `
                <div style="position:relative;display:flex;flex-direction:column;align-items:center">
                  <div style="background:${o.priorityColor};color:#fff;font-size:10px;font-weight:900;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.3);position:absolute;top:-8px;right:-8px;z-index:2">
                    ${o.priorityNum}
                  </div>
                  <div style="background:${isVer ? '#059669' : '#1E293B'};color:#fff;width:34px;height:34px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);display:flex;align-items:center;justify-content:center;border:2.5px solid #fff;box-shadow:0 4px 14px rgba(0,0,0,0.35)">
                    <span style="transform:rotate(45deg);font-size:15px;line-height:1">🏪</span>
                  </div>
                </div>
              `,
              iconSize: [34, 40],
              iconAnchor: [17, 40]
            }),
            zIndexOffset: 400 - o.priorityNum
          }).addTo(_deliveryMap).bindPopup(`
            <div style="min-width:200px;font-family:Inter,sans-serif">
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
                <span style="background:${o.priorityColor};color:#fff;font-size:10px;font-weight:800;padding:2px 6px;border-radius:8px">Priority #${o.priorityNum}</span>
                <span class="badge badge-${getStatusBadgeClass(o.status)}" style="font-size:10px">${o.status}</span>
              </div>
              <div style="font-weight:800;font-size:13px;color:#0F172A">${o.resolvedDest.shopName}</div>
              ${isVer ? '<div style="background:#ECFDF5;color:#065F46;border:1px solid #A7F3D0;font-size:10px;font-weight:700;padding:2px 6px;border-radius:10px;display:inline-block;margin:4px 0">✓ Admin Verified Store Pin</div>' : ''}
              <div style="font-size:11px;color:#64748B;line-height:1.3;margin-top:3px">📍 ${o.resolvedDest.address || 'Nagpur'}</div>
              <div style="font-size:11px;color:#64748B;margin-top:4px">🏍️ Driver: <strong>${o.riderName}</strong> · Total: <strong>${fmtCurrency(o.grand_total)}</strong></div>
              <div style="display:flex;gap:6px;margin-top:8px">
                <a href="${window.location.origin}/track.html?id=${o.id}" target="_blank" class="btn btn-primary" style="padding:4px 8px;font-size:11px;text-decoration:none;display:inline-flex;align-items:center">Live Track ↗</a>
                <button class="btn btn-secondary" style="padding:4px 8px;font-size:11px" onclick="focusDeliveryOrder('${o.id}')">Focus Route</button>
              </div>
            </div>
          `);
          shopMarkersMap[o.id] = storeMarker;
          o.marker = storeMarker;

          // Determine start location for road route (Driver GPS or Warehouse)
          const t = o.tracking;
          const rLat = t.lat ?? t.current_lat ?? DELIVERY_MAP_WAREHOUSE_LAT;
          const rLng = t.lng ?? t.current_lng ?? DELIVERY_MAP_WAREHOUSE_LNG;

          // Remove old route polylines for this order
          if (routePolylinesMap[o.id]) {
            try {
              if (routePolylinesMap[o.id].glow && _deliveryMap.hasLayer(routePolylinesMap[o.id].glow)) _deliveryMap.removeLayer(routePolylinesMap[o.id].glow);
              if (routePolylinesMap[o.id].core && _deliveryMap.hasLayer(routePolylinesMap[o.id].core)) _deliveryMap.removeLayer(routePolylinesMap[o.id].core);
            } catch(e) {}
          }

          // Fetch and draw driving route
          fetchDeliveryRoute(rLat, rLng, dLat, dLng).then(routeData => {
            if (!_deliveryMap || !routeData || !routeData.coords) return;

            // Outer glow line
            const glowLine = L.polyline(routeData.coords, {
              color: o.priorityColor,
              weight: 7,
              opacity: 0.45,
              lineCap: 'round',
              lineJoin: 'round'
            }).addTo(_deliveryMap);

            // Core driving line
            const coreLine = L.polyline(routeData.coords, {
              color: o.priorityColor,
              weight: 3.5,
              opacity: 0.95,
              lineCap: 'round',
              lineJoin: 'round'
            }).addTo(_deliveryMap).bindTooltip(`
              <strong>Priority #${o.priorityNum}: ${o.resolvedDest.shopName}</strong><br>
              🚗 Road Distance: ${(routeData.distanceMeters / 1000).toFixed(1)} km (~${Math.ceil(routeData.durationSeconds / 60)} min)
            `, { sticky: true });

            routePolylinesMap[o.id] = { glow: glowLine, core: coreLine };

            _deliveryRoutes[o.id] = {
              glowLine,
              coreLine,
              destLat: dLat,
              destLng: dLng,
              startLat: rLat,
              startLng: rLng,
              storeMarker
            };
          });
        }
      }

      // Auto fit on first load only (not on every refresh to prevent re-zoom while admin pans)
      if (!window._deliveryMapInitialFitDone && allMapPoints.length > 1) {
        _deliveryMap.fitBounds(L.latLngBounds(allMapPoints), { padding: [50, 50], maxZoom: 15 });
        window._deliveryMapInitialFitDone = true;
      }
      window._deliveryFitPoints = allMapPoints.slice();
    }

    // 8. Fetch Delivery System Health Metrics (with Canary Cohort scoping)
    try {
      const { data: healthRes } = await sb.rpc('get_delivery_health_summary', {
        p_canary_only: _isCanaryFilterActive
      });
      if (healthRes) {
        const snapEl = document.getElementById('healthSnapshotStatus');
        const reconnEl = document.getElementById('healthReconnectsCount');
        const offRouteEl = document.getElementById('healthOffRouteCount');
        const shiftsEl = document.getElementById('healthShiftsCount');
        const auditTimeEl = document.getElementById('healthLastAuditTime');
        const scopeLabelEl = document.getElementById('healthScopeLabel');
        const scopeBtn = document.getElementById('canaryScopeBtn');

        if (scopeBtn) scopeBtn.textContent = _isCanaryFilterActive ? '🌐 Fleet View' : '🧪 Canary View';
        if (scopeLabelEl) {
          scopeLabelEl.textContent = _isCanaryFilterActive 
            ? `● Viewing Canary Cohort (${healthRes.canary_riders_active || 0} active)` 
            : '● Viewing Fleet-Wide Metrics';
          scopeLabelEl.style.color = _isCanaryFilterActive ? '#10B981' : '#3B82F6';
        }

        if (snapEl) {
          if (healthRes.mismatches_found > 0) {
            snapEl.innerHTML = `<span style="color:#F59E0B">⚠️ ${healthRes.mismatches_found} items found — review & remediate</span>`;
          } else {
            snapEl.innerHTML = `<span style="color:#10B981">● 0 Mismatches (${healthRes.total_checked || 0} checked)</span>`;
          }
        }
        const breakersEl = document.getElementById('healthBreakersCount');
        const riderIssuesEl = document.getElementById('healthRiderIssuesCount');

        if (reconnEl) reconnEl.textContent = `${healthRes.realtime_reconnects_24h || 0} events`;
        if (offRouteEl) offRouteEl.textContent = `${healthRes.off_route_recalcs_24h || 0} triggers`;
        if (shiftsEl) shiftsEl.textContent = `${healthRes.destination_shifts_24h || 0} shifts`;
        if (breakersEl) breakersEl.textContent = `${healthRes.circuit_breakers_24h || 0} tripped`;
        if (riderIssuesEl) riderIssuesEl.textContent = `${healthRes.rider_issues_24h || 0} reported`;
        if (auditTimeEl) auditTimeEl.textContent = `Last Audit: ${healthRes.last_audit_at ? timeAgo(healthRes.last_audit_at) : 'Never'}`;
      }
    } catch (e) {
      console.warn('Health summary fetch warning:', e);
    }

    // 9. Load Canary Allowlist Riders
    try {
      const { data: canaryList } = await sb.rpc('list_canary_riders', { p_feature_set: 'delivery_flow_v2' });
      const canaryEl = document.getElementById('canaryRidersList');
      const badgeEl = document.getElementById('canaryActiveCountBadge');
      if (canaryList && Array.isArray(canaryList)) {
        const activeCount = canaryList.filter(r => r.is_canary_enabled).length;
        if (badgeEl) badgeEl.textContent = `${activeCount} Active`;

        if (canaryEl) {
          if (canaryList.length === 0) {
            canaryEl.innerHTML = '<div style="color:var(--text-muted);font-size:11px;text-align:center;padding:10px">No delivery riders registered</div>';
          } else {
            canaryEl.innerHTML = canaryList.map(r => {
              const riderId = escapeAttr(r.rider_id);
              return `
              <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 8px;background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:6px;font-size:11px">
                <div style="display:flex;flex-direction:column">
                  <span style="font-weight:700">${escapeHtml(r.name)}</span>
                  <span style="color:var(--text-muted);font-size:10px">${escapeHtml(r.phone || 'No phone')}</span>
                </div>
                <label class="switch" style="transform:scale(0.8);margin:0">
                  <input type="checkbox" ${r.is_canary_enabled ? 'checked' : ''} onchange="toggleCanaryRider('${riderId}', this.checked)">
                  <span class="slider round"></span>
                </label>
              </div>
            `;
            }).join('');
          }
        }
      }
    } catch (e) {
      console.warn('Canary riders fetch warning:', e);
    }

    // 10. Setup Realtime subscription (Singleton with debouncing)
    setupAdminDeliveryRealtime();

  } catch (err) {
    console.error('Failed to load delivery data:', err);
    showToast(`Failed to load delivery tracking: ${err.message || 'Unknown error'}`, 'error');
    const deliveryListEl = document.getElementById('activeDeliveryList');
    if (deliveryListEl) {
      deliveryListEl.innerHTML = `<div style="color:var(--color-error);font-size:12px;text-align:center;padding:20px">Could not load deliveries. ${escapeHtml(err.message || 'Check console.')}</div>`;
    }
  }
}

let _deliveryRealtimeChannel = null;
let _deliveryDebounceTimer = null;

function setupAdminDeliveryRealtime() {
  if (_deliveryRealtimeChannel) return;

  _deliveryRealtimeChannel = sb.channel('admin-delivery-realtime')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'delivery_tracking' }, () => {
      if (currentPage === 'delivery') {
        if (_deliveryDebounceTimer) clearTimeout(_deliveryDebounceTimer);
        _deliveryDebounceTimer = setTimeout(() => loadDeliveryData(), 1500);
      }
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, (payload) => {
      if (currentPage === 'delivery') {
        // Detect new dispatch — reset fitBounds so map re-fits to include new delivery
        if (payload.new && (payload.new.delivery_status === 'dispatched' || payload.new.status === 'dispatched')) {
          if (payload.old && payload.old.delivery_status !== 'dispatched' && payload.old.status !== 'dispatched') {
            window._deliveryMapInitialFitDone = false; // Will trigger fitBounds on next loadDeliveryData
          }
        }
        if (_deliveryDebounceTimer) clearTimeout(_deliveryDebounceTimer);
        _deliveryDebounceTimer = setTimeout(() => loadDeliveryData(), 1500);
      }
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'delivery_proofs' }, () => {
      if (currentPage === 'delivery') {
        if (_deliveryDebounceTimer) clearTimeout(_deliveryDebounceTimer);
        _deliveryDebounceTimer = setTimeout(() => loadDeliveryData(), 1500);
      }
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'delivery_telemetry_events' }, () => {
      if (currentPage === 'delivery') {
        if (_deliveryDebounceTimer) clearTimeout(_deliveryDebounceTimer);
        _deliveryDebounceTimer = setTimeout(() => loadDeliveryData(), 1500);
      }
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'canary_rider_flags' }, () => {
      if (currentPage === 'delivery') {
        if (_deliveryDebounceTimer) clearTimeout(_deliveryDebounceTimer);
        _deliveryDebounceTimer = setTimeout(() => loadDeliveryData(), 1500);
      }
    })
    .subscribe();
}

let _isCanaryFilterActive = false;

window.toggleCanaryScopeFilter = function() {
  _isCanaryFilterActive = !_isCanaryFilterActive;
  loadDeliveryData();
};

window.toggleCanaryRider = async function(riderId, enabled) {
  try {
    const { error } = await sb.rpc('toggle_rider_canary_flag', {
      p_rider_id: riderId,
      p_enabled: enabled,
      p_feature_set: 'delivery_flow_v2',
      p_notes: `Toggled via admin dashboard by admin`
    });
    if (error) throw error;
    showToast(`Canary status updated: Rider is now ${enabled ? 'ENABLED' : 'DISABLED'}`, 'success');
    loadDeliveryData();
  } catch (err) {
    showToast(`Failed to update canary status: ${err.message}`, 'error');
  }
};

window.runDeliveryHealthAudit = async function(isDryRun = true) {
  try {
    showToast('Running delivery integrity audit (Dry Run)...', 'info');
    const { data, error } = await sb.rpc('reconcile_historical_delivered_order_snapshots', { p_dry_run: isDryRun });
    if (error) throw error;
    if (data.mismatches_found === 0) {
      showToast(`✅ Audit clean: 0 mismatches across ${data.total_historical_delivered_checked} delivered orders`, 'success');
    } else {
      showToast(`ℹ️ Audit found ${data.mismatches_found} items — review affected list to apply remediation`, 'info');
    }
    loadDeliveryData();
  } catch (err) {
    showToast(`Audit failed: ${err.message}`, 'error');
  }
};

window.runSubsystemMaintenance = async function() {
  try {
    showToast('Running daily subsystem maintenance & retention purge...', 'info');
    const { data, error } = await sb.rpc('run_delivery_subsystem_daily_maintenance');
    if (error) throw error;
    const historyPurged = data.location_history?.records_purged || 0;
    const telemetryPurged = data.telemetry_events?.telemetry_purged || 0;
    showToast(`🧹 Maintenance complete: Purged ${historyPurged} location points, ${telemetryPurged} telemetry events`, 'success');
    loadDeliveryData();
  } catch (err) {
    showToast(`Maintenance run failed: ${err.message}`, 'error');
  }
};

window.fitAllDeliveriesOnMap = function() {
  if (!_deliveryMap) return;
  const pts = window._deliveryFitPoints;
  if (pts && pts.length > 1) {
    _deliveryMap.fitBounds(L.latLngBounds(pts), { padding: [50, 50], maxZoom: 15 });
    return;
  }
  _deliveryMap.flyTo([DELIVERY_MAP_WAREHOUSE_LAT, DELIVERY_MAP_WAREHOUSE_LNG], 13);
};

window.focusDeliveryOrder = function(orderId) {
  if (!_deliveryMap || !_deliveryRoutes[orderId]) return;
  const r = _deliveryRoutes[orderId];
  if (r.startLat && r.startLng && r.destLat && r.destLng) {
    _deliveryMap.fitBounds([[r.startLat, r.startLng], [r.destLat, r.destLng]], { padding: [60, 60] });
    if (r.storeMarker) r.storeMarker.openPopup();
    highlightDeliveryRoute(orderId);
  }
};

window.highlightDeliveryRoute = function(orderId) {
  if (!_deliveryRoutes[orderId]) return;
  const r = _deliveryRoutes[orderId];
  if (r.coreLine) {
    r.coreLine.setStyle({ weight: 6, opacity: 1.0 });
    r.coreLine.bringToFront();
  }
  if (r.glowLine) {
    r.glowLine.setStyle({ weight: 12, opacity: 0.7 });
    r.glowLine.bringToFront();
  }
};

window.unhighlightDeliveryRoute = function(orderId) {
  if (!_deliveryRoutes[orderId]) return;
  const r = _deliveryRoutes[orderId];
  if (r.coreLine) r.coreLine.setStyle({ weight: 3.5, opacity: 0.95 });
  if (r.glowLine) r.glowLine.setStyle({ weight: 7, opacity: 0.45 });
};

window.focusDeliveryOnMap = function(rLat, rLng, dLat, dLng, name) {
  if (!_deliveryMap) return;
  if (rLat && rLng && dLat && dLng) {
    _deliveryMap.fitBounds([[rLat, rLng], [dLat, dLng]], { padding: [50, 50] });
  } else if (rLat && rLng) {
    _deliveryMap.flyTo([rLat, rLng], 16);
  }
};

window.panToDriver = function(lat, lng) {
  if (_deliveryMap && lat && lng) _deliveryMap.flyTo([lat, lng], 16);
};

// ============================================================
// ADDRESS CORRECTION PORTAL (3-PANEL OPS CONTROL CENTER)
// ============================================================

const WAREHOUSE_LAT = DELIVERY_MAP_WAREHOUSE_LAT;
const WAREHOUSE_LNG = DELIVERY_MAP_WAREHOUSE_LNG;

let _correctionMap = null;
let _correctionPinMarker = null;
let _suggestedPinMarker = null;
let _correctionWarehouseMarker = null;
let _correctionWarehouseCircle = null;
let _streetTileLayer = null;
let _satelliteTileLayer = null;
let _currentTileLayerType = 'streets';

let _correctionLocations = [];
let _filteredCorrectionLocations = [];
let _selectedCorrectionLoc = null;
let _originalCoord = null;
let _currentPinCoord = null;
let _queueFilter = 'unverified';
let _queueSearch = '';

const GENERIC_ADDRESS_TERMS = new Set([
  'PHARMACY', 'MEDICAL', 'STORE', 'STORES', 'CHEMIST', 'DRUGS', 'MEDICINE',
  'DISTRIBUTOR', 'TRADERS', 'AGENCY', 'AGENCIES', 'ENTERPRISES', 'LIMITED',
  'PVT', 'LTD', 'ROOM', 'MAIN', 'BUILDING', 'HEADQUARTER', 'HEADQUARTERS',
  'NAGPUR', 'MAHARASHTRA', 'INDIA', 'SHOP', 'FLOOR', 'FLR', 'GRD'
]);

const PLACEHOLDERS = new Set([
  'n/a', 'na', 'none', '-', '--', '---', '.', '..', 'null', 'nil',
  'undefined', 'unknown', 'tbd', 'to be decided', 'not specified',
  'not available', 'no', '0', '000000', 'blank', 'empty', 'xxx',
  'owner', 'retailer'
]);

function isPlaceholderValue(v) {
  if (v === null || v === undefined) return true;
  const s = String(v).trim().toLowerCase();
  if (s === '' || s.length === 0) return true;
  if (PLACEHOLDERS.has(s)) return true;
  if (/^n[\s/.]*a$/i.test(s)) return true;
  if (/^[-._\s]+$/.test(s)) return true;
  return false;
}

function cleanField(v) {
  if (isPlaceholderValue(v)) return '';
  return String(v).trim();
}

function cleanStreetName(v) {
  const s = cleanField(v);
  if (!s) return '';
  return s.replace(/^(near|opp|opposite|behind|beside|front of|next to|above|below)\s+/i, '').trim();
}

function cleanAddressNoise(s) {
  if (!s) return '';
  let str = String(s).trim();
  str = str.replace(/\s*\(\d+\)/g, '');
  str = str.replace(/\bROOM\s*(?:NO\.?)?\s*[\w\d\s\-]+/gi, '');
  str = str.replace(/\bGRD\.?\s*FLR?\b/gi, '');
  str = str.replace(/\b\d+(?:st|nd|rd|th)?\s*FLR?\b/gi, '');
  str = str.replace(/\bH\.?\s*NO\.?\s*[\w\d\/\-]+/gi, '');
  str = str.replace(/\bPLOT\s*(?:NO\.?)?\s*[\w\d\/\-]+/gi, '');
  str = str.replace(/\bKH\.?\s*NO\.?\s*[\w\d\/\-]+/gi, '');
  str = str.replace(/\bADM\/BS\/[\w\d\/\-]+/gi, '');
  str = str.replace(/[\s,]+,/g, ',');
  return str.replace(/^\s*,\s*|\s*,\s*$/g, '').trim();
}

function extractUniquePOITokens(text) {
  if (!text) return [];
  const cleaned = cleanAddressNoise(text);
  const words = cleaned.toUpperCase().split(/[\s,\-\/()]+/).filter((w) => w.length >= 3 && !GENERIC_ADDRESS_TERMS.has(w) && !/^\d+$/.test(w));
  return Array.from(new Set(words));
}

function normalizeAddressForCache(query) {
  return query.toLowerCase().trim().replace(/[\s,]+/g, ' ');
}

function extractFormattedSegments(text, shopName) {
  if (!text) return [];
  const cleaned = cleanAddressNoise(text);
  // Split by comma into segments
  const raw = cleaned.split(',').map(s => s.trim()).filter(s => s.length >= 2 && !isPlaceholderValue(s));
  // Strip positional prefixes from each segment
  const stripPrefix = (s) => s.replace(/^(near|opp|opposite|behind|beside|front of|next to|above|below)\s+/i, '').trim();
  // Filter out shop name segment (not geocodable), generic business terms, and city/state
  const shopNameNorm = (shopName || '').toLowerCase().trim();
  const skipWords = new Set(['nagpur', 'maharashtra', 'india']);
  const segments = [];
  for (const seg of raw) {
    const lower = seg.toLowerCase().trim();
    // Skip if it's the shop name or just a number
    if (shopNameNorm && lower.includes(shopNameNorm.substring(0, 8))) continue;
    if (/^\d+$/.test(seg.trim())) continue;
    if (skipWords.has(lower)) continue;
    // Strip positional prefix
    const stripped = stripPrefix(seg);
    if (stripped.length >= 2 && !isPlaceholderValue(stripped)) {
      segments.push(stripped);
    }
  }
  return segments;
}

const ZERO_MILE_NAGPUR = { lat: 21.1498134, lng: 79.0820556 };

function isCityCentroidCollapse(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return true;
  return haversineDistMeters(ZERO_MILE_NAGPUR.lat, ZERO_MILE_NAGPUR.lng, lat, lng) < 350;
}

function isLowPrecisionNominatim(item) {
  if (!item) return true;
  const broadTypes = new Set([
    'city', 'town', 'village', 'state', 'country', 'administrative',
    'county', 'district', 'region', 'postcode', 'state_district', 'nation'
  ]);
  if (item.class === 'boundary' || (item.class === 'place' && broadTypes.has(item.type || '')) || broadTypes.has(item.type || '')) {
    return true;
  }
  if (item.boundingbox && Array.isArray(item.boundingbox) && item.boundingbox.length === 4) {
    const [minLat, maxLat, minLng, maxLng] = item.boundingbox.map(Number);
    const latSpan = Math.abs(maxLat - minLat);
    const lngSpan = Math.abs(maxLng - minLng);
    if (latSpan > 0.04 || lngSpan > 0.04) {
      return true;
    }
  }
  return false;
}

function isLowPrecisionPhoton(feature) {
  if (!feature || !feature.properties) return true;
  const props = feature.properties;
  const broadTypes = new Set([
    'city', 'town', 'village', 'state', 'country', 'county',
    'district', 'locality', 'administrative', 'state_district'
  ]);
  if (broadTypes.has(props.type || '') || (props.osm_key === 'place' && broadTypes.has(props.osm_value || '')) || props.osm_key === 'boundary') {
    return true;
  }
  if (feature.extent && Array.isArray(feature.extent) && feature.extent.length === 4) {
    const [minLng, maxLat, maxLng, minLat] = feature.extent;
    const latSpan = Math.abs(maxLat - minLat);
    const lngSpan = Math.abs(maxLng - minLng);
    if (latSpan > 0.04 || lngSpan > 0.04) {
      return true;
    }
  }
  return false;
}

function cleanTier0FormattedAddress(text, city = 'Nagpur', state = 'Maharashtra') {
  if (!text || isPlaceholderValue(text)) return '';
  let str = String(text).trim();
  str = str.replace(/[\s,]+,/g, ', ').replace(/\s{2,}/g, ' ');
  str = str.replace(/,\s*([A-Za-z0-9]{1,2})\s*$/i, (match, fragment) => {
    const lower = fragment.toLowerCase();
    return (lower === 'in' || lower === 'mh') ? match : '';
  }).trim();

  if (str.length < 5) return '';

  if (!str.toLowerCase().includes(city.toLowerCase()) && !str.toLowerCase().includes('nagpur')) {
    str = `${str}, ${city}`;
  }
  if (!str.toLowerCase().includes(state.toLowerCase()) && !str.toLowerCase().includes('maharashtra')) {
    str = `${str}, ${state}`;
  }
  if (!str.toLowerCase().includes('india')) {
    str = `${str}, India`;
  }
  return str;
}

function buildGeocodeQueryLadder(loc) {
  if (!loc) return [];
  const shopName = cleanField(loc.shop_name);
  const building = cleanField(loc.building);
  const rawStreet = cleanField(loc.street);
  const street = cleanStreetName(loc.street);
  const landmark = cleanField(loc.landmark);
  const area = cleanField(loc.area);
  const city = cleanField(loc.city) || 'Nagpur';
  const state = cleanField(loc.state) || 'Maharashtra';
  const pincode = cleanField(loc.pincode);
  const formatted = cleanField(loc.formatted_address);

  const candidates = [];
  const seenQueries = new Set();

  const addCandidate = (level, tier, name, parts, defaultConfidence) => {
    const filtered = parts.map((p) => cleanAddressNoise(p)).filter((p) => p.length > 0 && !isPlaceholderValue(p));
    if (filtered.length === 0) return;

    let q = filtered.join(', ');
    if (!q.toLowerCase().includes('nagpur') && !q.toLowerCase().includes(city.toLowerCase())) {
      q = `${q}, ${city}`;
    }
    if (!q.toLowerCase().includes('maharashtra') && !q.toLowerCase().includes(state.toLowerCase())) {
      q = `${q}, ${state}`;
    }
    if (!q.toLowerCase().includes('india')) {
      q = `${q}, India`;
    }

    const norm = normalizeAddressForCache(q);
    if (!seenQueries.has(norm) && norm.length >= 8) {
      seenQueries.add(norm);
      candidates.push({ level, tier, name, query: q, defaultConfidence });
    }
  };

  // ===========================================================================
  // TIER 0: Raw Formatted Address ALWAYS Tried First
  // ===========================================================================
  if (formatted && formatted.length >= 5) {
    const cleanTier0 = cleanTier0FormattedAddress(formatted, city, state);
    if (cleanTier0.length >= 8) {
      const norm = normalizeAddressForCache(cleanTier0);
      if (!seenQueries.has(norm)) {
        seenQueries.add(norm);
        candidates.push({
          level: 0,
          tier: 'Tier 0 (formatted_address)',
          name: 'tier0_formatted_address',
          query: cleanTier0,
          defaultConfidence: 'ROOFTOP',
        });
      }
    }
  }

  // ===========================================================================
  // TIER 1: Street / Road Direct
  // ===========================================================================
  if (rawStreet) {
    addCandidate(1, 'Tier 1 (street_direct)', 'street_direct', [rawStreet, area, pincode, city, state], 'STREET');
    if (street && street !== rawStreet) {
      addCandidate(1, 'Tier 1 (street_direct)', 'street_direct', [street, area, pincode, city, state], 'STREET');
    }
  }

  // ===========================================================================
  // TIER 2: Formatted Address Segments Breakdown (minus shop name)
  // ===========================================================================
  if (formatted && formatted.length > 5) {
    const segments = extractFormattedSegments(formatted, shopName);
    if (segments.length >= 1) {
      addCandidate(2, 'Tier 2 (formatted_segments)', 'formatted_segments_all', [...segments, city, state], 'ROOFTOP');
    }
    for (let i = 0; i < segments.length; i++) {
      if (i + 1 < segments.length) {
        addCandidate(2, 'Tier 2 (formatted_segments)', 'formatted_segment_pair', [segments[i], segments[i + 1], city, state], 'STREET');
      }
    }
    for (const seg of segments) {
      if (seg.length >= 3) {
        addCandidate(2, 'Tier 2 (formatted_segments)', 'formatted_segment_single', [seg, area, city, state], 'AREA_APPROXIMATE');
        addCandidate(2, 'Tier 2 (formatted_segments)', 'formatted_segment_single', [seg, city, state], 'AREA_APPROXIMATE');
      }
    }
  }

  // ===========================================================================
  // TIER 3: Structured Shop + Building + Street + Landmark
  // ===========================================================================
  addCandidate(3, 'Tier 3 (structured_full)', 'structured_full', [shopName, building, street || rawStreet, landmark, area, pincode, city, state], 'ROOFTOP');

  if (street || rawStreet) {
    addCandidate(3, 'Tier 3 (street_standalone)', 'street_standalone', [street || rawStreet, city, state], 'STREET');
    addCandidate(3, 'Tier 3 (street_landmark_area)', 'street_landmark_area', [street || rawStreet, landmark, area, pincode, city, state], 'STREET');
  }

  // ===========================================================================
  // TIER 4: Landmark + Area Locality Matching
  // ===========================================================================
  addCandidate(4, 'Tier 4 (landmark_area)', 'landmark_area', [landmark, area, city, state], 'AREA_APPROXIMATE');
  if (area) {
    addCandidate(4, 'Tier 4 (area_city)', 'area_city', [area, city, state], 'AREA_APPROXIMATE');
  }

  // ===========================================================================
  // TIER 5: Pincode Matching
  // ===========================================================================
  if (pincode && pincode.length === 6) {
    addCandidate(5, 'Tier 5 (pincode_city)', 'pincode_city', [pincode, city, state], 'PINCODE_APPROXIMATE');
  }

  return candidates;
}

function cleanAddressForGeocode(loc) {
  const ladder = buildGeocodeQueryLadder(loc);
  return ladder.length > 0 ? ladder[0].query : '';
}

function haversineDistMeters(lat1, lon1, lat2, lon2) {
  if (!lat1 || !lon1 || !lat2 || !lon2) return 0;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isFallbackLocation(loc) {
  if (!loc) return false;
  if (loc.is_verified && loc.verified_by) return false;
  const lat = Number(loc.lat);
  const lng = Number(loc.lng);
  if (!lat || !lng || (lat === 0 && lng === 0)) return true;
  const dist = haversineDistMeters(lat, lng, WAREHOUSE_LAT, WAREHOUSE_LNG);
  return dist <= 220;
}

async function renderAddressCorrection() {
  pageContent.innerHTML = `
    <div class="address-portal-wrap">
      <!-- Top Stats Bar -->
      <div class="address-portal-stats" id="correctionStatsBar">
        <div class="address-stat-card primary">
          <div class="address-stat-icon">🏪</div>
          <div>
            <div class="address-stat-val" id="statTotalLocations">—</div>
            <div class="address-stat-lbl">Total Locations</div>
          </div>
        </div>
        <div class="address-stat-card success">
          <div class="address-stat-icon">✅</div>
          <div>
            <div class="address-stat-val" id="statVerifiedPct">—%</div>
            <div class="address-stat-lbl" id="statVerifiedCount">Verified</div>
          </div>
        </div>
        <div class="address-stat-card primary">
          <div class="address-stat-icon">📍</div>
          <div>
            <div class="address-stat-val" id="statAutoSuggested" style="color:#B388FF">—</div>
            <div class="address-stat-lbl">Auto-suggested</div>
          </div>
        </div>
        <div class="address-stat-card error">
          <div class="address-stat-icon">🎯</div>
          <div>
            <div class="address-stat-val" id="statNeedsRecheck" style="color:#FF4D6A">—</div>
            <div class="address-stat-lbl">Needs Re-check</div>
          </div>
        </div>
        <div class="address-stat-card warning">
          <div class="address-stat-icon">⚠️</div>
          <div>
            <div class="address-stat-val" id="statFallbackFlagged" style="color:var(--color-warning)">—</div>
            <div class="address-stat-lbl">Fallback Flagged</div>
          </div>
        </div>
        <div class="address-stat-card info">
          <div class="address-stat-icon">📅</div>
          <div>
            <div class="address-stat-val" id="statTodayCorrections">—</div>
            <div class="address-stat-lbl">Corrected Today</div>
          </div>
        </div>
      </div>

      <!-- 3-Panel Main Layout -->
      <div class="address-portal-grid">
        <!-- 1. LEFT PANEL: Priority Queue -->
        <div class="address-queue-panel">
          <div class="address-queue-header">
            <div class="address-queue-title-row">
              <span class="address-queue-title">
                <span>📍 Priority Queue</span>
                <span style="font-size:12px;color:var(--text-muted)">(<span id="queueCount">0</span>)</span>
              </span>
              <button class="btn-next-unverified" id="btnNextUnverified" title="Jump to next unverified shop">
                ⚡ Next Unverified
              </button>
            </div>
            <input type="text" class="address-queue-search" id="queueSearchInput" placeholder="Search shop name, area, city...">
            <div class="address-queue-filters" id="queueFilterGroup">
              <button class="address-filter-chip" data-filter="auto_suggested">📍 Auto-suggested</button>
              <button class="address-filter-chip" data-filter="needs_reverification">🎯 Needs Re-check</button>
              <button class="address-filter-chip active" data-filter="unverified">⏳ Unverified</button>
              <button class="address-filter-chip" data-filter="active_orders">📦 Active Orders</button>
              <button class="address-filter-chip" data-filter="fallback">⚠️ Fallback Pin</button>
              <button class="address-filter-chip" data-filter="not_on_maps">🚫 Not on Maps</button>
              <button class="address-filter-chip" data-filter="all">All</button>
            </div>
          </div>
          <div class="address-queue-list" id="queueListContainer">
            <div style="color:var(--text-muted);font-size:12px;text-align:center;padding:24px">Loading all retailer locations (8,700+ shops)...</div>
          </div>
        </div>

        <!-- 2. CENTER PANEL: Leaflet Map -->
        <div class="address-map-panel">
          <div class="address-map-header">
            <div class="address-map-search-wrap">
              <input type="text" class="address-map-search-input" id="mapSearchInput" placeholder="Search landmark/area to center map (e.g. Sitabuldi, Dharampeth)...">
              <button class="btn btn-secondary" style="padding:5px 10px;font-size:11px" id="btnMapSearch">🔍 Search</button>
            </div>
            <div class="address-map-controls">
              <button class="btn btn-secondary" style="padding:5px 10px;font-size:11px" id="btnToggleTileLayer" title="Toggle satellite imagery">🛰️ Satellite</button>
              <button class="btn btn-secondary" style="padding:5px 10px;font-size:11px" id="btnCenterWarehouse" title="Center map on Sandesh Dawa Bazar warehouse">🏪 Warehouse</button>
              <button class="btn btn-secondary" style="padding:5px 10px;font-size:11px" id="btnResetPin" title="Reset pin to original coordinates">🔄 Reset Pin</button>
            </div>
          </div>
          <div class="address-map-view-box">
            <div id="addressCorrectionMap"></div>
            <div id="mapFallbackBanner" class="map-fallback-banner" style="display:none;">
              ⚠️ Location currently at fallback warehouse pin (21.150167, 79.099140). Drag the pin or click on the map to set the actual entrance.
            </div>
          </div>
          <div class="address-map-footer-readout">
            <div>
              <span>Current Pin: </span>
              <strong id="readoutLat" style="font-family:monospace;color:var(--text-primary)">21.150167</strong>,
              <strong id="readoutLng" style="font-family:monospace;color:var(--text-primary)">79.099140</strong>
            </div>
            <div id="distanceMovedReadout" class="distance-moved-badge">📏 Original Position</div>
          </div>
        </div>

        <!-- 3. RIGHT PANEL: Address Form & Save Handler -->
        <div class="address-form-panel">
          <div class="address-form-header">
            <div class="address-form-title">📝 Address & Coordinates Editor</div>
            <span id="formVerifiedBadge" class="badge badge-warning" style="font-size:10px">Unverified</span>
          </div>
          <div class="address-form-body" id="addressFormBody">
            <div style="color:var(--text-muted);font-size:12px;text-align:center;padding:24px">Select a location from the queue to start editing.</div>
          </div>
          <div class="address-form-footer">
            <button class="btn-save-address" id="btnSaveAddress" disabled>
              💾 Save & Confirm Coordinates
            </button>
          </div>
        </div>
      </div>
    </div>
  `;

  // Init Leaflet map instance
  initCorrectionMap();

  // Load stats and shop locations
  await loadCorrectionStats();
  await loadCorrectionLocations();

  // Attach Event Listeners
  document.getElementById('queueSearchInput')?.addEventListener('input', (e) => {
    _queueSearch = e.target.value.toLowerCase().trim();
    filterAndRenderQueue();
  });

  document.querySelectorAll('#queueFilterGroup .address-filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('#queueFilterGroup .address-filter-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      _queueFilter = chip.dataset.filter || 'unverified';
      filterAndRenderQueue(true);
    });
  });

  document.getElementById('btnNextUnverified')?.addEventListener('click', () => {
    advanceToNextUnverified();
  });

  document.getElementById('btnMapSearch')?.addEventListener('click', handleMapSearch);
  document.getElementById('mapSearchInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleMapSearch();
  });

  document.getElementById('btnToggleTileLayer')?.addEventListener('click', toggleTileLayer);
  document.getElementById('btnCenterWarehouse')?.addEventListener('click', () => {
    if (_correctionMap) {
      _correctionMap.invalidateSize();
      _correctionMap.flyTo([WAREHOUSE_LAT, WAREHOUSE_LNG], 16);
    }
  });
  document.getElementById('btnResetPin')?.addEventListener('click', resetPinToOriginal);

  document.getElementById('btnSaveAddress')?.addEventListener('click', handleSaveCorrection);
}

function initCorrectionMap() {
  if (typeof L === 'undefined') {
    const el = document.getElementById('addressCorrectionMap');
    if (el) el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted)">Leaflet library not loaded</div>';
    return;
  }

  if (_correctionMap) {
    try { _correctionMap.remove(); } catch(e) {}
    _correctionMap = null;
  }
  _correctionPinMarker = null;
  _suggestedPinMarker = null;
  _correctionWarehouseMarker = null;
  _correctionWarehouseCircle = null;

  _correctionMap = L.map('addressCorrectionMap', {
    zoomControl: true,
    attributionControl: false
  }).setView([WAREHOUSE_LAT, WAREHOUSE_LNG], 15);

  _streetTileLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap, © CARTO'
  });

  _satelliteTileLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: '© Esri'
  });

  _streetTileLayer.addTo(_correctionMap);
  _currentTileLayerType = 'streets';

  // Fixed warehouse marker
  const warehouseIcon = L.divIcon({
    className: '',
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    html: `<div style="background:#6C63FF;color:#fff;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;box-shadow:0 4px 12px rgba(108,99,255,0.5);border:2px solid #fff" title="Thakkar Medico Warehouse">🏪</div>`
  });
  _correctionWarehouseMarker = L.marker([WAREHOUSE_LAT, WAREHOUSE_LNG], {
    icon: warehouseIcon,
    zIndexOffset: 100
  }).addTo(_correctionMap).bindPopup('<strong>Thakkar Medico Warehouse</strong><br>Sandesh Dawa Bazar, Ganjipeth, Nagpur');

  // Warehouse ~200m fallback buffer zone
  _correctionWarehouseCircle = L.circle([WAREHOUSE_LAT, WAREHOUSE_LNG], {
    radius: 200,
    color: '#FFB347',
    dashArray: '6, 6',
    weight: 1.5,
    fillOpacity: 0.06
  }).addTo(_correctionMap);

  // Click anywhere on map relocates pin
  _correctionMap.on('click', (e) => {
    updatePinCoordinates(e.latlng.lat, e.latlng.lng, true);
  });

  setTimeout(() => {
    if (_correctionMap) _correctionMap.invalidateSize();
  }, 200);
}

function toggleTileLayer() {
  if (!_correctionMap || !_streetTileLayer || !_satelliteTileLayer) return;
  const btn = document.getElementById('btnToggleTileLayer');
  if (_currentTileLayerType === 'streets') {
    _correctionMap.removeLayer(_streetTileLayer);
    _satelliteTileLayer.addTo(_correctionMap);
    _currentTileLayerType = 'satellite';
    if (btn) btn.innerHTML = '🗺️ Street Map';
  } else {
    _correctionMap.removeLayer(_satelliteTileLayer);
    _streetTileLayer.addTo(_correctionMap);
    _currentTileLayerType = 'streets';
    if (btn) btn.innerHTML = '🛰️ Satellite';
  }
}

async function handleMapSearch() {
  const input = document.getElementById('mapSearchInput');
  const query = (input?.value || '').trim();
  if (!query) return;

  try {
    const cleanQuery = query.toLowerCase().includes('nagpur') ? query : `${query}, Nagpur, Maharashtra, India`;
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cleanQuery)}&format=json&limit=1`;
    const res = await fetch(url, { headers: { 'User-Agent': 'ThakkarMedicoAdmin/1.0' } });
    if (!res.ok) throw new Error('Search failed');
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      const lat = parseFloat(data[0].lat);
      const lon = parseFloat(data[0].lon);
      if (Number.isFinite(lat) && Number.isFinite(lon) && _correctionMap) {
        _correctionMap.invalidateSize();
        _correctionMap.flyTo([lat, lon], 17, { animate: true, duration: 1.2 });
        showToast(`📍 Map centered on "${query}". Drag the pin to place it precisely.`, 'info');
      }
    } else {
      showToast(`No map results found for "${query}". Try adding locality (e.g. Dharampeth).`, 'warning');
    }
  } catch (err) {
    showToast('Failed to search area: ' + (err.message || 'Network error'), 'error');
  }
}

async function loadCorrectionStats() {
  try {
    // Try RPC first
    const { data: stats, error } = await sb.rpc('get_address_correction_stats');
    if (!error && stats) {
      updateStatsUI(stats);
      return;
    }
  } catch(e) {}

  // Fallback client-side stats calculation
  try {
    const [locsRes, verifiedRes, todayRes, weekRes] = await Promise.all([
      sb.from('retailer_shop_locations').select('*', { count: 'exact', head: true }),
      sb.from('retailer_shop_locations').select('*', { count: 'exact', head: true }).eq('is_verified', true).not('verified_by', 'is', null),
      sb.from('location_corrections').select('*', { count: 'exact', head: true }).gte('created_at', new Date(new Date().setHours(0,0,0,0)).toISOString()),
      sb.from('location_corrections').select('*', { count: 'exact', head: true }).gte('created_at', new Date(Date.now() - 7 * 86400 * 1000).toISOString())
    ]);

    const total = locsRes.count || 0;
    const verified = verifiedRes.count || 0;
    const pct = total > 0 ? ((verified / total) * 100).toFixed(1) : 0;
    const today = todayRes.count || 0;
    const week = weekRes.count || 0;

    updateStatsUI({
      total_locations: total,
      verified_locations: verified,
      verified_percentage: pct,
      corrections_today: today,
      corrections_this_week: week,
      fallback_flagged: _correctionLocations.filter(isFallbackLocation).length,
      needs_reverification: _correctionLocations.filter((l) => l.needs_reverification && !l.is_verified).length,
      auto_suggested: _correctionLocations.filter((l) => l.flag_reason === 'geocode_suggestion' && l.suggested_lat && !l.is_verified).length,
    });
  } catch(err) {
    console.warn('Failed to load stats:', err);
  }
}

function updateStatsUI(s) {
  const elTotal = document.getElementById('statTotalLocations');
  const elPct = document.getElementById('statVerifiedPct');
  const elVerCount = document.getElementById('statVerifiedCount');
  const elToday = document.getElementById('statTodayCorrections');
  const elWeek = document.getElementById('statWeekCorrections');
  const elFallback = document.getElementById('statFallbackFlagged');
  const elRecheck = document.getElementById('statNeedsRecheck');
  const elSuggested = document.getElementById('statAutoSuggested');
  const badgeFallback = document.getElementById('fallbackBadge');

  if (elTotal) elTotal.textContent = (s.total_locations || 0).toLocaleString('en-IN');
  if (elPct) elPct.textContent = `${s.verified_percentage || 0}%`;
  if (elVerCount) elVerCount.textContent = `${(s.verified_locations || 0).toLocaleString('en-IN')} verified`;
  if (elToday) elToday.textContent = (s.corrections_today || 0).toLocaleString('en-IN');
  if (elWeek) elWeek.textContent = (s.corrections_this_week || 0).toLocaleString('en-IN');
  if (elFallback) elFallback.textContent = (s.fallback_flagged || 0).toLocaleString('en-IN');
  if (elRecheck) elRecheck.textContent = (s.needs_reverification || 0).toLocaleString('en-IN');
  if (elSuggested) elSuggested.textContent = (s.auto_suggested || 0).toLocaleString('en-IN');

  if (badgeFallback) {
    const fbCount = (s.fallback_flagged || 0) + (s.needs_reverification || 0);
    badgeFallback.textContent = fbCount;
    badgeFallback.style.display = fbCount > 0 ? 'inline-block' : 'none';
  }
}

// Helper: fetch all shop locations in chunks of 1000 to bypass PostgREST max-rows cap
async function fetchAllShopLocations(selectCols) {
  let all = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await sb
      .from('retailer_shop_locations')
      .select(selectCols)
      .order('created_at', { ascending: false })
      .range(from, from + pageSize - 1);

    if (error) throw error;
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function fetchInFlightOrdersForAddressPortal() {
  let all = [];
  let from = 0;
  const pageSize = 1000;
  const selectCols =
    'id, status, delivery_status, delivered_at, fulfillment_mode, delivery_type, delivery_address_id, user_id, created_at, dispatched_at';

  while (true) {
    let res = await sb
      .from('orders')
      .select(selectCols)
      .in('status', IN_FLIGHT_DELIVERY_ORDER_STATUSES)
      .is('delivered_at', null)
      .order('created_at', { ascending: false })
      .range(from, from + pageSize - 1);

    if (res.error && /delivered_at/i.test(res.error.message || '')) {
      res = await sb
        .from('orders')
        .select(selectCols.replace(', delivered_at', ''))
        .in('status', IN_FLIGHT_DELIVERY_ORDER_STATUSES)
        .order('created_at', { ascending: false })
        .range(from, from + pageSize - 1);
    }

    if (res.error) throw res.error;
    const data = res.data || [];
    if (data.length === 0) break;
    all = all.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  return all.filter(isAddressPortalActiveOrder);
}

function buildAddressPortalActiveOrderIndex(activeOrders, shopLocationList) {
  const countByLocation = {};
  const latestAtByLocation = {};
  const orphanCountByRetailer = {};
  const orphanLatestByRetailer = {};

  for (const o of activeOrders) {
    const ts = String(o.dispatched_at || o.created_at || '');
    if (o.delivery_address_id) {
      const id = o.delivery_address_id;
      countByLocation[id] = (countByLocation[id] || 0) + 1;
      if (!latestAtByLocation[id] || ts > latestAtByLocation[id]) latestAtByLocation[id] = ts;
    } else if (o.user_id) {
      orphanCountByRetailer[o.user_id] = (orphanCountByRetailer[o.user_id] || 0) + 1;
      if (!orphanLatestByRetailer[o.user_id] || ts > orphanLatestByRetailer[o.user_id]) {
        orphanLatestByRetailer[o.user_id] = ts;
      }
    }
  }

  const locsByRetailer = new Map();
  for (const loc of shopLocationList || []) {
    const rid = loc.retailer_account_id;
    if (!rid) continue;
    if (!locsByRetailer.has(rid)) locsByRetailer.set(rid, []);
    locsByRetailer.get(rid).push(loc);
  }

  for (const [retailerId, count] of Object.entries(orphanCountByRetailer)) {
    const locs = locsByRetailer.get(retailerId) || [];
    if (locs.length === 0) continue;
    const target =
      locs.find((l) => l.is_default) ||
      locs.slice().sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))[0];
    if (!target?.id) continue;
    countByLocation[target.id] = (countByLocation[target.id] || 0) + count;
    const ts = orphanLatestByRetailer[retailerId] || '';
    if (!latestAtByLocation[target.id] || ts > latestAtByLocation[target.id]) {
      latestAtByLocation[target.id] = ts;
    }
  }

  return { countByLocation, latestAtByLocation };
}

let _queueRenderLimit = 250;

async function loadCorrectionLocations() {
  const container = document.getElementById('queueListContainer');
  if (container) container.innerHTML = '<div style="color:var(--text-muted);font-size:12px;text-align:center;padding:24px">Loading all retailer locations (8,700+ shops)...</div>';

  try {
    const [list, orders] = await Promise.all([
      fetchAllShopLocations(`
        id, retailer_account_id, shop_name, lat, lng, formatted_address,
        shop_no, building, street, landmark, area, city, state, pincode,
        is_default, is_verified, is_locked_by_admin, not_on_google_maps,
        needs_reverification, flag_reason, suggested_lat, suggested_lng, suggestion_confidence,
        verified_by, verified_at, receiver_name, receiver_phone, entry_notes, parking, created_at,
        retailer:profiles!retailer_shop_locations_retailer_account_id_fkey(name, business_name, phone, area, city)
      `),
      fetchInFlightOrdersForAddressPortal(),
    ]);

    const { countByLocation: activeOrderCountByLocation, latestAtByLocation: activeOrderLatestByLocation } =
      buildAddressPortalActiveOrderIndex(orders, list);

    // Augment locations with computed attributes
    _correctionLocations = list.map((loc) => {
      const activeOrderCount = activeOrderCountByLocation[loc.id] || 0;
      const activeOrderLatestAt = activeOrderLatestByLocation[loc.id] || null;
      // An address is genuinely verified only if is_verified is true AND verified_by is not null
      const isGenuinelyVerified = Boolean(loc.is_verified && loc.verified_by);
      const isFb = isFallbackLocation({ ...loc, is_verified: isGenuinelyVerified });
      return {
        ...loc,
        is_verified: isGenuinelyVerified,
        _activeOrderCount: activeOrderCount,
        _activeOrderLatestAt: activeOrderLatestAt,
        _isFallback: isFb,
      };
    });

    // Priority Sort:
    // 1. In-flight order count DESC (shops with active deliveries first)
    // 2. Fallback pins (unambiguous zeros) first
    // 3. Needs reverification (auto-detected drift) next
    // 4. Other unverified
    // 5. Verified
    _correctionLocations.sort((a, b) => {
      if (b._activeOrderCount !== a._activeOrderCount) return b._activeOrderCount - a._activeOrderCount;
      if (b._isFallback !== a._isFallback) return b._isFallback ? 1 : -1;
      if (Boolean(b.needs_reverification) !== Boolean(a.needs_reverification)) {
        return b.needs_reverification ? 1 : -1;
      }
      if (a.is_verified !== b.is_verified) return a.is_verified ? 1 : -1;
      return new Date(b.created_at || 0) - new Date(a.created_at || 0);
    });

    filterAndRenderQueue(true);
    loadCorrectionStats();
  } catch (err) {
    console.error('Failed to load queue:', err);
    if (container) container.innerHTML = `<div style="color:var(--color-error);font-size:12px;padding:20px;text-align:center">Error loading queue: ${err.message}</div>`;
    showToast('Failed to load queue locations: ' + err.message, 'error');
  }
}

function filterAndRenderQueue(autoSelectFirst = false) {
  const container = document.getElementById('queueListContainer');
  const countEl = document.getElementById('queueCount');
  if (!container) return;

  _queueRenderLimit = 250;

  _filteredCorrectionLocations = _correctionLocations.filter((loc) => {
    // 1. Filter Chip Matching
    if (_queueFilter === 'auto_suggested' && (loc.flag_reason !== 'geocode_suggestion' || !loc.suggested_lat || loc.is_verified)) return false;
    if (_queueFilter === 'needs_reverification' && !loc.needs_reverification) return false;
    if (_queueFilter === 'unverified' && loc.is_verified) return false;
    if (_queueFilter === 'active_orders' && (loc._activeOrderCount || 0) === 0) return false;
    if (_queueFilter === 'fallback' && !loc._isFallback) return false;
    if (_queueFilter === 'not_on_maps' && !loc.not_on_google_maps) return false;

    // 2. Search Text Matching
    if (_queueSearch) {
      const haystack = [
        loc.shop_name,
        loc.area,
        loc.city,
        loc.street,
        loc.building,
        loc.landmark,
        loc.retailer?.business_name,
        loc.retailer?.name,
        loc.receiver_phone,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(_queueSearch)) return false;
    }

    return true;
  });

  if (_queueFilter === 'active_orders') {
    _filteredCorrectionLocations.sort((a, b) => {
      const ta = a._activeOrderLatestAt || '';
      const tb = b._activeOrderLatestAt || '';
      if (tb !== ta) return tb.localeCompare(ta);
      return (b._activeOrderCount || 0) - (a._activeOrderCount || 0);
    });
  }

  if (countEl) countEl.textContent = _filteredCorrectionLocations.length.toLocaleString('en-IN');

  if (_filteredCorrectionLocations.length === 0) {
    container.innerHTML = `
      <div style="color:var(--text-muted);font-size:12px;text-align:center;padding:40px 16px">
        <div style="font-size:24px;margin-bottom:8px">🎉</div>
        <strong>No locations match this filter</strong>
        <p style="margin-top:4px">All items verified or try selecting a different filter.</p>
      </div>
    `;
    return;
  }

  renderQueueItemsDOM();

  // Attach infinite scroll listener to load more items on demand
  container.onscroll = () => {
    if (container.scrollTop + container.clientHeight >= container.scrollHeight - 200) {
      if (_queueRenderLimit < _filteredCorrectionLocations.length) {
        _queueRenderLimit = Math.min(_queueRenderLimit + 250, _filteredCorrectionLocations.length);
        renderQueueItemsDOM();
      }
    }
  };

  // Auto select first item if nothing selected or forced
  if (autoSelectFirst && _filteredCorrectionLocations.length > 0) {
    const currentStillValid = _selectedCorrectionLoc && _filteredCorrectionLocations.some((l) => l.id === _selectedCorrectionLoc.id);
    if (!currentStillValid) {
      selectCorrectionLocation(_filteredCorrectionLocations[0].id);
    }
  }
}

function renderQueueItemsDOM() {
  const container = document.getElementById('queueListContainer');
  if (!container) return;

  const visibleSlice = _filteredCorrectionLocations.slice(0, _queueRenderLimit);

  container.innerHTML = visibleSlice
    .map((loc) => {
      const isSelected = _selectedCorrectionLoc && _selectedCorrectionLoc.id === loc.id;
      const bName = loc.retailer?.business_name || loc.retailer?.name;

      return `
        <div class="address-queue-item ${isSelected ? 'active' : ''}" data-id="${loc.id}" onclick="selectCorrectionLocation('${loc.id}')">
          <div class="address-queue-item-top">
            <div class="address-queue-name">${loc.shop_name || bName || 'Retailer Shop'}</div>
            ${loc._activeOrderCount > 0 ? `<span class="badge-order-count">📦 ${loc._activeOrderCount} active</span>` : ''}
          </div>
          <div class="address-queue-area">
            📍 ${loc.area || loc.city || 'Nagpur'} ${loc.shop_no ? `· #${loc.shop_no}` : ''}
          </div>
          <div class="address-queue-badges">
            ${loc.flag_reason === 'geocode_suggestion' && loc.suggested_lat && !loc.is_verified ? `<span class="badge-auto-suggested">📍 Auto-suggested (${loc.suggestion_confidence || 'approx'})</span>` : ''}
            ${loc.needs_reverification ? `<span class="badge-needs-recheck">🎯 Needs Re-check (${loc.flag_reason || 'drift'})</span>` : ''}
            ${loc.is_verified ? '<span class="badge-verified">✅ Verified</span>' : '<span class="badge-not-verified">⏳ Unverified</span>'}
            ${loc._isFallback ? '<span class="badge-fallback">⚠️ Fallback Pin</span>' : ''}
            ${loc.not_on_google_maps ? '<span class="badge-not-on-maps">🚫 Not on Maps</span>' : ''}
            ${loc.is_default ? '<span style="font-size:10px;color:var(--text-muted)">Default</span>' : ''}
          </div>
        </div>
      `;
    })
    .join('') + (_queueRenderLimit < _filteredCorrectionLocations.length ? `
      <div style="text-align:center;padding:12px;color:var(--text-muted);font-size:11px">
        Showing ${_queueRenderLimit.toLocaleString('en-IN')} of ${_filteredCorrectionLocations.length.toLocaleString('en-IN')} shops. Scroll down to view more...
      </div>
    ` : '');
}

window.selectCorrectionLocation = async function (id) {
  const loc = _correctionLocations.find((l) => l.id === id);
  if (!loc) return;

  _selectedCorrectionLoc = loc;

  // Highlight in queue list
  document.querySelectorAll('.address-queue-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.id === id);
  });

  // Clear previous suggested marker
  if (_suggestedPinMarker) {
    try { _suggestedPinMarker.remove(); } catch(e) {}
    _suggestedPinMarker = null;
  }

  const isNeverVerified = !loc.is_verified || !loc.verified_by;
  const isStoredAtFallback = isFallbackLocation(loc);

  // CASE A: Location has never had a real pin (current stored coordinates are 0,0 or at warehouse fallback)
  if (isNeverVerified && isStoredAtFallback) {
    // Subcase A1: Auto-suggestion already populated (from batch job or previous on-demand geocode)
    if (loc.suggested_lat && loc.suggested_lng && Number(loc.suggested_lat) !== 0) {
      const lat = Number(loc.suggested_lat);
      const lng = Number(loc.suggested_lng);

      _originalCoord = { lat, lng };
      _currentPinCoord = { lat, lng };

      if (_correctionMap) {
        _correctionMap.invalidateSize();
        _correctionMap.setView([lat, lng], 17, { animate: true });
      }

      updatePinCoordinates(lat, lng, false);

      const banner = document.getElementById('mapFallbackBanner');
      if (banner) banner.style.display = 'none';

      renderAddressForm(loc);
      return;
    }

    // Subcase A2: Suggested lat is still null — trigger on-demand live geocode
    const lat = WAREHOUSE_LAT;
    const lng = WAREHOUSE_LNG;
    _originalCoord = { lat, lng };
    _currentPinCoord = { lat, lng };

    if (_correctionMap) {
      _correctionMap.invalidateSize();
      _correctionMap.setView([lat, lng], 15, { animate: true });
    }
    updatePinCoordinates(lat, lng, false);

    const banner = document.getElementById('mapFallbackBanner');
    if (banner) {
      banner.style.display = 'flex';
      banner.innerHTML = '🔍 Looking up address and auto-placing pin...';
    }

    renderAddressForm(loc);

    // Trigger on-demand lookup
    triggerOnDemandGeocode(loc);
    return;
  }

  // CASE B: Location has a real pin (either verified or custom placed)
  let lat = Number(loc.lat);
  let lng = Number(loc.lng);
  if (!lat || !lng || (lat === 0 && lng === 0)) {
    lat = WAREHOUSE_LAT;
    lng = WAREHOUSE_LNG;
  }

  _originalCoord = { lat: Number(loc.lat) || WAREHOUSE_LAT, lng: Number(loc.lng) || WAREHOUSE_LNG };
  _currentPinCoord = { lat, lng };

  if (_correctionMap) {
    _correctionMap.invalidateSize();
    _correctionMap.setView([lat, lng], 17, { animate: true });
  }

  updatePinCoordinates(lat, lng, false);

  // If a delivery drift suggestion exists (Case B secondary marker)
  if (loc.needs_reverification && loc.suggested_lat && loc.suggested_lng && _correctionMap && (loc.flag_reason === 'geofence_miss' || loc.flag_reason === 'large_gps_deviation')) {
    const suggDist = haversineDistMeters(lat, lng, loc.suggested_lat, loc.suggested_lng);
    const suggIcon = L.divIcon({
      className: '',
      iconSize: [34, 34],
      iconAnchor: [17, 17],
      html: `
        <div style="position:relative;width:34px;height:34px;display:flex;align-items:center;justify-content:center">
          <div style="position:absolute;width:100%;height:100%;border-radius:50%;background:rgba(0,212,255,0.25);animation:pulse-dot 1.5s infinite"></div>
          <div style="width:24px;height:24px;border-radius:50%;background:#00D4FF;border:2px solid #fff;display:flex;align-items:center;justify-content:center;font-size:12px;box-shadow:0 0 12px #00D4FF;cursor:pointer">
            🎯
          </div>
        </div>
      `,
    });

    _suggestedPinMarker = L.marker([loc.suggested_lat, loc.suggested_lng], {
      icon: suggIcon,
      zIndexOffset: 300,
    }).addTo(_correctionMap).bindPopup(`
      <div style="padding:4px">
        <strong>📍 Suggested Pin (from last delivery)</strong><br>
        <span style="font-size:11px;color:#00D4FF">Flag: <code>${loc.flag_reason || 'geofence_miss'}</code></span><br>
        <span style="font-size:11px">Distance from stored pin: <strong>${Math.round(suggDist)} m</strong></span><br>
        <button class="btn-use-suggested-pin" style="margin-top:8px" onclick="useSuggestedPin(${loc.suggested_lat}, ${loc.suggested_lng})">
          🎯 Use this pin
        </button>
      </div>
    `);
  }

  const banner = document.getElementById('mapFallbackBanner');
  if (banner) {
    banner.style.display = isFallbackLocation(loc) ? 'flex' : 'none';
    banner.innerHTML = '⚠️ Location currently at fallback warehouse pin (21.150167, 79.099140). Drag the pin or click on the map to set the actual entrance.';
  }

  renderAddressForm(loc);
};

async function safeRpc(fnName, params) {
  try {
    return await sb.rpc(fnName, params);
  } catch(e) {
    return { data: null, error: e };
  }
}

async function triggerOnDemandGeocode(loc) {
  if (!loc || loc.suggested_lat || (loc.is_verified && loc.verified_by)) return;
  const ladder = buildGeocodeQueryLadder(loc);
  if (!ladder || ladder.length === 0) {
    loc.not_on_google_maps = true;
    const chk = document.getElementById('ac_not_on_maps');
    if (chk) chk.checked = true;
    const banner = document.getElementById('mapFallbackBanner');
    if (banner) banner.innerHTML = '⚠️ Incomplete address text — please locate shop entrance manually or search area above.';
    return;
  }

  let providerError = null;

  for (const candidate of ladder) {
    const normKey = normalizeAddressForCache(candidate.query);

    // 1. Check geocoding_cache table
    try {
      const { data: cached } = await sb
        .from('geocoding_cache')
        .select('lat, lng, confidence')
        .eq('normalized_address', normKey)
        .maybeSingle();

      if (cached && cached.lat && cached.lng) {
        const distFromCity = haversineDistMeters(WAREHOUSE_LAT, WAREHOUSE_LNG, cached.lat, cached.lng);
        if (distFromCity <= 45000 && !isCityCentroidCollapse(cached.lat, cached.lng)) {
          const loggedQuery = `[${candidate.tier}] ${candidate.query}`;
          safeRpc('apply_shop_location_suggestion_v2', {
            p_location_id: loc.id,
            p_lat: cached.lat,
            p_lng: cached.lng,
            p_confidence: cached.confidence || candidate.defaultConfidence,
            p_query: loggedQuery,
            p_not_on_maps: false,
          });

          applyOnDemandGeocodeResult(loc, cached.lat, cached.lng, cached.confidence || candidate.defaultConfidence, loggedQuery);
          return;
        }
      }
    } catch(e) {}

    // 2. Live Geocode via Nominatim
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(candidate.query)}&format=json&limit=1&addressdetails=1&countrycodes=in`;
      const res = await fetch(url, { headers: { 'User-Agent': 'ThakkarMedicoAdmin/1.0' } });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          const item = data[0];
          const lat = parseFloat(item.lat);
          const lng = parseFloat(item.lon);
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            const isLow = isLowPrecisionNominatim(item);
            const isCentroid = isCityCentroidCollapse(lat, lng);
            const distFromCity = haversineDistMeters(WAREHOUSE_LAT, WAREHOUSE_LNG, lat, lng);

            if (!isLow && !isCentroid && distFromCity <= 45000) {
              const conf = (item.type || candidate.defaultConfidence).toUpperCase();
              const loggedQuery = `[${candidate.tier}] ${candidate.query}`;

              // Save cache & update DB in background
              safeRpc('save_geocoding_cache', { p_address: candidate.query, p_lat: lat, p_lng: lng, p_confidence: conf });
              safeRpc('apply_shop_location_suggestion_v2', {
                p_location_id: loc.id,
                p_lat: lat,
                p_lng: lng,
                p_confidence: conf,
                p_query: loggedQuery,
                p_not_on_maps: false,
              });

              applyOnDemandGeocodeResult(loc, lat, lng, conf, loggedQuery);
              return;
            }
          }
        }
      } else {
        providerError = `Map service status ${res.status}`;
      }
    } catch(err) {
      providerError = err.message || 'Network error';
    }

    // 3. Live Geocode via Photon fallback
    try {
      const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(candidate.query)}&limit=1`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (data.features && data.features.length > 0) {
          const feat = data.features[0];
          const [lng, lat] = feat.geometry.coordinates;
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            const isLow = isLowPrecisionPhoton(feat);
            const isCentroid = isCityCentroidCollapse(lat, lng);
            const distFromCity = haversineDistMeters(WAREHOUSE_LAT, WAREHOUSE_LNG, lat, lng);

            if (!isLow && !isCentroid && distFromCity <= 45000) {
              const conf = 'PHOTON';
              const loggedQuery = `[${candidate.tier}] ${candidate.query}`;

              safeRpc('save_geocoding_cache', { p_address: candidate.query, p_lat: lat, p_lng: lng, p_confidence: conf });
              safeRpc('apply_shop_location_suggestion_v2', {
                p_location_id: loc.id,
                p_lat: lat,
                p_lng: lng,
                p_confidence: conf,
                p_query: loggedQuery,
                p_not_on_maps: false,
              });

              applyOnDemandGeocodeResult(loc, lat, lng, conf, loggedQuery);
              return;
            }
          }
        }
      }
    } catch(err) {
      providerError = err.message || 'Network error';
    }
  }

  // If map service could not be reached
  if (providerError) {
    const banner = document.getElementById('mapFallbackBanner');
    if (banner) {
      banner.style.display = 'flex';
      banner.innerHTML = `⚠️ Couldn't reach map service (${providerError}) — please check connection or place pin manually.`;
    }
    showToast(`⚠️ Map service connection issue: ${providerError}`, 'warning');
    return;
  }

  // 4. If genuine zero results across all fallback levels
  loc.not_on_google_maps = true;
  loc.last_geocode_query = ladder[0].query;
  const chk = document.getElementById('ac_not_on_maps');
  if (chk) chk.checked = true;
  const banner = document.getElementById('mapFallbackBanner');
  if (banner) {
    banner.style.display = 'flex';
    banner.innerHTML = `⚠️ Address not found in map database (searched: "${ladder[0].query}") — please locate shop entrance manually or search area above.`;
  }
  safeRpc('apply_shop_location_suggestion_v2', {
    p_location_id: loc.id,
    p_lat: null,
    p_lng: null,
    p_confidence: null,
    p_query: ladder[0].query,
    p_not_on_maps: true,
    p_error: 'Zero results across fallback ladder',
  });
}

function applyOnDemandGeocodeResult(loc, lat, lng, confidence, query) {
  loc.suggested_lat = lat;
  loc.suggested_lng = lng;
  loc.flag_reason = 'geocode_suggestion';
  loc.suggestion_confidence = confidence;
  loc.last_geocode_query = query;
  loc.not_on_google_maps = false;

  if (_selectedCorrectionLoc && _selectedCorrectionLoc.id === loc.id) {
    _currentPinCoord = { lat, lng };
    if (_correctionMap) {
      _correctionMap.invalidateSize();
      _correctionMap.setView([lat, lng], 17, { animate: true });
    }
    updatePinCoordinates(lat, lng, false);

    const banner = document.getElementById('mapFallbackBanner');
    if (banner) banner.style.display = 'none';

    renderAddressForm(loc);
    showToast(`📍 Auto-located (${confidence}): ${query}`, 'info');
  }
}

window.useSuggestedPin = function (lat, lng) {
  if (!_correctionPinMarker) return;
  updatePinCoordinates(lat, lng, true);
  showToast('📍 Moved pin to suggested location. Click Save & Confirm to save.', 'info');
};

function updatePinCoordinates(lat, lng, panMap = false) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  _currentPinCoord = { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };

  // Custom Animated Marker Pin
  const pinIcon = L.divIcon({
    className: '',
    iconSize: [38, 48],
    iconAnchor: [19, 44],
    html: `
      <div style="width:38px;height:48px;display:flex;flex-direction:column;align-items:center;cursor:grab">
        <div style="width:34px;height:34px;background:linear-gradient(135deg,#6C63FF 0%,#00C896 100%);border:2.5px solid #fff;border-radius:50% 50% 50% 0;transform:rotate(-45deg);box-shadow:0 4px 14px rgba(108,99,255,0.5);display:flex;align-items:center;justify-content:center">
          <span style="transform:rotate(45deg);font-size:16px">📍</span>
        </div>
      </div>
    `,
  });

  if (_correctionMap) {
    if (!_correctionPinMarker) {
      _correctionPinMarker = L.marker([lat, lng], {
        icon: pinIcon,
        draggable: true,
        zIndexOffset: 500,
      }).addTo(_correctionMap);

      _correctionPinMarker.on('drag', (e) => {
        const pos = e.target.getLatLng();
        _currentPinCoord = { lat: Number(pos.lat.toFixed(6)), lng: Number(pos.lng.toFixed(6)) };
        updateDistanceReadout();
      });

      _correctionPinMarker.on('dragend', (e) => {
        const pos = e.target.getLatLng();
        _currentPinCoord = { lat: Number(pos.lat.toFixed(6)), lng: Number(pos.lng.toFixed(6)) };
        updateDistanceReadout();
      });
    } else {
      _correctionPinMarker.setLatLng([lat, lng]);
      if (!_correctionMap.hasLayer(_correctionPinMarker)) {
        _correctionPinMarker.addTo(_correctionMap);
      }
    }

    if (panMap) {
      _correctionMap.panTo([lat, lng], { animate: true, duration: 0.5 });
    }
  }

  updateDistanceReadout();
}

function updateDistanceReadout() {
  const elLat = document.getElementById('readoutLat');
  const elLng = document.getElementById('readoutLng');
  const elDist = document.getElementById('distanceMovedReadout');
  const coordText = document.getElementById('formCoordsText');
  const gmapsLink = document.getElementById('formGoogleMapsLink');

  if (!_currentPinCoord) return;

  if (elLat) elLat.textContent = _currentPinCoord.lat.toFixed(6);
  if (elLng) elLng.textContent = _currentPinCoord.lng.toFixed(6);
  if (coordText) coordText.textContent = `${_currentPinCoord.lat.toFixed(6)}, ${_currentPinCoord.lng.toFixed(6)}`;
  if (gmapsLink) {
    gmapsLink.href = `https://www.google.com/maps?q=${_currentPinCoord.lat},${_currentPinCoord.lng}`;
  }

  if (_originalCoord && elDist) {
    const dist = haversineDistMeters(_originalCoord.lat, _originalCoord.lng, _currentPinCoord.lat, _currentPinCoord.lng);
    if (dist < 5) {
      elDist.className = 'distance-moved-badge';
      elDist.textContent = '📏 Original Position';
    } else {
      elDist.className = 'distance-moved-badge warning';
      const txt = dist >= 1000 ? `${(dist / 1000).toFixed(2)} km` : `${Math.round(dist)} m`;
      elDist.textContent = `📏 Moved: ${txt} from original`;
    }
  }
}

function resetPinToOriginal() {
  if (!_originalCoord) return;
  updatePinCoordinates(_originalCoord.lat, _originalCoord.lng, true);
  if (_correctionMap) _correctionMap.flyTo([_originalCoord.lat, _originalCoord.lng], 17);
  showToast('Pin reset to original stored coordinate', 'info');
}

function renderAddressForm(loc) {
  const formBody = document.getElementById('addressFormBody');
  const badge = document.getElementById('formVerifiedBadge');
  const saveBtn = document.getElementById('btnSaveAddress');
  if (!formBody) return;

  if (badge) {
    if (loc.needs_reverification) {
      badge.className = 'badge badge-error';
      badge.textContent = `Needs Re-check 🎯 (${loc.flag_reason || 'drift'})`;
    } else if (loc.flag_reason === 'geocode_suggestion' && loc.suggested_lat && !loc.is_verified) {
      badge.className = 'badge badge-info';
      badge.textContent = `Auto-suggested 📍 (${loc.suggestion_confidence || 'approx'})`;
    } else {
      badge.className = loc.is_verified ? 'badge badge-success' : 'badge badge-warning';
      badge.textContent = loc.is_verified ? 'Verified ✅' : 'Unverified ⏳';
    }
  }

  if (saveBtn) saveBtn.disabled = false;

  const latStr = _currentPinCoord?.lat ? _currentPinCoord.lat.toFixed(6) : (loc.lat || WAREHOUSE_LAT).toFixed(6);
  const lngStr = _currentPinCoord?.lng ? _currentPinCoord.lng.toFixed(6) : (loc.lng || WAREHOUSE_LNG).toFixed(6);

  let bannerHtml = '';
  // Case A auto-suggest banner
  if (loc.flag_reason === 'geocode_suggestion' && loc.suggested_lat && !loc.is_verified) {
    const conf = (loc.suggestion_confidence || 'approximate').toLowerCase();
    const queryDisplay = loc.last_geocode_query ? `Searched: <code style="color:#E0E0FF">${loc.last_geocode_query}</code>` : 'Pre-geocoded from address. Drag pin to adjust or click Save & Confirm to verify.';
    bannerHtml = `
      <div class="auto-suggest-banner">
        <div>
          <div style="font-size:11px;font-weight:700;color:#B388FF;display:flex;align-items:center;gap:6px">
            <span>📍 Auto-placed Pin</span>
            <span class="confidence-pill ${conf}">${conf}</span>
          </div>
          <div style="font-size:10px;color:var(--text-secondary);margin-top:3px;word-break:break-word">
            ${queryDisplay}
          </div>
        </div>
      </div>
    `;
  } else if (loc.needs_reverification && loc.suggested_lat && loc.suggested_lng && (loc.flag_reason === 'geofence_miss' || loc.flag_reason === 'large_gps_deviation')) {
    // Case B delivery drift banner
    const distFromCurrent = haversineDistMeters(Number(latStr), Number(lngStr), loc.suggested_lat, loc.suggested_lng);
    bannerHtml = `
      <div class="suggested-pin-banner">
        <div>
          <div style="font-size:11px;font-weight:700;color:#00D4FF">🎯 Delivery Outcome Flag (${loc.flag_reason})</div>
          <div style="font-size:10px;color:var(--text-secondary)">Rider completed drop at ${loc.suggested_lat.toFixed(6)}, ${loc.suggested_lng.toFixed(6)} (${Math.round(distFromCurrent)}m away)</div>
        </div>
        <button type="button" class="btn-use-suggested-pin" onclick="useSuggestedPin(${loc.suggested_lat}, ${loc.suggested_lng})">
          Use Suggested Pin
        </button>
      </div>
    `;
  }

  formBody.innerHTML = `
    <!-- Coordinates Quick Preview Bar -->
    <div class="address-coords-preview">
      <div>
        <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;font-weight:700">Pin GPS Coordinates</div>
        <div class="address-coords-text" id="formCoordsText">${latStr}, ${lngStr}</div>
      </div>
      <div style="display:flex;gap:6px">
        <button type="button" class="btn btn-secondary" style="padding:4px 8px;font-size:11px" onclick="copyCoordinates('${latStr}','${lngStr}')" title="Copy coords">📋 Copy</button>
        <a id="formGoogleMapsLink" href="https://www.google.com/maps?q=${latStr},${lngStr}" target="_blank" class="btn btn-secondary" style="padding:4px 8px;font-size:11px;text-decoration:none" title="Open in Google Maps">Maps ↗</a>
      </div>
    </div>

    ${bannerHtml}

    ${loc.is_verified && loc.verified_by && !loc.needs_reverification ? `
      <div style="background:rgba(0,200,150,0.08);border:1px solid rgba(0,200,150,0.25);border-radius:var(--radius-sm);padding:10px 14px;display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px">
        <div>
          <div style="font-weight:700;color:var(--color-success);font-size:11px">🔒 Verified & Locked</div>
          <div style="font-size:10px;color:var(--text-secondary)">Verified by admin on ${fmtDateTime(loc.verified_at || loc.created_at)}</div>
        </div>
        <button type="button" class="btn btn-secondary" style="padding:6px 12px;font-size:11px;font-weight:700;border-color:rgba(255,179,71,0.5);color:#FFB347" onclick="handleUnlockLocation('${loc.id}')">
          🔓 Unlock for Editing
        </button>
      </div>
    ` : ''}

    <!-- Shop Name & Basic Identification -->
    <div class="address-form-section-title">Shop Details</div>
    <div class="address-field">
      <label class="address-label">Shop / Business Name *</label>
      <input type="text" class="address-input" id="ac_shop_name" value="${(loc.shop_name || loc.retailer?.business_name || '').replace(/"/g, '&quot;')}" required>
    </div>

    <!-- Structured Location Fields -->
    <div class="address-form-section-title">Address & Physical Location</div>
    <div class="address-form-grid-2">
      <div class="address-field">
        <label class="address-label">Shop / Unit No.</label>
        <input type="text" class="address-input" id="ac_shop_no" value="${(loc.shop_no || '').replace(/"/g, '&quot;')}" placeholder="e.g. Shop 12">
      </div>
      <div class="address-field">
        <label class="address-label">Building / Complex</label>
        <input type="text" class="address-input" id="ac_building" value="${(loc.building || '').replace(/"/g, '&quot;')}" placeholder="e.g. Dawa Bazar">
      </div>
    </div>

    <div class="address-field">
      <label class="address-label">Street / Road</label>
      <input type="text" class="address-input" id="ac_street" value="${(loc.street || '').replace(/"/g, '&quot;')}" placeholder="e.g. Central Avenue">
    </div>

    <div class="address-field">
      <label class="address-label" style="color:var(--color-warning)">Landmark * (Crucial for delivery riders)</label>
      <input type="text" class="address-input" id="ac_landmark" value="${(loc.landmark || '').replace(/"/g, '&quot;')}" placeholder="e.g. Near City Hospital">
    </div>

    <div class="address-form-grid-2">
      <div class="address-field">
        <label class="address-label">Area / Locality *</label>
        <input type="text" class="address-input" id="ac_area" value="${(loc.area || '').replace(/"/g, '&quot;')}" required placeholder="e.g. Gandhibagh">
      </div>
      <div class="address-field">
        <label class="address-label">City *</label>
        <input type="text" class="address-input" id="ac_city" value="${(loc.city || 'Nagpur').replace(/"/g, '&quot;')}" required>
      </div>
    </div>

    <div class="address-form-grid-2">
      <div class="address-field">
        <label class="address-label">State</label>
        <input type="text" class="address-input" id="ac_state" value="${(loc.state || 'Maharashtra').replace(/"/g, '&quot;')}">
      </div>
      <div class="address-field">
        <label class="address-label">PIN Code</label>
        <input type="text" class="address-input" id="ac_pincode" value="${(loc.pincode || '440002').replace(/"/g, '&quot;')}" maxlength="6">
      </div>
    </div>

    <div class="address-field">
      <label class="address-label">Full Formatted Address</label>
      <input type="text" class="address-input" id="ac_formatted_address" value="${(loc.formatted_address || '').replace(/"/g, '&quot;')}" placeholder="Complete address string">
    </div>

    <!-- Contact & Operations -->
    <div class="address-form-section-title">Receiver Contact & Operations</div>
    <div class="address-form-grid-2">
      <div class="address-field">
        <label class="address-label">Receiver Name</label>
        <input type="text" class="address-input" id="ac_receiver_name" value="${(loc.receiver_name || loc.retailer?.name || '').replace(/"/g, '&quot;')}">
      </div>
      <div class="address-field">
        <label class="address-label">Receiver Phone</label>
        <input type="text" class="address-input" id="ac_receiver_phone" value="${(loc.receiver_phone || loc.retailer?.phone || '').replace(/"/g, '&quot;')}" maxlength="10">
      </div>
    </div>

    <div class="address-form-grid-2">
      <div class="address-field">
        <label class="address-label">Parking Access</label>
        <select class="form-select" id="ac_parking" style="font-size:13px;padding:8px">
          <option value="" ${!loc.parking ? 'selected' : ''}>Not specified</option>
          <option value="yes" ${loc.parking === 'yes' ? 'selected' : ''}>Dedicated parking</option>
          <option value="street" ${loc.parking === 'street' ? 'selected' : ''}>Street parking only</option>
          <option value="no" ${loc.parking === 'no' ? 'selected' : ''}>No parking (narrow lane)</option>
        </select>
      </div>
      <div class="address-field">
        <label class="address-label">Loading / Entry Notes</label>
        <input type="text" class="address-input" id="ac_entry_notes" value="${(loc.entry_notes || '').replace(/"/g, '&quot;')}" placeholder="e.g. 1st floor rear gate">
      </div>
    </div>

    <!-- Flags & Verification Notes -->
    <div class="address-form-section-title">Flags & Audit Trail</div>
    <label class="address-checkbox-row">
      <input type="checkbox" id="ac_not_on_maps" ${loc.not_on_google_maps ? 'checked' : ''}>
      <span class="address-checkbox-label">🚫 Not findable on Google Maps (manual entrance only)</span>
    </label>

    <div class="address-field">
      <label class="address-label">Correction Notes (Logged in location_corrections audit)</label>
      <textarea class="address-textarea" id="ac_notes" placeholder="e.g. Pin adjusted 450m East to actual shop entrance in Gandhibagh market near temple."></textarea>
    </div>
  `;
}

window.handleUnlockLocation = async function (id) {
  const loc = _correctionLocations.find((l) => l.id === id);
  if (!loc) return;

  const reason = prompt('Please enter the reason for unlocking this verified location (e.g. shop relocated, new entrance, corrected landmark):');
  if (reason === null) return; // user cancelled
  const cleanReason = reason.trim() || 'Admin requested re-edit';

  try {
    showToast('Unlocking location for re-editing...', 'info');
    const { error } = await sb.rpc('unlock_shop_location_for_editing', {
      p_location_id: id,
      p_reason: cleanReason,
    });

    if (error) throw error;

    loc.is_verified = false;
    loc.verified_by = null;
    loc.verified_at = null;
    loc.is_locked_by_admin = false;
    loc.flag_reason = 'admin_unlock';

    selectCorrectionLocation(id);
    loadCorrectionStats();
    showToast('🔓 Location unlocked. Drag pin to adjust entrance and click Save & Confirm.', 'success');
  } catch (err) {
    showToast('Failed to unlock location: ' + err.message, 'error');
  }
};

window.copyCoordinates = function (lat, lng) {
  navigator.clipboard.writeText(`${lat}, ${lng}`).then(() => {
    showToast(`Copied coordinates: ${lat}, ${lng}`, 'success');
  }).catch(() => {
    showToast('Failed to copy coordinates', 'error');
  });
};

async function handleSaveCorrection() {
  if (!_selectedCorrectionLoc || !_currentPinCoord) {
    showToast('No location selected to save', 'warning');
    return;
  }

  const loc = _selectedCorrectionLoc;
  const saveBtn = document.getElementById('btnSaveAddress');

  const shopName = document.getElementById('ac_shop_name')?.value.trim();
  const shopNo = document.getElementById('ac_shop_no')?.value.trim();
  const building = document.getElementById('ac_building')?.value.trim();
  const street = document.getElementById('ac_street')?.value.trim();
  const landmark = document.getElementById('ac_landmark')?.value.trim();
  const area = document.getElementById('ac_area')?.value.trim();
  const city = document.getElementById('ac_city')?.value.trim();
  const state = document.getElementById('ac_state')?.value.trim() || 'Maharashtra';
  const pincode = document.getElementById('ac_pincode')?.value.trim() || '440002';
  let formattedAddress = document.getElementById('ac_formatted_address')?.value.trim();
  const receiverName = document.getElementById('ac_receiver_name')?.value.trim();
  const receiverPhone = document.getElementById('ac_receiver_phone')?.value.trim();
  const parking = document.getElementById('ac_parking')?.value;
  const entryNotes = document.getElementById('ac_entry_notes')?.value.trim();
  const notOnMaps = document.getElementById('ac_not_on_maps')?.checked || false;
  const correctionNotes = document.getElementById('ac_notes')?.value.trim();

  if (!shopName) {
    showToast('Shop / Business Name is required', 'warning');
    return;
  }
  if (!area || !city) {
    showToast('Area and City are required', 'warning');
    return;
  }

  if (!formattedAddress) {
    formattedAddress = [shopNo, building, street, landmark, area, city, pincode].filter(Boolean).join(', ');
  }

  const newLat = _currentPinCoord.lat;
  const newLng = _currentPinCoord.lng;
  const distMoved = haversineDistMeters(loc.lat, loc.lng, newLat, newLng);

  try {
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<span class="spinner"></span> Saving & Verifying...';
    }

    // 1. Call existing self-healing RPC
    try {
      await sb.rpc('update_shop_location_coordinates', {
        p_location_id: loc.id,
        p_lat: newLat,
        p_lng: newLng,
      });
    } catch (e) {
      console.warn('RPC update_shop_location_coordinates warning:', e);
    }

    // 2. Update structured address fields, clear drift flags & set verification metadata
    const updatePayload = {
      shop_name: shopName,
      shop_no: shopNo || 'N/A',
      building: building || 'N/A',
      street: street || null,
      landmark: landmark || 'N/A',
      area: area,
      city: city,
      state: state,
      pincode: pincode,
      formatted_address: formattedAddress,
      receiver_name: receiverName || 'Owner',
      receiver_phone: receiverPhone || 'N/A',
      entry_notes: entryNotes || null,
      parking: parking || null,
      not_on_google_maps: notOnMaps,
      needs_reverification: false,
      flag_reason: null,
      suggested_lat: null,
      suggested_lng: null,
      suggestion_confidence: null,
      is_verified: true,
      verified_by: currentProfile?.id || null,
      verified_at: new Date().toISOString(),
    };

    const { error: updateErr } = await sb
      .from('retailer_shop_locations')
      .update(updatePayload)
      .eq('id', loc.id);

    if (updateErr) throw updateErr;

    // 3. Log audit row in public.location_corrections
    try {
      await sb.from('location_corrections').insert({
        shop_location_id: loc.id,
        retailer_account_id: loc.retailer_account_id || null,
        corrected_by: currentProfile?.id || null,
        old_lat: loc.lat,
        old_lng: loc.lng,
        new_lat: newLat,
        new_lng: newLng,
        distance_moved_meters: distMoved,
        old_address: {
          shop_name: loc.shop_name,
          shop_no: loc.shop_no,
          building: loc.building,
          street: loc.street,
          landmark: loc.landmark,
          area: loc.area,
          city: loc.city,
          pincode: loc.pincode,
          formatted_address: loc.formatted_address,
        },
        new_address: {
          shop_name: shopName,
          shop_no: shopNo,
          building: building,
          street: street,
          landmark: landmark,
          area: area,
          city: city,
          pincode: pincode,
          formatted_address: formattedAddress,
        },
        notes: correctionNotes || null,
        not_on_google_maps: notOnMaps,
      });
    } catch (auditErr) {
      console.warn('Could not insert location_corrections audit row:', auditErr);
    }

    // 4. Update in-flight active orders for this retailer location
    try {
      const { data: openOrders } = await sb
        .from('orders')
        .select('id')
        .eq('delivery_address_id', loc.id)
        .not('delivery_status', 'in', '("delivered","failed","cancelled")');

      if (openOrders && openOrders.length > 0) {
        for (const ord of openOrders) {
          await sb.rpc('update_order_delivery_coordinates', {
            p_order_id: ord.id,
            p_lat: newLat,
            p_lng: newLng,
          }).catch(() => {});
        }
      }
    } catch (orderErr) {
      console.warn('In-flight order update warning:', orderErr);
    }

    // 5. Update local cache
    loc.lat = newLat;
    loc.lng = newLng;
    loc.shop_name = shopName;
    loc.shop_no = shopNo;
    loc.building = building;
    loc.street = street;
    loc.landmark = landmark;
    loc.area = area;
    loc.city = city;
    loc.state = state;
    loc.pincode = pincode;
    loc.formatted_address = formattedAddress;
    loc.receiver_name = receiverName;
    loc.receiver_phone = receiverPhone;
    loc.entry_notes = entryNotes;
    loc.parking = parking;
    loc.not_on_google_maps = notOnMaps;
    loc.needs_reverification = false;
    loc.flag_reason = null;
    loc.suggested_lat = null;
    loc.suggested_lng = null;
    loc.is_verified = true;
    loc.verified_at = new Date().toISOString();
    loc._isFallback = isFallbackLocation(loc);

    if (_suggestedPinMarker) {
      try { _suggestedPinMarker.remove(); } catch(e) {}
      _suggestedPinMarker = null;
    }

    showToast(`✅ Saved & verified coordinates for "${shopName}"!`, 'success');

    // 6. Refresh Stats & Queue View
    loadCorrectionStats();
    filterAndRenderQueue(false);

    // 7. Auto-advance to next unverified location
    advanceToNextUnverified();
  } catch (err) {
    showToast('Failed to save correction: ' + (err.message || 'Unknown error'), 'error');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = '💾 Save & Confirm Coordinates';
    }
  }
}

function advanceToNextUnverified() {
  if (_filteredCorrectionLocations.length === 0) return;

  const currentIdx = _selectedCorrectionLoc
    ? _filteredCorrectionLocations.findIndex((l) => l.id === _selectedCorrectionLoc.id)
    : -1;

  // Search forward from current index
  let nextLoc = null;
  for (let i = currentIdx + 1; i < _filteredCorrectionLocations.length; i++) {
    if (!_filteredCorrectionLocations[i].is_verified) {
      nextLoc = _filteredCorrectionLocations[i];
      break;
    }
  }

  // Wrap around from beginning if not found
  if (!nextLoc) {
    for (let i = 0; i <= currentIdx && i < _filteredCorrectionLocations.length; i++) {
      if (!_filteredCorrectionLocations[i].is_verified) {
        nextLoc = _filteredCorrectionLocations[i];
        break;
      }
    }
  }

  if (nextLoc) {
    selectCorrectionLocation(nextLoc.id);
    const itemEl = document.querySelector(`.address-queue-item[data-id="${nextLoc.id}"]`);
    if (itemEl) itemEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } else {
    showToast('🎉 All locations in the current queue are verified!', 'success');
  }
}

// ============================================================
// POS BILLING PAGE
// ============================================================

function posProductHasScheme(p) {
  return (Number(p?.scheme_buy_qty) || 0) > 0 && (Number(p?.scheme_free_qty) || 0) > 0;
}

function posCartStockLimit(item) {
  return item.stock_quantity != null ? Number(item.stock_quantity) : 999999;
}

function posCartUnitsUsed(item) {
  return (Number(item.quantity) || 0) + (Number(item.free_quantity) || 0);
}

function posClampCartItem(item, opts = {}) {
  const stock = posCartStockLimit(item);
  let q = Math.max(1, parseInt(item.quantity, 10) || 1);
  let f = Math.max(0, parseInt(item.free_quantity, 10) || 0);
  if (q + f > stock) {
    if (opts.preferFree && q <= stock) {
      f = Math.max(0, stock - q);
    } else if (q > stock) {
      q = Math.max(1, stock);
      f = 0;
    } else {
      f = Math.max(0, stock - q);
    }
    if (opts.toastOnTrim) {
      showToast(`Stock limit ${stock}: adjusted paid + free units`, 'warning');
    }
  }
  item.quantity = q;
  item.free_quantity = f;
}

async function renderPOS() {
  _posState = {
    retailer: null,
    cart: [],
    fulfillment: 'pickup',
    payment: 'cod',
    redeemPoints: false,
    notes: '',
    searchMode: 'name' // 'name' or 'code'
  };

  pageContent.innerHTML = `
    <div class="pos-container">
      <div>
        <!-- Retailer Search with Party Code Toggle -->
        <div class="section-card mb-2">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;gap:8px">
            <h4 style="font-size:14px;font-weight:700;margin:0">👤 Select Retailer</h4>
            <div class="pos-search-mode-toggle" style="display:flex;background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:8px;padding:3px;gap:4px">
              <button type="button" id="posModeName" class="btn-pos-mode active" style="padding:4px 10px;font-size:11px;font-weight:700;border:none;border-radius:6px;cursor:pointer;background:var(--color-primary);color:#fff" onclick="setPosSearchMode('name')">
                🔍 Name / Phone
              </button>
              <button type="button" id="posModeCode" class="btn-pos-mode" style="padding:4px 10px;font-size:11px;font-weight:700;border:none;border-radius:6px;cursor:pointer;background:transparent;color:var(--text-muted)" onclick="setPosSearchMode('code')">
                🏷️ Party Code
              </button>
            </div>
          </div>

          <div class="search-dropdown-wrap">
            <input type="text" class="form-input" id="posRetailerSearch" placeholder="Search by shop name, contact, or phone..." style="margin:0">
            <div class="search-dropdown-list hidden" id="posRetailerDropdown" style="max-height:300px;overflow-y:auto"></div>
          </div>
          <div id="posSelectedRetailer" style="margin-top:10px"></div>
        </div>

        <!-- Product Search -->
        <div class="section-card mb-2">
          <h4 style="font-size:14px;font-weight:700;margin-bottom:8px">💊 Add Products</h4>
          <div class="search-dropdown-wrap">
            <input type="text" class="form-input" id="posProductSearch" placeholder="Search products by name or generic..." style="margin:0">
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
          <select class="form-select" id="posFulfillment"><option value="pickup">Counter Pickup</option><option value="delivery">Delivery</option></select>
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

window.setPosSearchMode = function(mode) {
  _posState.searchMode = mode;
  const btnName = document.getElementById('posModeName');
  const btnCode = document.getElementById('posModeCode');
  const input = document.getElementById('posRetailerSearch');

  if (mode === 'code') {
    if (btnName) { btnName.style.background = 'transparent'; btnName.style.color = 'var(--text-muted)'; }
    if (btnCode) { btnCode.style.background = 'var(--color-primary)'; btnCode.style.color = '#fff'; }
    if (input) {
      input.placeholder = '🏷️ Enter Party Code (e.g. TM-104, RC001, 104)...';
      input.focus();
    }
  } else {
    if (btnCode) { btnCode.style.background = 'transparent'; btnCode.style.color = 'var(--text-muted)'; }
    if (btnName) { btnName.style.background = 'var(--color-primary)'; btnName.style.color = '#fff'; }
    if (input) {
      input.placeholder = '🔍 Search by shop name, contact, or phone...';
      input.focus();
    }
  }

  if (input && input.value.trim().length >= 1) {
    searchPosRetailers(input.value.trim());
  }
};

async function searchPosRetailers(q) {
  const dd = document.getElementById('posRetailerDropdown');
  if (!dd) return;
  const cleanQ = (q || '').trim();
  if (!cleanQ || cleanQ.length < 1) { dd.classList.add('hidden'); return; }

  let query = sb.from('profiles')
    .select('id, name, business_name, phone, gstin, address, area, city, state, pincode, retailer_code, credit_limit, credit_used, loyalty_points')
    .eq('role', 'retailer');

  if (_posState.searchMode === 'code') {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanQ);
    if (isUuid) {
      query = query.or(`retailer_code.ilike.%${cleanQ}%,id.eq.${cleanQ}`);
    } else {
      query = query.ilike('retailer_code', `%${cleanQ}%`);
    }
  } else {
    query = query.or(`business_name.ilike.%${cleanQ}%,name.ilike.%${cleanQ}%,phone.ilike.%${cleanQ}%,gstin.ilike.%${cleanQ}%,address.ilike.%${cleanQ}%,area.ilike.%${cleanQ}%,retailer_code.ilike.%${cleanQ}%`);
  }

  const { data, error } = await query.limit(12);
  if (error || !data || data.length === 0) {
    dd.classList.remove('hidden');
    dd.innerHTML = `<div style="padding:12px;text-align:center;font-size:12px;color:var(--text-muted)">No retailers matching "${cleanQ}" found</div>`;
    return;
  }

  dd.classList.remove('hidden');
  dd.innerHTML = data.map(r => {
    const combinedAddr = [r.address, r.area, r.city, r.pincode].filter(Boolean).join(', ') || 'No address registered';
    const partyId = r.retailer_code || r.id.slice(0, 8);
    const escaped = JSON.stringify(r).replace(/"/g, '&quot;');

    return `
      <div class="search-dropdown-item" style="padding:10px 12px;border-bottom:1px solid var(--border-subtle);cursor:pointer" onclick="selectPosRetailer(${escaped})">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
          <h5 style="font-size:13px;font-weight:700;color:var(--text-primary);margin:0">
            ${r.business_name || r.name}
            ${r.name && r.name !== r.business_name ? `<span style="font-weight:500;font-size:11.5px;color:var(--text-muted)">(${r.name})</span>` : ''}
          </h5>
          <span class="badge" style="background:rgba(108,99,255,0.18);color:var(--color-primary);font-size:10.5px;font-weight:800;padding:2px 7px;border-radius:6px;border:1px solid rgba(108,99,255,0.3);flex-shrink:0">
            🏷️ Party: ${partyId}
          </span>
        </div>
        <div style="font-size:11.5px;color:var(--text-secondary);margin-top:3px;display:flex;align-items:center;gap:4px">
          <span>📍 ${combinedAddr}</span>
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:3px;display:flex;gap:12px;flex-wrap:wrap">
          <span>📱 ${r.phone || '—'}</span>
          ${r.gstin ? `<span>📄 GST: ${r.gstin}</span>` : ''}
          <span>💳 Credit: ${fmtCurrency(r.credit_limit || 0)}</span>
          <span>⭐ ${r.loyalty_points || 0} pts</span>
        </div>
      </div>
    `;
  }).join('');
}

window.selectPosRetailer = function(r) {
  _posState.retailer = r;
  const dd = document.getElementById('posRetailerDropdown');
  if (dd) dd.classList.add('hidden');
  const searchInput = document.getElementById('posRetailerSearch');
  if (searchInput) searchInput.value = '';

  const combinedAddr = [r.address, r.area, r.city, r.pincode].filter(Boolean).join(', ') || 'No registered address';
  const partyId = r.retailer_code || r.id.slice(0, 8);
  const availableCredit = Math.max(0, (r.credit_limit || 0) - (r.credit_used || 0));

  document.getElementById('posSelectedRetailer').innerHTML = `
    <div style="background:var(--bg-surface);border:1px solid var(--border-subtle);border-left:4px solid var(--color-primary);padding:12px 14px;border-radius:10px;display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
      <div style="flex:1">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <strong style="font-size:14px;color:var(--text-primary)">${r.business_name || r.name}</strong>
          ${r.name && r.name !== r.business_name ? `<span style="font-size:12px;color:var(--text-muted)">(${r.name})</span>` : ''}
          <span class="badge" style="background:rgba(108,99,255,0.18);color:var(--color-primary);font-size:11px;font-weight:800;padding:2px 8px;border-radius:6px;border:1px solid rgba(108,99,255,0.3)">
            🏷️ Party ID: ${partyId}
          </span>
        </div>
        <div style="font-size:12px;color:var(--text-secondary);margin-top:4px">
          📍 <strong>Combined Address:</strong> ${combinedAddr}
        </div>
        <div style="display:flex;gap:12px;font-size:11px;color:var(--text-muted);margin-top:5px;flex-wrap:wrap">
          <span>📱 Phone: <strong>${r.phone || '—'}</strong></span>
          <span>💳 Available Credit: <strong>${fmtCurrency(availableCredit)}</strong> / ${fmtCurrency(r.credit_limit || 0)}</span>
          <span>⭐ Loyalty: <strong>${r.loyalty_points || 0} pts</strong></span>
        </div>
      </div>
      <button class="btn btn-danger" style="padding:4px 8px;font-size:11px;border-radius:6px" onclick="_posState.retailer=null;this.closest('#posSelectedRetailer').innerHTML='';updatePosSummary()" title="Remove selected retailer">✕</button>
    </div>
  `;
  updatePosSummary();
};

async function searchPosProducts(q) {
  const dd = document.getElementById('posProductDropdown');
  if (!dd) return;
  const cleanQ = (q || '').trim();
  if (!cleanQ || cleanQ.length < 2) { dd.classList.add('hidden'); return; }

  const { data } = await sb.from('products')
    .select('id, name, company, category, sku, barcode_sku, selling_price, mrp, gst_percent, stock_quantity, pack_size, scheme_buy_qty, scheme_free_qty')
    .eq('is_active', true)
    .gt('selling_price', 0)
    .gt('stock_quantity', 0)
    .or(`name.ilike.%${cleanQ}%,sku.ilike.%${cleanQ}%,barcode_sku.ilike.%${cleanQ}%,company.ilike.%${cleanQ}%,category.ilike.%${cleanQ}%`)
    .limit(12);
  if (!data || data.length === 0) {
    dd.classList.remove('hidden');
    dd.innerHTML = `<div style="padding:12px;text-align:center;font-size:12px;color:var(--text-muted)">No active products matching "${cleanQ}" found</div>`;
    return;
  }

  dd.classList.remove('hidden');
  dd.innerHTML = data.map(p => {
    const skuCode = p.sku || p.barcode_sku || '';
    const schemeLabel = posProductHasScheme(p) ? `<span style="color:var(--color-success);font-weight:700">🎁 ${p.scheme_buy_qty}+${p.scheme_free_qty} scheme</span>` : '';
    return `
      <div class="search-dropdown-item" style="padding:8px 12px;border-bottom:1px solid var(--border-subtle);cursor:pointer" onclick='addPosProduct(${JSON.stringify(p).replace(/'/g,"\\'")})'>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <h5 style="margin:0;font-size:13px;font-weight:700">${p.name}</h5>
          <span style="font-weight:800;color:var(--color-primary);font-size:13px">${fmtCurrency(p.selling_price)}</span>
        </div>
        <p style="margin:3px 0 0 0;font-size:11.5px;color:var(--text-muted);display:flex;gap:8px;flex-wrap:wrap">
          ${p.company ? `<span>🏢 ${p.company}</span>` : ''}
          ${skuCode ? `<span>🏷️ SKU: ${skuCode}</span>` : ''}
          <span>📦 Stock: ${p.stock_quantity || 0}</span>
          ${p.pack_size ? `<span>(${p.pack_size})</span>` : ''}
          ${schemeLabel}
        </p>
      </div>
    `;
  }).join('');
}

window.addPosProduct = function(p) {
  document.getElementById('posProductDropdown')?.classList.add('hidden');
  document.getElementById('posProductSearch').value = '';

  if ((p.selling_price || 0) <= 0 || (p.stock_quantity || 0) <= 0) {
    showToast('Cannot add out-of-stock or 0-price product', 'warning');
    return;
  }

  const existing = _posState.cart.find(c => c.id === p.id);
  const stock = posCartStockLimit(p);
  if (existing) {
    if (posCartUnitsUsed(existing) >= stock) {
      showToast(`Only ${stock} units available in stock (paid + free)`, 'warning');
      return;
    }
    existing.quantity++;
    posClampCartItem(existing);
  } else {
    _posState.cart.push({ ...p, quantity: 1, free_quantity: 0 });
  }
  renderPosCart();
  updatePosSummary();
};

function renderPosCart() {
  const el = document.getElementById('posCartList');
  if (!el) return;
  if (_posState.cart.length === 0) { el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:20px;text-align:center">No items in cart</div>'; return; }

  el.innerHTML = _posState.cart.map((item, i) => {
    const freeQty = Number(item.free_quantity) || 0;
    const linePaid = fmtCurrency(item.selling_price * item.quantity);
    const freeLine = freeQty > 0 ? ` · <span style="color:var(--color-success);font-weight:700">+ ${freeQty} FREE</span>` : '';
    const schemeHint = posProductHasScheme(item)
      ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px">Scheme: buy ${item.scheme_buy_qty} get ${item.scheme_free_qty} free (optional)</div>`
      : '';
    const freeControls = posProductHasScheme(item) ? `
      <div class="cart-item-free-row">
        <span style="font-size:11px;font-weight:600;color:var(--text-secondary)">Free qty</span>
        <div class="cart-item-qty-btn" onclick="updatePosFreeQty(${i},-1)">−</div>
        <input type="number" min="0" class="cart-item-free-input" value="${freeQty}"
          onchange="setPosFreeQty(${i}, this.value)" onkeydown="if(event.key==='Enter'){this.blur()}">
        <div class="cart-item-qty-btn" onclick="updatePosFreeQty(${i},1)">+</div>
      </div>` : '';

    return `
    <div class="cart-item-row" style="flex-wrap:wrap;align-items:flex-start">
      <div class="cart-item-info">
        <div style="font-weight:600;font-size:13px">${item.name}</div>
        <div style="font-size:12px;color:var(--text-muted)">${fmtCurrency(item.selling_price)} × ${item.quantity} = ${linePaid}${freeLine}</div>
        ${schemeHint}
        ${freeControls}
      </div>
      <div class="cart-item-qty">
        <div class="cart-item-qty-btn" onclick="updatePosQty(${i},-1)">−</div>
        <input type="number" min="1" class="cart-item-qty-input" value="${item.quantity}"
          onchange="setPosQty(${i}, this.value)" onkeydown="if(event.key==='Enter'){this.blur()}">
        <div class="cart-item-qty-btn" onclick="updatePosQty(${i},1)">+</div>
        <div class="cart-item-qty-btn" style="color:var(--color-error);margin-left:8px" onclick="removePosItem(${i})">✕</div>
      </div>
    </div>
  `;
  }).join('');
}

window.updatePosQty = function(i, delta) {
  const item = _posState.cart[i];
  if (!item) return;
  item.quantity = Math.max(1, (Number(item.quantity) || 1) + delta);
  posClampCartItem(item, { toastOnTrim: true });
  renderPosCart();
  updatePosSummary();
};

window.setPosQty = function(i, raw) {
  const item = _posState.cart[i];
  if (!item) return;
  const n = parseInt(String(raw).trim(), 10);
  if (isNaN(n) || n < 1) {
    showToast('Quantity must be at least 1', 'warning');
    renderPosCart();
    return;
  }
  item.quantity = n;
  posClampCartItem(item, { toastOnTrim: true });
  renderPosCart();
  updatePosSummary();
};

window.updatePosFreeQty = function(i, delta) {
  const item = _posState.cart[i];
  if (!item || !posProductHasScheme(item)) return;
  item.free_quantity = Math.max(0, (Number(item.free_quantity) || 0) + delta);
  posClampCartItem(item, { preferFree: true, toastOnTrim: true });
  renderPosCart();
  updatePosSummary();
};

window.setPosFreeQty = function(i, raw) {
  const item = _posState.cart[i];
  if (!item || !posProductHasScheme(item)) return;
  const n = parseInt(String(raw).trim(), 10);
  item.free_quantity = isNaN(n) || n < 0 ? 0 : n;
  posClampCartItem(item, { preferFree: true, toastOnTrim: true });
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

  const billLines = _posState.cart.length
    ? `<div class="pos-bill-lines">${_posState.cart.map(item => {
        const freeQty = Number(item.free_quantity) || 0;
        const qtyLabel = freeQty > 0
          ? `${item.quantity} + <span style="color:var(--color-success);font-weight:700">${freeQty} FREE</span>`
          : `${item.quantity}`;
        return `<div class="summary-row" style="font-size:12px;align-items:flex-start;gap:8px"><span style="flex:1;line-height:1.35">${escapeHtml(item.name)}<br><span style="color:var(--text-muted)">Qty ${qtyLabel}</span></span><span style="white-space:nowrap">${fmtCurrency(item.selling_price * item.quantity)}</span></div>`;
      }).join('')}</div>`
    : '';

  el.innerHTML = `
    ${billLines}
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
      free_qty: Number(c.free_quantity) || 0,
      packaging_level_id: null,
      units_per_level: 1,
    }));

    const idempotencyKey = generateUUID();

    const fulfillmentMode = (_posState.fulfillment === 'self_pickup' || _posState.fulfillment === 'counter_pickup') ? 'pickup' : (_posState.fulfillment || 'pickup');
    const combinedAddress = [_posState.retailer.address, _posState.retailer.area, _posState.retailer.city, _posState.retailer.pincode].filter(Boolean).join(', ') || _posState.retailer.address || 'Counter pickup';

    const { data, error } = await sb.rpc('place_order', {
      p_retailer_id: _posState.retailer.id,
      p_items: items,
      p_address: fulfillmentMode === 'pickup' ? (combinedAddress || 'Counter pickup') : combinedAddress,
      p_idempotency_key: idempotencyKey,
      p_payment_mode: _posState.payment,
      p_redeem_points: 0,
      p_fulfillment_mode: fulfillmentMode,
      p_delivery: null,
      p_notes: _posState.notes || 'POS Counter Order',
    });

    if (error) throw error;

    const orderId = data?.order_id;

    // Keep admin-created order as 'approved'
    if (orderId) {
      await sb.from('orders').update({ status: 'approved' }).eq('id', orderId);
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
        free_qty: Number(item.free_quantity) || 0,
        packaging_level_id: null,
        units_per_level: 1,
      };
    }).filter(i => i.product_id);

    if (items.length === 0) { showToast('No matched products to import', 'error'); if (btn) { btn.disabled = false; btn.textContent = '📥 Create Order from Invoice'; } return; }

    const idempotencyKey = generateUUID();
    const invoiceAddr = [customer.address, customer.area, customer.city, customer.pincode].filter(Boolean).join(', ') || customer.address || 'Invoice import address';

    const { data, error } = await sb.rpc('place_order', {
      p_retailer_id: customer.id,
      p_items: items,
      p_address: invoiceAddr,
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
    const { data: row, error } = await sb.from('settings').select('*').limit(1).maybeSingle();
    if (error) throw error;

    const settings = row || {};

    pageContent.innerHTML = `
      <div style="max-width:700px">
        <!-- General -->
        <div class="section-card mb-2">
          <h4 style="font-size:14px;font-weight:700;margin-bottom:12px">🏪 General & Tax</h4>
          ${renderSettingToggle('gst_enabled', 'Enable GST', settings)}
          ${renderSettingInput('gst_percent', 'Default GST Rate (%)', settings, 'number')}
          ${renderSettingToggle('show_prices_to_unverified', 'Show Prices to Unverified Users', settings)}
        </div>

        <!-- Ordering & Delivery -->
        <div class="section-card mb-2">
          <h4 style="font-size:14px;font-weight:700;margin-bottom:12px">📦 Ordering & Logistics</h4>
          ${renderSettingToggle('delivery_enabled', 'Enable Doorstep Delivery & Live Tracking', settings)}
          ${renderSettingToggle('pickup_enabled', 'Enable Self Pickup', settings)}
          ${renderSettingInput('pickup_address', 'Warehouse / Pickup Address', settings, 'text')}
          ${renderSettingInput('pickup_hours', 'Operating Hours', settings, 'text')}
        </div>

        <!-- Payments -->
        <div class="section-card mb-2">
          <h4 style="font-size:14px;font-weight:700;margin-bottom:12px">💳 Payments</h4>
          ${renderSettingToggle('credit_enabled', 'Credit System for Retailers', settings)}
        </div>

        <!-- Loyalty -->
        <div class="section-card mb-2">
          <h4 style="font-size:14px;font-weight:700;margin-bottom:12px">⭐ Loyalty Program</h4>
          ${renderSettingToggle('loyalty_enabled', 'Enable Loyalty Points', settings)}
          ${renderSettingInput('loyalty_redemption_rate', 'Redemption Rate (points per ₹1)', settings, 'number')}
          ${renderSettingInput('max_redemption_percent', 'Max Redeem % per Order', settings, 'number')}
        </div>

        <!-- Support -->
        <div class="section-card mb-2">
          <h4 style="font-size:14px;font-weight:700;margin-bottom:12px">📞 Support</h4>
          ${renderSettingInput('support_phone', 'Support Phone', settings, 'text')}
        </div>

        <!-- Data export -->
        <div class="section-card mb-2">
          <h4 style="font-size:14px;font-weight:700;margin-bottom:12px">📦 Data Backup & Export</h4>
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">Download CSV backups for disaster recovery.</p>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px">
            <button type="button" class="btn btn-secondary" id="exportProductsCsv">💊 Export Products</button>
            <button type="button" class="btn btn-secondary" id="exportRetailersCsv">🏪 Export Retailers</button>
            <button type="button" class="btn btn-secondary" id="exportOrdersCsv">📋 Export Orders</button>
          </div>
        </div>
      </div>
    `;

    document.getElementById('exportProductsCsv')?.addEventListener('click', exportProductsCsvBackup);
    document.getElementById('exportRetailersCsv')?.addEventListener('click', exportRetailersCsvBackup);
    document.getElementById('exportOrdersCsv')?.addEventListener('click', exportOrdersCsvBackup);

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
  return `<div class="form-group" style="margin-bottom:12px"><label class="form-label">${label}</label><input type="${type}" class="form-input setting-input" data-key="${key}" value="${escapeAttr(val)}" style="margin:0"></div>`;
}

async function saveSetting(key, value) {
  try {
    const { error } = await sb.rpc('update_settings', { p_key: key, p_value: value });
    if (error) throw error;
    showToast(`${key.replace(/_/g,' ')} updated`, 'success');
  } catch (err) {
    showToast(`Failed to save: ${err.message}`, 'error');
  }
}

async function exportProductsCsvBackup() {
  try {
    showToast('Exporting products...', 'info');
    const prods = await fetchAllProducts('*', false);
    let csv = 'ID,Name,Company,Category,SKU,MRP,Price,Stock,Active\n';
    prods.forEach(p => {
      csv += `"${p.id}","${(p.name||'').replace(/"/g,'""')}","${(p.company||'').replace(/"/g,'""')}","${(p.category||'').replace(/"/g,'""')}","${p.sku||''}","${p.mrp||0}","${p.selling_price||0}","${p.stock_quantity||0}","${p.is_active?'Yes':'No'}"\n`;
    });
    downloadCsv(csv, `products_backup_${Date.now()}.csv`);
    showToast(`Exported ${prods.length} products!`, 'success');
  } catch (err) { showToast(err.message, 'error'); }
}

async function exportRetailersCsvBackup() {
  try {
    showToast('Exporting retailers...', 'info');
    const retailers = await fetchAllProfiles('*', 'retailer');
    let csv = 'ID,Business Name,Contact,Phone,Email,Area,City,Credit Limit,Credit Used,Approved\n';
    retailers.forEach(r => {
      csv += `"${r.id}","${(r.business_name||'').replace(/"/g,'""')}","${(r.name||'').replace(/"/g,'""')}","${r.phone||''}","${r.email||''}","${(r.area||'').replace(/"/g,'""')}","${(r.city||'').replace(/"/g,'""')}","${r.credit_limit||0}","${r.credit_used||0}","${r.approved?'Yes':'No'}"\n`;
    });
    downloadCsv(csv, `retailers_backup_${Date.now()}.csv`);
    showToast(`Exported ${retailers.length} retailers!`, 'success');
  } catch (err) { showToast(err.message, 'error'); }
}

async function exportOrdersCsvBackup() {
  try {
    showToast('Exporting orders...', 'info');
    const { data: orders, error } = await sb.from('orders').select(`
      id, order_number, grand_total, status, delivery_status, payment_mode, fulfillment_mode, created_at, delivered_at,
      user:profiles!orders_user_id_fkey(name, business_name, phone),
      rider:profiles!orders_rider_id_fkey(name, phone)
    `).order('created_at', { ascending: false }).limit(2000);
    if (error) throw error;
    let csv = 'Order ID,Order Number,Customer,Business,Phone,Rider,Rider Phone,Amount,Status,Delivery Status,Payment,Fulfillment,Date,Delivered At\n';
    (orders || []).forEach(o => {
      csv += `"${o.id}","${o.order_number||''}","${(o.user?.name||'').replace(/"/g,'""')}","${(o.user?.business_name||'').replace(/"/g,'""')}","${o.user?.phone||''}","${(o.rider?.name||'').replace(/"/g,'""')}","${o.rider?.phone||''}","${o.grand_total||0}","${o.status||''}","${o.delivery_status||''}","${o.payment_mode||''}","${o.fulfillment_mode||''}","${o.created_at}","${o.delivered_at||''}"\n`;
    });
    downloadCsv(csv, `orders_backup_${Date.now()}.csv`);
    showToast(`Exported ${(orders||[]).length} orders!`, 'success');
  } catch (err) { showToast(err.message, 'error'); }
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

      <!-- Logistics & Delivery Card -->
      <div class="management-card">
        <div>
          <div class="management-card-header">
            <div class="management-card-icon">🚚</div>
            <h3 class="management-card-title">Logistics & Live Delivery</h3>
          </div>
          <p class="management-card-body">Monitor in-flight routes, assign riders, verify shop pins for accurate GPS drops, and review proof-of-delivery photos.</p>
          <div class="management-card-stats">
            <div class="management-card-stat">
              <div class="management-card-stat-val" id="m_active_deliveries">—</div>
              <div class="management-card-stat-lbl">In Flight</div>
            </div>
            <div class="management-card-stat">
              <div class="management-card-stat-val" id="m_awaiting_rider">—</div>
              <div class="management-card-stat-lbl">Awaiting Rider</div>
            </div>
            <div class="management-card-stat">
              <div class="management-card-stat-val" id="m_riders_online">—</div>
              <div class="management-card-stat-lbl">GPS Live (5m)</div>
            </div>
          </div>
        </div>
        <div class="management-card-footer">
          <button class="btn btn-primary" onclick="navigateTo('delivery')">🗺️ Fleet Map</button>
          <button class="btn btn-secondary" onclick="navigateTo('address-correction')">📍 Verify Addresses</button>
        </div>
      </div>
    </div>
  `;

  // Fetch real-time numbers
  try {
    const today = new Date(); today.setHours(0,0,0,0);
    const [statsRes, lowStockRes, totalRetailersRes, pendingUsersRes, activeProductsRes, totalProductsRes] = await Promise.all([
      sb.rpc('get_admin_dashboard_stats', { p_today: today.toISOString() }),
      sb.rpc('get_low_stock_products'),
      sb.from('profiles').select('*', { count: 'exact', head: true }).eq('role', 'retailer'),
      sb.from('profiles').select('*', { count: 'exact', head: true }).eq('approved', false),
      sb.from('products').select('*', { count: 'exact', head: true }).eq('is_active', true),
      sb.from('products').select('*', { count: 'exact', head: true }),
    ]);
    const deliveryOps = deliveryOpsFromStats(statsRes.data) || await fetchDeliveryOpsSummary();

    if (statsRes.data) {
      document.getElementById('m_pending_orders').textContent = statsRes.data.pendingOrders || 0;
      document.getElementById('m_today_orders').textContent = statsRes.data.todayOrders || 0;
      document.getElementById('m_pending_users').textContent = pendingUsersRes?.count != null ? pendingUsersRes.count.toLocaleString('en-IN') : (statsRes.data.pendingUsers || 0);
    }

    if (totalProductsRes?.count != null) {
      document.getElementById('m_total_products').textContent = totalProductsRes.count.toLocaleString('en-IN');
    }
    if (activeProductsRes?.count != null) {
      document.getElementById('m_active_products').textContent = activeProductsRes.count.toLocaleString('en-IN');
    }

    if (lowStockRes.data) {
      document.getElementById('m_low_stock').textContent = lowStockRes.data.length.toLocaleString('en-IN');
    }

    if (totalRetailersRes && totalRetailersRes.count != null) {
      document.getElementById('m_total_retailers').textContent = totalRetailersRes.count.toLocaleString('en-IN');
    }

    if (deliveryOps) {
      document.getElementById('m_active_deliveries').textContent = (deliveryOps.activeDeliveries || 0).toLocaleString('en-IN');
      document.getElementById('m_awaiting_rider').textContent = (deliveryOps.unassignedDelivery || 0).toLocaleString('en-IN');
      document.getElementById('m_riders_online').textContent = (deliveryOps.ridersOnline || 0).toLocaleString('en-IN');
    }

    // Out-of-stock count: sample active products with zero stock via RPC fallback
    try {
      const { count: oosCount } = await sb.from('products').select('*', { count: 'exact', head: true }).eq('is_active', true).lte('stock_quantity', 0);
      if (oosCount != null) document.getElementById('m_out_of_stock').textContent = oosCount.toLocaleString('en-IN');
    } catch (_) {}
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
          <button class="option-chip" data-tab="telemetry">📡 Delivery Telemetry</button>
          <button class="option-chip" data-tab="resets">🔒 Password Resets</button>
        </div>
        <input type="text" class="form-input" id="auditSearch" placeholder="Search logs..." style="margin:0;max-width:260px">
      </div>
    </div>
    <div id="auditLogsContent"><div class="text-center mt-3" style="color:var(--text-muted)">Loading audit trail...</div></div>
  `;

  let currentTab = 'logins';
  let searchTerm = '';
  let logsData = { logins: [], stock: [], credit: [], orders: [], resets: [], telemetry: [] };

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
      else if (currentTab === 'telemetry') {
        const { data, error } = await sb.from('delivery_telemetry_events').select(`
          id, event_type, order_id, rider_id, metadata, created_at,
          rider:profiles!delivery_telemetry_events_rider_id_fkey(name, phone)
        `).order('created_at', { ascending: false }).limit(250);
        if (error) throw error;
        logsData.telemetry = data || [];
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
    else if (currentTab === 'telemetry') {
      let filtered = logsData.telemetry;
      if (q) {
        filtered = filtered.filter(t =>
          (t.event_type || '').toLowerCase().includes(q) ||
          (t.rider?.name || '').toLowerCase().includes(q) ||
          (t.order_id || '').toLowerCase().includes(q)
        );
      }

      container.innerHTML = filtered.length === 0 ? `<div class="text-center" style="padding:40px;color:var(--text-muted)">No delivery telemetry events</div>` : `
        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr><th>Event</th><th>Rider</th><th>Order</th><th>Details</th><th>Timestamp</th></tr>
            </thead>
            <tbody>
              ${filtered.map(t => `
                <tr>
                  <td><span class="badge badge-info">${escapeHtml(t.event_type || '—')}</span></td>
                  <td style="font-weight:600">${escapeHtml(t.rider?.name || '—')}</td>
                  <td style="font-size:11px">${t.order_id ? t.order_id.slice(0, 8) + '…' : '—'}</td>
                  <td style="font-size:11px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeAttr(JSON.stringify(t.metadata || {}))}">${escapeHtml(JSON.stringify(t.metadata || {}).slice(0, 120))}</td>
                  <td style="font-size:12px;color:var(--text-muted)">${fmtDateTime(t.created_at)}</td>
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
  document.getElementById('auditSearch')?.addEventListener('input', debounce((e) => {
    searchTerm = e.target.value;
    renderLogsTable();
  }, 200));

  await fetchAudits();
}

function downloadCsv(content, filename) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Make navigateTo globally accessible for onclick handlers
window.navigateTo = navigateTo;

// Restore session on load (onAuthStateChange handles INITIAL_SESSION)
(async function bootstrapAdminSession() {
  if (isAuthChecking) return;
  isAuthChecking = true;
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) showLogin();
  } catch (err) {
    console.warn('Session bootstrap:', err);
  } finally {
    isAuthChecking = false;
  }
})();
