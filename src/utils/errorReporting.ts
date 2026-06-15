// P6: Sentry error reporting — replaces stub with real integration
import * as Sentry from '@sentry/react-native';
import { IS_PRODUCTION, IS_STAGING } from '../constants/config';

let _initialized = false;

/**
 * Initialize Sentry error reporting.
 * Call once in app/_layout.tsx before anything else.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function initErrorReporting(): void {
  try {
    if (_initialized) return;
    _initialized = true;

    const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN || '';
    if (!dsn) {
      if (__DEV__) console.log('[Sentry] No DSN configured — reporting disabled');
      return;
    }

    Sentry.init({
      dsn,
      environment: process.env.EXPO_PUBLIC_APP_ENV || 'development',
      enabled: IS_PRODUCTION || IS_STAGING,
      tracesSampleRate: IS_PRODUCTION ? 0.2 : 1.0,
    });
  } catch {
    // initErrorReporting must never throw
  }
}

/**
 * Capture an error with optional context.
 * Never throws — the app must not crash because error reporting crashed.
 */
export function captureError(error: Error, context?: Record<string, any>): void {
  try {
    if (__DEV__) {
      console.error('[ErrorReport]', error.message, context ?? '');
    }

    if (_initialized) {
      if (context) {
        Sentry.withScope((scope) => {
          Object.entries(context).forEach(([key, value]) => {
            scope.setExtra(key, value);
          });
          Sentry.captureException(error);
        });
      } else {
        Sentry.captureException(error);
      }
    }
  } catch {
    // captureError must never throw
  }
}

/**
 * Set user context for Sentry — call after SIGNED_IN.
 */
export function setUser(userId: string, role?: string): void {
  try {
    if (_initialized) {
      Sentry.setUser({ id: userId, role });
    }
  } catch {
    // setUser must never throw
  }
}

/**
 * Clear user context — call on SIGNED_OUT.
 */
export function clearUser(): void {
  try {
    if (_initialized) {
      Sentry.setUser(null);
    }
  } catch {
    // clearUser must never throw
  }
}
