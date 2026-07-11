# Thakkar Medico Traders

A cross-platform mobile app built with Expo and React Native for Thakkar Medico Traders. The project uses TypeScript, Expo Router, Supabase, and a MySQL-backed database setup to support the app’s core business workflows.

## Features

- Expo Router-based navigation
- TypeScript-first React Native app
- Supabase integration
- MySQL schema setup for backend data models
- Push notifications, secure storage, location, camera, image picker, and localization support
- Biometric authentication support
- Web, Android, and iOS targets
- Jest test setup

## Tech Stack

- **Frontend:** React Native, Expo, Expo Router
- **Language:** TypeScript, JavaScript
- **Backend/Data:** Supabase, MySQL
- **Testing:** Jest, React Native Testing Library
- **Other:** Sentry, i18next, Async Storage, Secure Store

## Repository Structure

- `app/` – Expo Router screens and routes
- `src/` – Application source code and shared modules
- `assets/` – Icons, splash images, and other static assets
- `scripts/` – Utility scripts for schema verification and Supabase checks
- `supabase/` – Supabase-related configuration and database assets
- `__tests__/` – Test setup, mocks, and test files
- `backend-database-setup.sql` – Example backend schema definitions

## Getting Started

### Prerequisites

- Node.js and npm
- Expo CLI-compatible environment
- Android Studio, Xcode, or Expo Go, depending on your target platform

### Installation

```bash
npm install
```

### Run the app

```bash
npm run start
```

Other helpful scripts:

```bash
npm run web
npm run android
npm run ios
npm run test
npm run test:watch
npm run test:coverage
```

## Environment Setup

This repository includes environment templates such as:

- `.env.example`
- `.env.staging`
- `.env.production`

Copy or adapt the appropriate file for local development and ensure required Supabase and backend values are configured before running the app.

## Configuration Notes

The app is configured with:

- app name: **Thakkar Medico**
- slug: **thakkar-medico-traders**
- scheme: **thakkarmedico**
- Android package: **com.thakkarmedico.app**
- iOS bundle identifier: **com.thakkarmedico.app**

## Backend Schema

The included `backend-database-setup.sql` file demonstrates starter tables for:

- users
- products
- orders
- order_items

You can extend this schema to match your production requirements.

## Testing

Run the test suite with:

```bash
npm run test
```

## Notes

- The project uses Expo Router, so `App.tsx` simply loads the router entry point.
- Some backend and environment details may be project-specific and should be adjusted before production use.

## License

No license file is currently included in this repository.