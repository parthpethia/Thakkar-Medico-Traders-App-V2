# Supabase & Database Optimization Report

This report outlines key strategies and design patterns implemented in the **Thakkar Medico** project codebase to reduce backend load on Supabase, minimize client data egress costs, and increase overall application performance.

---

## 1. Client-Side Query Coalescing

### The Challenge
When multiple components mount concurrently, or when React Native screen focus effects trigger in short succession, the application can issue redundant, identical queries to the database. This duplicates database processing, network bandwidth, and serialization overhead on the Postgres server.

### The Solution
We use a centralized **Query Coalescer** (`src/lib/queryCoalescer.ts`) to intercept concurrent in-flight requests.
- **Deduplication**: If a query with the same unique key (e.g. `'categories-_anonymous'` or `'featured-_anonymous'`) is currently executing, subsequent calls immediately hook into the same active promise.
- **Hygiene**: As soon as the promise resolves or rejects, the key is removed from the in-flight map, ensuring subsequent refreshes return fresh data.

### Implementation Areas
- **Home Feed Components**: All queries fetched via `Promise.all` on the store front home page (`app/(tabs)/index.tsx`) now leverage query coalescing.
- **Auth Session Profile Resolving**: Profile checks are coalesced under `'user-profile'` key to prevent simultaneous reads during app boot and routing checks.
- **Application Settings**: Cached under `'settings'` key inside root level hydration guards.

---

## 2. Egress Bandwidth & Payload Reductions

### Select Constraint Filters
Retrieving all columns (`*`) transfers unnecessary fields (e.g., descriptions, large text snapshots, internal metadata columns) across the wire.
- **Rule**: Limit `.select()` to only the required columns needed for rendering the UI.
- **Example**: In list views, we fetch fields specifically defined by `PRODUCT_LIST_SELECT`:
  ```typescript
  export const PRODUCT_LIST_SELECT = 'id, name, company, category, sku, pack_size, image, mrp, selling_price, gst_percent, stock_quantity, is_active, created_at';
  ```

### Fetch Limits & Pagination
- **Storefront Home Page**: The order-history list query has been reduced from `.limit(100)` down to `.limit(20)`. Because the logic only needs to extract at most 10 unique recent product IDs for the "Order Again" drawer, fetching 100 historical orders is wasteful.
- **Admin Products List**: Implements server-side offset pagination (`PAGE_SIZE = 20`) via `.range(offset, offset + PAGE_SIZE - 1)` to prevent downloading entire catalogs onto the device.

---

## 3. Server-Side Calculations (RPCs over Direct Aggregates)

Executing aggregates (e.g., counting, summing, and filtering multiple tables separately) from client-side JS requires multiple round-trips.
- **Design Pattern**: Consolidate multi-table statistics into database functions marked as `STABLE` or `IMMUTABLE`.
- **Admin Dashboard**: Instead of running separate queries for low stock, unapproved users, and today's orders, the dashboard calls a single RPC:
  ```sql
  supabase.rpc('get_admin_dashboard_stats', { p_today: today.toISOString() });
  ```
  This processes counts on the server close to the data, transferring only a single JSON statistics row back to the client.

---

## 4. PostgreSQL Indexing Strategies

Foreign keys in PostgreSQL are **not** indexed by default. Joins and cascades trigger full table sequential scans without explicit indexes.

### Recommended Missing Foreign Key Indices
Always ensure these indexes are present in migrations when adding new features:
```sql
-- 1. Indexing order items and status events by order relationship
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON public.order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_order_status_events_order_id ON public.order_status_events (order_id);

-- 2. Indexing loyalty logs by retailer
CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_retailer_id ON public.loyalty_transactions (retailer_id);

-- 3. Composite product status sorting (covers is_active filters on catalog fetches)
CREATE INDEX IF NOT EXISTS idx_products_active_company_name ON public.products (is_active, company, name);
CREATE INDEX IF NOT EXISTS idx_products_active_created_at ON public.products (is_active, created_at DESC);
```

---

## 5. Scaling Realtime Subscriptions

Realtime Postgres changes use PostgreSQL replication slots and require a continuous WebSocket connection. High numbers of active channels will overwhelm backend process limitations.

### Scaling Best Practices
1. **Always unsubscribe**: Ensure React `useEffect` cleanups explicitly call `.unsubscribe()` or `supabase.removeChannel(channel)` to free replication slots.
2. **Apply Row-Level Filters**: Never subscribe to generic table wildcards `*` if you only need updates for a specific entity. Always pass the exact filter, e.g.:
   ```typescript
   filter: `assigned_to=eq.${userId}`
   ```
3. **Connection Reuse**: Avoid multiple components subscribing to the same entity on separate channels. Let a root-level hook or Zustand store manage a single subscription channel and multiplex state changes to consumer components.
