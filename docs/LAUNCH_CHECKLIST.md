# Thakkar Medico — Launch Checklist

> Last updated: P6 milestone

## ☐ Pre-launch: Infrastructure

| # | Item | Owner | Done |
|---|------|-------|------|
| 1 | Run `supabase/migration-ordering-system-v1.sql` through `v8.sql` in order on **production** Supabase project | Backend | ☐ |
| 2 | Verify all RPCs exist: `SELECT proname FROM pg_proc WHERE proname LIKE '%order%' OR proname LIKE '%stock%' OR proname LIKE '%product%';` | Backend | ☐ |
| 3 | Enable Supabase Realtime on `orders`, `products`, `notifications` tables | Backend | ☐ |
| 4 | Create Supabase Edge Functions: `generate-invoice`, `generate-statement` — deploy with `supabase functions deploy` | Backend | ☐ |
| 5 | Set up Supabase Webhooks for WhatsApp notification triggers | Backend | ☐ |
| 6 | Configure Row Level Security (RLS) policies on all tables | Backend | ☐ |

---

## ☐ Pre-launch: Environment & Secrets

| # | Item | Owner | Done |
|---|------|-------|------|
| 7 | Create **production** Supabase project, copy URL and anon key to `.env.production` | DevOps | ☐ |
| 8 | Create **Sentry** project, copy DSN to `EXPO_PUBLIC_SENTRY_DSN` in `.env.production` | DevOps | ☐ |
| 9 | Set UPI merchant VPA in `EXPO_PUBLIC_UPI_VPA` | Business | ☐ |
| 10 | Set WhatsApp support number in `EXPO_PUBLIC_SUPPORT_WHATSAPP` | Business | ☐ |
| 11 | Verify `app.json` scheme is `thakkarmedico` | Dev | ☐ |
| 12 | Verify `.env.production` has `EXPO_PUBLIC_APP_ENV=production` | DevOps | ☐ |

---

## ☐ Pre-launch: EAS & Build

| # | Item | Owner | Done |
|---|------|-------|------|
| 13 | Run `eas credentials` to configure signing keys for Android + iOS | Dev | ☐ |
| 14 | Build staging: `eas build --profile staging --platform android` — install and smoke-test | Dev | ☐ |
| 15 | Build staging: `eas build --profile staging --platform ios` — install and smoke-test | Dev | ☐ |
| 16 | Run full test suite: `npm test` — all pass | Dev | ☐ |
| 17 | Run `npm run test:coverage` — review coverage gaps | Dev | ☐ |

---

## ☐ Pre-launch: App Store / Play Store

| # | Item | Owner | Done |
|---|------|-------|------|
| 18 | Prepare app store listing: title, description, screenshots, icon | Marketing | ☐ |
| 19 | Set `expo.android.versionCode` + `expo.ios.buildNumber` in `app.json` | Dev | ☐ |
| 20 | Build production: `eas build --profile production --platform all` | Dev | ☐ |
| 21 | Submit to Google Play Internal Testing track | Dev | ☐ |
| 22 | Submit to Apple TestFlight | Dev | ☐ |
| 23 | QA sign-off on TestFlight / Internal Testing builds | QA | ☐ |

---

## ☐ Pre-launch: Functional Verification

| # | Item | Verified |
|---|------|----------|
| 24 | Retailer: register → admin approval → login → browse → cart → checkout (COD) → order confirmation | ☐ |
| 25 | Retailer: place order (credit mode) → verify credit deduction | ☐ |
| 26 | Retailer: place order (UPI mode) → deep-link return works | ☐ |
| 27 | Retailer: loyalty points displayed, redeemable at checkout, capped | ☐ |
| 28 | Admin: approve order → pack → dispatch → deliver — full lifecycle | ☐ |
| 29 | Admin: batch approve/pack/cancel multiple orders | ☐ |
| 30 | Admin: create product with barcode SKU, scan to verify | ☐ |
| 31 | Admin: stock adjustment (restock, writeoff, correction, return) | ☐ |
| 32 | Admin: bulk restock — all quantities update | ☐ |
| 33 | Admin: analytics — date range filter, export CSV | ☐ |
| 34 | Admin: monthly statement PDF generation + share | ☐ |
| 35 | Delivery: create order → select retailer → scan barcode → place | ☐ |
| 36 | Delivery: dispatch → deliver → status updates in realtime | ☐ |
| 37 | Deep link: `thakkarmedico://order/[id]` opens order detail | ☐ |
| 38 | Deep link: password reset email → opens reset screen | ☐ |
| 39 | Push notification received on order status change | ☐ |
| 40 | WhatsApp notification sent for new admin orders | ☐ |
| 41 | Offline banner appears when network drops, hides on reconnect | ☐ |
| 42 | i18n: switch language to Hindi → all screens show Hindi text | ☐ |
| 43 | Biometric login enable/disable works | ☐ |

---

## ☐ Launch Day

| # | Item | Owner | Done |
|---|------|-------|------|
| 44 | Promote Play Store build from Internal → Production | Dev | ☐ |
| 45 | Submit App Store build for review → go live when approved | Dev | ☐ |
| 46 | Monitor Sentry for crash spikes (first 24h) | Dev | ☐ |
| 47 | Monitor Supabase dashboard — connection count, RPC latency | Backend | ☐ |
| 48 | Verify push notifications are delivered to 3+ real devices | QA | ☐ |

---

## ☐ Post-launch (Week 1)

| # | Item | Owner | Done |
|---|------|-------|------|
| 49 | Review Sentry errors — triage P0/P1 issues | Dev | ☐ |
| 50 | Review analytics dashboard — confirm data flowing | Business | ☐ |
| 51 | Collect feedback from 5+ retailers | Business | ☐ |
| 52 | Patch release if critical issues found | Dev | ☐ |
