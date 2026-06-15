import Constants from 'expo-constants';

// ─── Environment variables ────────────────────────────────────────────
const APP_ENV = process.env.EXPO_PUBLIC_APP_ENV || 'development';

export const SUPABASE_URL: string = process.env.EXPO_PUBLIC_SUPABASE_URL || '';
export const SUPABASE_ANON_KEY: string = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';
export const APP_VERSION: string = Constants.expoConfig?.version || '1.0.0';

// ─── Environment flags ───────────────────────────────────────────────
export const IS_PRODUCTION: boolean = APP_ENV === 'production';
export const IS_STAGING: boolean = APP_ENV === 'staging';
export const IS_DEVELOPMENT: boolean = !IS_PRODUCTION && !IS_STAGING;

// ─── Contact & support ──────────────────────────────────────────────
export const SUPPORT_EMAIL: string = 'support@thakkarmedico.com';
export const SUPPORT_PHONE: string = process.env.EXPO_PUBLIC_SUPPORT_PHONE || '+919999999999';
export const APP_SCHEME: string = 'thakkarmedico';

// ─── Startup validation ─────────────────────────────────────────────
// In non-development builds, crash early if critical config is missing
// so the issue is caught during QA rather than silently failing.
if (!IS_DEVELOPMENT && (!SUPABASE_URL || !SUPABASE_ANON_KEY)) {
  throw new Error(
    `[Config] Missing required env vars for ${APP_ENV} build.\n` +
    `EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY must be set.\n` +
    `Set them in .env.${APP_ENV} or via EAS Secrets.`
  );
}
