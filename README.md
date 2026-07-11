# Thakkar Medico Traders

Thakkar Medico is a role-based mobile ordering and delivery app for a medical wholesaler. Retailers can browse a product catalogue and place orders; administrators manage the catalogue, customers, stock, orders, and reporting; delivery staff fulfil assigned orders in the field.

The app is built with Expo and React Native, using Supabase for authentication, data, realtime updates, storage, and Edge Functions.

## What it supports

- **Retailers:** onboarding, email/phone/retailer-code login, catalogue search, cart, checkout, order tracking, invoices, payment options, and account settings.
- **Administrators:** retailer approval, catalogue and category management, stock history and restocking, order/POS operations, delivery tracking, analytics, and system settings.
- **Delivery staff:** assigned-order workflow, route support, location tracking, delivery proof/OTP handling, order editing, and retailer/order creation in the field.
- **Platform features:** offline awareness, push notifications, deep links, biometric sign-in, English/Hindi localisation, error reporting, and native Razorpay payments.

## Technology

| Area | Implementation |
| --- | --- |
| Mobile app | Expo SDK 54, React Native 0.81, Expo Router |
| State and UI | Zustand, React Native components, Expo modules |
| Backend | Supabase Auth, PostgreSQL, RLS/RPCs, Realtime, Storage, Edge Functions |
| Payments | Razorpay (native development or production build required) |
| Maps and scanning | Google Maps APIs, Expo Location/Camera, Google Vision OCR (optional) |
| Monitoring | Sentry |
| Tests | Jest with `jest-expo` and React Native Testing Library |

## Requirements

- Node.js LTS and npm
- A Supabase project
- Expo Go for general UI testing, or a native development build for Razorpay and other native-only flows
- Android Studio / Xcode when building locally for Android / iOS

## Get started

1. Install dependencies.

   ```bash
   npm install
   ```

2. Create your local environment file.

   ```bash
   Copy-Item .env.example .env
   ```

   In macOS/Linux, use `cp .env.example .env` instead.

3. Set the required Supabase values in `.env`.

   ```dotenv
   EXPO_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
   EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
   ```

4. Configure Supabase Auth:

   - Enable the **Email** provider.
   - Disable email confirmation for the development setup used by this app.
   - Keep the Phone provider disabled; phone numbers are profile data and may be used to resolve an email login.

5. In the Supabase SQL Editor, run [`supabase/setup.sql`](supabase/setup.sql) to create the base schema, policies, triggers, and RPCs. Apply the later migration files in [`supabase/`](supabase/) that are required by the version of the app you deploy. Do this in a staging project first and retain a migration history—these files are operational database changes.

6. Verify the client can reach the configured backend.

   ```bash
   npm run check:supabase
   npm run verify:schema
   ```

7. Start Expo.

   ```bash
   npm start
   ```

   Scan the QR code with Expo Go, or use a native build:

   ```bash
   npm run android
   # or
   npm run ios
   ```

## Environment variables

All `EXPO_PUBLIC_*` values are embedded in the client build. Do not place server secrets in them.

| Variable | Purpose | Required |
| --- | --- | --- |
| `EXPO_PUBLIC_SUPABASE_URL` | Supabase project URL | Yes |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous key | Yes |
| `EXPO_PUBLIC_APP_ENV` | `development`, `staging`, or `production` | Recommended |
| `EXPO_PUBLIC_SENTRY_DSN` | Sentry error-reporting DSN | Production recommended |
| `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` | Maps, places, geocoding, and routing | Optional |
| `EXPO_PUBLIC_GOOGLE_VISION_API_KEY` | Product-image OCR; also supported as a legacy maps-key fallback | Optional |

Supabase Edge Functions require their own server-side secrets, configured with the Supabase CLI or Dashboard rather than in `.env`:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` for order creation
- `RAZORPAY_WEBHOOK_SECRET` for the Razorpay webhook

## Useful commands

| Command | Description |
| --- | --- |
| `npm start` | Start Expo development server |
| `npm run start:go` | Start a cleared Expo Go session |
| `npm run android` / `npm run ios` | Run a local native build |
| `npm run web` | Run the web target |
| `npm test` | Run tests once |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Generate test coverage |
| `npm run check:supabase` | Validate the local Supabase URL configuration |
| `npm run verify:schema` | Check expected backend schema/RPC availability |

## Project layout

```text
app/                    Expo Router screens and route groups
  (auth)/               Sign-in, registration, and approval screens
  (tabs)/               Retailer experience
  admin/                Administrator workflows
  delivery/              Delivery workflows and field operations
  product/, order/      Product, checkout, and order-detail routes
src/
  components/           Reusable UI components
  hooks/                Auth, network, notifications, delivery, and UI hooks
  services/             Supabase, payments, maps, and image-recognition clients
  store/                Zustand stores
  theme/, i18n/         Theming and English/Hindi translations
  utils/                Error handling, validation, delivery, and query helpers
supabase/
  setup.sql             Base database installation
  migration-*.sql       Incremental schema and workflow changes
  functions/            Edge Functions for payments, notifications, invoices, statements, and OTPs
scripts/                Backend verification, configuration checks, and geocoding utilities
__tests__/              Unit and smoke tests
docs/                   Production runbook, launch checklist, and ordering audit
```

## Deployment

EAS build profiles are defined in [`eas.json`](eas.json):

```bash
# Internal staging APK / build
eas build --profile staging --platform android

# Store production builds
eas build --profile production --platform android
eas build --profile production --platform ios
```

For JavaScript-only production changes, publish an OTA update after validating it in staging:

```bash
eas update --branch production --message "describe the change"
```

See the [production runbook](docs/RUNBOOK.md) for operations, migrations, incident response, monitoring, and rollback guidance, and the [launch checklist](docs/LAUNCH_CHECKLIST.md) before a release.

## Notes for contributors

- Keep `.env` and all credentials out of version control. Use `.env.example` as the public template.
- Test changes with `npm test` before opening a review.
- Treat Supabase migrations and Edge Functions as deployable backend code; validate them against a staging project before production.
- Native Razorpay checkout is unavailable in Expo Go. Use `npm run android`, `npm run ios`, or an EAS build for payment testing.
