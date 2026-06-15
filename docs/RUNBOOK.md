# Thakkar Medico — Production Runbook

> Operational guide for the Thakkar Medico app in production.

---

## 1. Architecture Overview

```
┌─────────────┐     ┌────────────────┐     ┌──────────────────┐
│  Expo App   │────▸│  Supabase      │────▸│  PostgreSQL      │
│  (RN 0.81)  │     │  (Auth + REST) │     │  (RLS + RPCs)    │
└─────┬───────┘     └───────┬────────┘     └──────────────────┘
      │                     │
      │  Push Tokens        │  Edge Functions
      ▼                     ▼
┌─────────────┐     ┌────────────────┐
│  Expo Push  │     │  generate-     │
│  Service    │     │  invoice/      │
└─────────────┘     │  statement     │
                    └────────────────┘
```

**Key Dependencies:**
- Expo SDK 54
- Supabase (Auth, Realtime, Storage, Edge Functions)
- Sentry for error tracking
- Expo Push Notification service

---

## 2. Environment Configuration

| Variable | Description | Required |
|----------|-------------|----------|
| `EXPO_PUBLIC_SUPABASE_URL` | Supabase project URL | ✅ |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous key | ✅ |
| `EXPO_PUBLIC_SENTRY_DSN` | Sentry DSN for error reporting | ✅ prod |
| `EXPO_PUBLIC_UPI_VPA` | Merchant UPI VPA for payments | ✅ |
| `EXPO_PUBLIC_SUPPORT_WHATSAPP` | WhatsApp support number | ✅ |
| `EXPO_PUBLIC_APP_ENV` | `staging` or `production` | ✅ |

**Environment files:**
- `.env` — local development (gitignored)
- `.env.staging` — staging template (tracked)
- `.env.production` — production template (tracked)

> ⚠️ Never commit actual secrets. Templates contain placeholder values only.

---

## 3. Build & Deploy

### Development
```bash
npx expo start --clear
```

### Staging Build
```bash
eas build --profile staging --platform android
eas build --profile staging --platform ios
```

### Production Build
```bash
eas build --profile production --platform android
eas build --profile production --platform ios
```

### OTA Update (JS-only changes)
```bash
eas update --branch production --message "hotfix: <description>"
```

---

## 4. Database Migrations

Migrations live in `supabase/` and must be run in order:

```
v1.sql → v2.sql → v3.sql → v4.sql → v5.sql → v6.sql → v7.sql → v8.sql
```

All migrations are **idempotent** (use `IF NOT EXISTS`). Safe to re-run.

### Running a new migration:
1. Connect to Supabase SQL Editor
2. Paste the migration SQL
3. Execute
4. Verify with: `SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace;`

---

## 5. Monitoring & Alerts

### Sentry
- **Dashboard:** https://sentry.io → Project: `thakkar-medico`
- **Key metrics:** Error rate, crash-free sessions, performance
- Sentry captures:
  - All unhandled exceptions
  - RPC failures with context
  - Auth state change errors

### Supabase Dashboard
- **Monitor:** Active connections, request latency, failed requests
- **Realtime:** Monitor channel subscriptions count
- **Edge Functions:** Check invocation logs for `generate-invoice` and `generate-statement`

### Health Check Queries
```sql
-- Active orders in last 24h
SELECT status, COUNT(*) FROM orders
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY status;

-- Failed RPC calls (check pg_stat_statements if enabled)
SELECT * FROM pg_stat_activity WHERE state = 'active';

-- Credit utilization
SELECT COUNT(*) AS retailers,
       SUM(credit_used) AS total_credit,
       SUM(credit_limit) AS total_limit
FROM retailers WHERE is_approved = true;
```

---

## 6. Common Operational Tasks

### 6.1 Approve a Retailer
```sql
UPDATE retailers SET is_approved = true WHERE id = '<retailer_id>';
```

### 6.2 Adjust Credit Limit
```sql
SELECT adjust_credit_limit('<retailer_id>', 50000, 'Increased for bulk buyer');
```

### 6.3 Force Cancel an Order
```sql
UPDATE orders SET status = 'cancelled' WHERE id = '<order_id>';
-- Note: This bypasses the state machine trigger. Use only in emergencies.
```

### 6.4 Restock All Low-Stock Products
```sql
-- Find products below threshold
SELECT id, name, stock_quantity FROM products
WHERE stock_quantity < 10 AND is_active = true;

-- Bulk restock (use adjust_stock RPC for audit trail)
SELECT adjust_stock('<product_id>', 100, 'restock');
```

### 6.5 Generate Missing Invoice
Call the Edge Function directly:
```bash
curl -X POST 'https://<project>.supabase.co/functions/v1/generate-invoice' \
  -H 'Authorization: Bearer <service_role_key>' \
  -H 'Content-Type: application/json' \
  -d '{"order_id": "<order_id>"}'
```

---

## 7. Incident Response

### Severity Levels

| Level | Description | Response Time | Examples |
|-------|------------|---------------|----------|
| **P0** | App unusable / data loss | < 30 min | Auth broken, orders not saving, stock corruption |
| **P1** | Major feature broken | < 2 hours | Payments failing, push notifications down |
| **P2** | Minor feature broken | < 8 hours | PDF generation failing, analytics wrong |
| **P3** | Cosmetic / low impact | Next sprint | i18n typo, minor UI glitch |

### P0 Response Playbook
1. **Check Sentry** for error spike, identify root cause
2. **Check Supabase** dashboard — is the DB up? Are connections saturated?
3. If client-side JS issue: deploy OTA fix via `eas update`
4. If database issue: connect via SQL Editor, inspect `pg_stat_activity`
5. If auth issue: check Supabase Auth logs, verify GoTrue service health
6. **Communicate** to affected users via WhatsApp / in-app banner

### Rollback Procedure
```bash
# List recent updates
eas update:list --branch production

# Roll back to previous update
eas update:rollback --branch production
```

For native changes, you cannot OTA rollback. Submit a new build to app stores.

---

## 8. Backup & Recovery

### Database
- Supabase Pro plan includes **daily backups** with point-in-time recovery
- For manual backup: `pg_dump` via Supabase connection string

### App State
- All user data is server-side (Supabase)
- Local state (cart, preferences) stored in AsyncStorage — expendable
- Auth tokens in SecureStore — regenerated on login

---

## 9. Key Contacts

| Role | Contact |
|------|---------|
| Lead Developer | [Update with actual contact] |
| Supabase Admin | [Update with actual contact] |
| App Store Manager | [Update with actual contact] |
| Business Owner | Thakkar Medico Traders |

---

## 10. Appendix: RPC Reference

| RPC Name | Description |
|----------|-------------|
| `place_order` | Atomic order placement with stock locking, credit check, loyalty |
| `adjust_stock` | Stock adjustment with audit trail |
| `get_low_stock_products` | Products below threshold |
| `get_sales_summary` | Analytics summary for date range |
| `get_top_products` | Top products by revenue |
| `get_top_retailers` | Top retailers by order value |
| `get_daily_revenue` | Daily revenue time series |
| `get_status_breakdown` | Order status distribution |
| `get_product_by_sku` | Barcode/SKU lookup |
| `adjust_credit_limit` | Modify retailer credit |
| `log_login_event` | Auth audit trail |
| `upsert_product` | Create/update product |
| `deactivate_product` | Soft-delete product |
