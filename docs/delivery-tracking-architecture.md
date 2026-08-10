# Thakkar Medico — Live Delivery Tracking Subsystem: Definitive Architecture

This document serves as the authoritative technical architecture and operational reference for the **Thakkar Medico Live Delivery Tracking Subsystem**, spanning database schema, state machines, realtime communication, telematics ingestion, drop pin resolution, and operational maintenance.

---

## 1. System Overview & Architecture Goals

The live delivery tracking subsystem coordinates high-accuracy GPS broadcasting from delivery riders to customer tracking pages (`track.html`), admin dispatch dashboards, and mobile driver applications.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             HIGH-LEVEL TOPOLOGY                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                                                               
   ┌────────────────────┐                          ┌───────────────────────┐   
   │  Rider Mobile App  │                          │ Customer Live Track   │   
   │ (Expo / React Native)                         │ (Zero-RPC Web Page)   │   
   └────┬───────────┬───┘                          └───────────▲───────────┘   
        │           │ (Postgres Sync: 30s)                     │ (Realtime WS) 
        │ (Hot Path │                                          │               
        │ GPS: ~4s) ▼                                          │               
        │  ┌───────────────────────────────────────────────────┴───────────┐   
        │  │               Supabase PostgreSQL Backend                     │   
        ▼  │                                                               │   
 ┌─────────┐  • delivery_tracking           (Latest Durable State & Sync)  │   
 │ Upstash │  • delivery_location_history   (Throttled Breadcrumbs Trail)  │   
 │  Redis  │  • orders                      (Lifecycle & Frozen Snapshot)  │   
 │ Hot-Path│  • retailer_shop_locations     (Master Physical Shop Pin)     │   
 │ (30sTTL)│  • delivery_proofs             (Geotagged Photo POD Records)  │   
 └─────────┘  • delivery_telemetry_events   (Diagnostics & Circuit Breaker)│   
           └────────────────────────┬──────────────────────────────────────┘   
                                    │                                          
                                    ▼ (Realtime WS & RPC)                      
                         ┌───────────────────────┐                             
                         │ Admin Command Center  │                             
                         │ (Fleet Map / Portal)  │                             
                         └───────────────────────┘                             
