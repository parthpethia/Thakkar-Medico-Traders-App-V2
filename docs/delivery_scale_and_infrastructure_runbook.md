# Live Delivery Tracking: Infrastructure Sizing & Operational Runbook

This document serves as the operational guide for scaling the **Thakkar Medico Live Delivery Tracking Subsystem** as daily order volume, concurrent delivery riders, and public tracking traffic grow.

---

## 1. Supabase Realtime Capacity & Headroom Sizing

### A. Connection Formula
The total concurrent WebSocket connection count ($C$) across the fleet is:
$$C = R_{\text{riders}} + (O_{\text{active}} \times V_{\text{viewers}}) + A_{\text{admins}}$$

Where:
- $R_{\text{riders}}$: Active delivery rider devices broadcasting GPS coordinates (~1 connection each).
- $O_{\text{active}}$: Deliveries currently in `dispatched`, `in_transit`, or `arriving_soon` state.
- $V_{\text{viewers}}$: Average number of customers/pharmacies viewing their live tracking link simultaneously (typically 1.2 per active order).
- $A_{\text{admins}}$: Active Admin Command Center browser tabs open (~1 connection each).

### B. Tier Scaling Thresholds

| Active Fleet Size (Concurrent Riders) | Daily Delivered Orders | Estimated Realtime Peak Connections | Recommended Supabase Plan / Add-on |
| :--- | :--- | :--- | :--- |
| **1 – 30 Riders** | 100 – 500 orders/day | ~75 – 150 connections | **Supabase Pro Tier (Base)** (Included 500 connections) |
| **30 – 100 Riders** | 500 – 2,500 orders/day | ~300 – 700 connections | **Supabase Pro + Realtime Add-on** (2,500 connections, +$25/mo) |
| **100 – 300 Riders** | 2,500 – 10,000 orders/day | ~1,200 – 3,000 connections | **Supabase Pro + Realtime 10k Add-on** or Dedicated Realtime |

> [!TIP]
> Thanks to the Phase 1 **Zero-RPC In-Place UI Rendering**, customer tracking pages consume **0 database RPC queries during transit** once connected via Realtime, reducing database CPU utilization by $>95\%$.

---

## 2. Database Connection Pooling (PgBouncer)

### A. Port Sizing & Pool Mode
- **Client App & Mobile API**: Always connect via **Port 6543** (PgBouncer in `Transaction` mode).
- **Direct Migrations / DDL**: Use **Port 5432** (Direct Session connection) only for running database migrations or schema alterations.

### B. Pool Settings for High Fleet Growth
```ini
# Recommended PgBouncer Settings for Pro Tier
default_pool_size = 25
max_client_conn = 500
pool_mode = transaction
reserve_pool_size = 5
```

---

## 3. Dedicated OSRM Routing Engine (Self-Hosted Option)

When fleet volume exceeds **50 concurrent riders**, routing through public demo servers (`router.project-osrm.org`) should be migrated to a dedicated self-hosted OSRM container or cloud routing endpoint.

### A. Docker Deployment (Lightweight India / Maharashtra Region)
```bash
# 1. Download Maharashtra or India OSM extract
wget https://download.geofabrik.de/asia/india/western-zone-latest.osm.pbf

# 2. Extract and build routing graph (car/bike profile)
docker run -t -v "${PWD}:/data" ghcr.io/project-osrm/osrm-backend osrm-extract -p /opt/car.lua /data/western-zone-latest.osm.pbf
docker run -t -v "${PWD}:/data" ghcr.io/project-osrm/osrm-backend osrm-partition /data/western-zone-latest.osrm
docker run -t -v "${PWD}:/data" ghcr.io/project-osrm/osrm-backend osrm-customize /data/western-zone-latest.osrm

# 3. Launch high-throughput routing engine
docker run -d -p 5000:5000 -v "${PWD}:/data" ghcr.io/project-osrm/osrm-backend osrm-routed --algorithm mld /data/western-zone-latest.osrm
```

### B. Server Sizing:
- **Instance**: 2 vCPUs, 4 GB RAM (e.g., AWS `t4g.medium` or Hetzner `CX22` @ €4/month).
- **Throughput**: Handles $>2,500\text{ routing requests/sec}$ with $<15\text{ms}$ P95 latency.
- **Environment Variable**: Set in `.env`:
  ```env
  EXPO_PUBLIC_OSRM_ROUTING_URL=https://routing.yourdomain.com/route/v1/driving
  ```

---

## 4. Automated Daily Maintenance & Retention Purge

### A. Data Retention Policy Matrix

| Table / Asset | Retention Window | Purge Mechanism |
| :--- | :--- | :--- |
| `delivery_location_history` | **7 Days** | `purge_old_delivery_location_history(7)` (50k batch chunking) |
| `delivery_telemetry_events` | **30 Days** | `purge_old_delivery_telemetry_events(30)` |
| `public_tracking_rate_limits` | **10 Minutes** | `purge_expired_tracking_rate_limits()` |
| `delivery-photos` (Storage) | **90 Days** | Supabase Storage Lifecycle Policy |

### B. Automating with pg_cron
Run the following SQL snippet in the Supabase SQL Editor to automate daily maintenance at 03:00 AM IST:

```sql
-- Enable pg_cron extension if not enabled
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Schedule daily maintenance at 03:00 AM (21:30 UTC)
SELECT cron.schedule(
  'delivery_subsystem_daily_maintenance',
  '30 21 * * *',
  $$ SELECT public.run_delivery_subsystem_daily_maintenance(); $$
);
```

---

## 5. Incident Response & Troubleshooting Runbook

### Scenario A: Routing P95 Latency Degradation (>2,000ms)
1. **Symptoms**: Telemetry events log `routing_fallback` or `slow_p95`.
2. **Diagnosis**: Check if public OSRM is rate-limiting or experiencing latency spikes.
3. **Mitigation**:
   - The client automatically falls back to **Tier 2 (Google Routes API v2)** and **Tier 3 (OSM Secondary Mirror)**.
   - If Google Maps API key has quota issues, verify key quota in Google Cloud Console.

### Scenario B: Public Rate Limit Lockout for High-Volume Retailer
1. **Symptoms**: Retailer tracking page returns `"Too many requests. Please wait a minute before trying again."`
2. **Cause**: More than 30 RPC calls in a 1-minute window from a single IP.
3. **Mitigation**:
   - Admin can manually clear the rate limit token in Supabase:
     ```sql
     DELETE FROM public.public_tracking_rate_limits;
     ```
   - In steady state, Zero-RPC Realtime rendering prevents rate limit hits because customer tabs do not poll during transit.

### Scenario C: High Realtime Disconnect / Reconnect Rate
1. **Symptoms**: Health summary reports high `realtime_reconnects_24h`.
2. **Check**:
   - Verify Supabase Realtime peak connection count in the Supabase Dashboard metrics.
   - If connections approach 500, upgrade to the **Realtime 2.5k Add-on**.