```

### Core Design Principles
1. **Zero-RPC In-Transit Rendering:** Customer tracking pages consume live GPS directly from Supabase Realtime WebSocket payloads (`delivery_tracking` UPDATE events) and compute distances, ETA, and progress bar percentages in-place without issuing database queries.
2. **Dual-Layer Telematics Ingestion (Redis Hot Path + Throttled Postgres Sync):**
   * **Hot Path (Option 1: 10s Cadence):** Live GPS writes directly to Upstash Redis REST every ~10s per rider with explicit 90s TTL (3:1 ratio against 30s sync to prevent expiration races), protecting Postgres from write saturation and supporting 5–6 concurrent riders under the 500K monthly quota.
   * **Durable Sync (30s Cadence):** Periodic sync every 30s persists latest state to `delivery_tracking` (triggering Supabase Realtime broadcast) and `delivery_location_history` (if displacement >25m).
   * **Fail-Open Resilience:** If Redis is unreachable or quota exhausted, the client automatically degrades to direct Postgres writes.
3. **Snapshot vs Live Truth Isolation:**
   * **Active Orders:** Authoritative verified shop locations (`is_verified = true`) take precedence over stale order snapshots.
   * **Delivered Orders:** Historical orders lock onto `orders.delivery_snapshot` as immutable Layer 1 truth so historical records never alter if a shop moves in the future.
4. **Motion-Aware Battery Optimization:** Continuous background GPS tracking runs while the rider is in motion; motionless pauses (>30 minutes) set `is_stationary = true` and reduce broadcast frequency until displacement >25m is detected.

---

## 2. Entity Relationship Diagram (ERD) & Table Ownership

### Overlapping State Notice: `delivery_tracking` vs `driver_locations`
The system currently maintains two tables holding driver positional data:
1. **`delivery_tracking` (Authoritative Layer 1 Truth):** Keyed by `order_id UNIQUE`. Holds authoritative telematics, battery, geofence, and destination coordinates for in-flight customer orders. Consumed by customer `track.html` and admin single-order tracker `[orderId].tsx`.
2. **`driver_locations` (Fleet Overview Reader Table):** Keyed by `profile_id UNIQUE`. Used exclusively by the Admin Fleet Overview Screen (`app/admin/delivery-tracking.tsx`) to render all online drivers simultaneously across Nagpur on a single multi-driver map.
* **Follow-up Consolidation Ticket (TM-TRACK-F1):** Migrate Admin Fleet Overview Screen to aggregate directly from `delivery_tracking` / Redis driver keys and deprecate `driver_locations`.

```mermaid
erDiagram
    PROFILES ||--o{ ORDERS : "places / delivers"
    PROFILES ||--o{ RETAILER_SHOP_LOCATIONS : "owns"
    PROFILES ||--o{ CANARY_RIDER_FLAGS : "gated_by"
    ORDERS ||--|| DELIVERY_TRACKING : "tracks"
    ORDERS ||--o{ DELIVERY_LOCATION_HISTORY : "breadcrumbs"
    ORDERS ||--o| DELIVERY_PROOFS : "verified_by"
    ORDERS ||--o{ DELIVERY_TELEMETRY_EVENTS : "logs"
    RETAILER_SHOP_LOCATIONS ||--o{ ORDERS : "delivery_address_id"

    DELIVERY_TRACKING {
        uuid id PK
        uuid order_id FK,UK
        uuid rider_id FK
        float8 lat
        float8 lng
        float8 heading
        float8 speed
        float8 accuracy
        int4 battery_level
        float8 destination_lat
        float8 destination_lng
        bool is_off_route
        bool geofence_arrived
        timestamptz geofence_arrived_at
        bool is_stationary
        bool signal_lost
        timestamptz updated_at
    }

    DELIVERY_LOCATION_HISTORY {
        int8 id PK
        uuid order_id FK
        uuid rider_id FK
        float8 lat
        float8 lng
        float8 heading
        float8 speed
        timestamptz recorded_at
    }

    RETAILER_SHOP_LOCATIONS {
        uuid id PK
        uuid retailer_account_id FK
        text shop_name
        text building
        text street
        text landmark
        text area
        text city
        text state
        text pincode
        float8 lat
        float8 lng
        bool is_default
        bool is_verified
        uuid verified_by FK
        timestamptz verified_at
        bool is_locked_by_admin
        bool needs_reverification
        text flag_reason
        location_verification_state verification_state
        timestamptz updated_at
    }

    ORDERS {
        uuid id PK
        text order_number UK
        uuid user_id FK
        uuid assigned_to FK
        text status
        text delivery_status
        jsonb delivery_snapshot
        uuid delivery_address_id FK
        text delivery_address
        text failed_reason
        text delivery_failure_reason
        timestamptz dispatched_at
        timestamptz delivered_at
    }

    DELIVERY_PROOFS {
        uuid id PK
        uuid order_id FK,UK
        uuid rider_id FK
        text photo_url
        float8 captured_lat
        float8 captured_lng
        timestamptz captured_at
        text notes
    }

    CANARY_RIDER_FLAGS {
        uuid id PK
        uuid rider_id FK,UK
        text feature_set
        bool enabled
        text notes
    }

    DELIVERY_TELEMETRY_EVENTS {
        uuid id PK
        text event_type
        uuid order_id FK
        uuid actor_id FK
        jsonb metadata
        timestamptz created_at
    }
```

---

## 3. Authoritative Drop Pin Resolution Specification

The master SQL resolver `resolve_order_destination_coordinates(p_order_id)` and client TypeScript ladder `orderDeliveryCoords.ts` execute the exact same 7-step priority ladder:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                   DROP PIN RESOLUTION PRIORITY MATRIX                       │
└─────────────────────────────────────────────────────────────────────────────┘

 [1] Is Order Terminal? (delivered / failed / cancelled)
     │
     ├── YES ──► Check delivery_snapshot ──► [Layer 1 Immutable Snapshot Truth]
     │
     └── NO (Active In-Flight Order)
          │
          ├── [2] Explicit delivery_address_id & is_verified = true?
          │       └── YES ──► [Authoritative Verified Shop Location Pin]
          │
          ├── [3] Retailer Profile has is_verified = true Default Shop?
          │       └── YES ──► [Authoritative Verified User Default Pin]
          │
          ├── [4] delivery_snapshot has valid lat/lng (!= 0)?
          │       └── YES ──► [Order Placement Snapshot Pin]
          │
          ├── [5] Explicit delivery_address_id has coordinates (unverified)?
          │       └── YES ──► [Unverified Shop Location Pin]
          │
          ├── [6] orders.destination_lat / delivery_tracking.destination_lat?
          │       └── YES ──► [Orders Table Fallback Pin]
          │
          └── [7] Final Fallback ──► [Nagpur Warehouse Centroid (21.1501, 79.0991)]
```

---

## 4. State Machines & Transitions

### A. Order Delivery Lifecycle
```mermaid
stateDiagram-v2
    [*] --> pending : place_order()
    pending --> approved : Admin / Auto Approval
    approved --> assigned : Rider Assigned
    assigned --> in_transit : startOrderTracking() (dispatched_at set)
    in_transit --> arriving_soon : Geofence Arrival (<=500m)
    arriving_soon --> delivered : ProofOfDeliverySheet (Photo Uploaded)
    in_transit --> failed : delivery_report_failed (Reason recorded)
    arriving_soon --> failed : delivery_report_failed
    failed --> assigned : admin_reschedule_failed_order()
    delivered --> [*]
```

### B. Shop Location Verification State (`location_verification_state`)
```mermaid
stateDiagram-v2
    [*] --> unverified : Created at Signup / Order
    unverified --> auto_suggested : Photon / Nominatim Suggestion
    auto_suggested --> admin_verified : Admin Verified in Portal
    unverified --> admin_verified : Admin Drag / Drop Verification
    admin_verified --> locked : Admin Explicit Lock
    admin_verified --> needs_reverification : Pin Drift Detected (>150m at POD)
    auto_suggested --> needs_reverification : Pin Drift Detected
    needs_reverification --> admin_verified : Ops Re-verification
```

---

## 5. Telemetry, Drift Detection & Circuit Breakers

### A. Post-Delivery Pin Drift Detection (`evaluate_delivered_order_pin_drift`)
When an order transitions to `delivery_status = 'delivered'`, database trigger `trg_orders_flag_pin_drift` evaluates the physical delivery location against the registered shop pin:
* **Distance Threshold:** 150.0 meters.
* **Evaluation Coordinates:**
  1. Primary: `delivery_proofs.captured_lat` / `captured_lng` (geotagged at photo shutter click).
  2. Fallback: Centroid of last 5 breadcrumbs in `delivery_location_history`.
* **Remediation Action:** If distance >150m and `is_locked_by_admin = false`, sets `needs_reverification = true`, `flag_reason = 'drift_detected'`, and logs to `delivery_integrity_health_log`.

### B. Client-Side Telemetry & Circuit Breakers
For riders in the canary cohort (`canary_rider_flags.enabled = true`), the client monitors stability:
* **Rapid Recalculations (>1/min for 3m):** Trips circuit breaker to standard navigation mode.
* **Excessive Reconnections (>2/shift):** Trips circuit breaker and holds session in baseline mode.
* **Granular Events Logged:** `auto_circuit_breaker_triggered`, `rider_reported_issue`, `realtime_reconnect`, `off_route_recalculation`, `destination_shifted`.

---

## 6. Master RPC Directory

| Function Name | Security | Target Tables | Primary Consumers |
| :--- | :--- | :--- | :--- |
| `get_public_order_tracking(text)` | Security Definer (Anon/Auth) | `orders`, `delivery_tracking`, `retailer_shop_locations`, `delivery_proofs` | Public Customer `track.html` |
| `get_order_tracking_bundle(uuid)` | Security Definer (Anon/Auth) | Delegates to `get_public_order_tracking` | Admin Per-Order Tracker `[orderId].tsx` |
| `resolve_order_destination_coordinates(uuid)` | Security Definer (Anon/Auth) | `orders`, `retailer_shop_locations`, `delivery_tracking` | Master Single Source Resolver |
| `get_active_order_for_rider(uuid)` | Security Definer (Auth) | `orders`, `retailer_shop_locations`, `order_items` | Rider Mobile Screen `active-delivery.tsx` |
| `get_delivery_health_summary(bool)` | Security Definer (Auth) | `delivery_telemetry_events`, `delivery_integrity_health_log`, `delivery_tracking` | Admin Fleet Dashboard `app.js` |
| `check_geofence_arrival(uuid, uuid, float8, float8)` | Security Definer (Auth) | `orders`, `delivery_tracking` | Mobile Geofence Watcher |
| `run_delivery_subsystem_daily_maintenance()` | Security Definer (Auth) | `delivery_location_history`, `delivery_telemetry_events`, `public_tracking_rate_limits` | Daily Cron / Admin Maintenance UI |
| `toggle_rider_canary_flag(uuid, bool, text, text)` | Security Definer (Auth) | `canary_rider_flags` | Admin Canary Controls |
| `apply_shop_location_suggestion_v2(...)` | Security Definer (Auth) | `retailer_shop_locations`, `location_corrections` | Address Correction Ops Portal |
| `reconcile_historical_delivered_order_snapshots(bool)` | Security Definer (Auth) | `orders`, `retailer_shop_locations`, `delivery_integrity_health_log` | Integrity Audit Runner |

---

## 7. Data Retention & Maintenance Runbook

| Table | Retention Window | Purge Function | Execution Cadence |
| :--- | :--- | :--- | :--- |
| `delivery_location_history` | **7 Days** | `purge_old_delivery_location_history(7)` | Daily at 03:00 AM IST (21:30 UTC) |
| `delivery_telemetry_events` | **30 Days** | `purge_old_delivery_telemetry_events(30)` | Daily at 03:00 AM IST (21:30 UTC) |
| `public_tracking_rate_limits` | **10 Minutes** | `purge_expired_tracking_rate_limits()` | Daily at 03:00 AM IST (21:30 UTC) |
| `delivery-photos` (Storage) | **90 Days** | Supabase Storage Lifecycle Policy | Automated by Storage Engine |

### pg_cron Daily Scheduling Snippet
```sql
CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.schedule(
  'delivery_subsystem_daily_maintenance',
  '30 21 * * *',
  $$ SELECT public.run_delivery_subsystem_daily_maintenance(); $$
);
```
