// PA: CRIT-4 — Single routing authority; onboarding + auth decided in root layout
import 'react-native-get-random-values';
import { Slot, useRouter } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import React, { useEffect, useState, Component, type ReactNode } from 'react';
import { Linking, AppState } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '../src/lib/queryClient';
import { useAuthStore, type AppUser } from '../src/store/authStore';
import { useSettingsStore } from '../src/store/settingsStore';
import { coalesce } from '../src/lib/queryCoalescer';
import { supabase, supabaseConfigError } from '../src/services/supabase';
import { usePushNotifications } from '../src/hooks/usePushNotifications';
import { useDeliveryOtpPush } from '../src/hooks/useDeliveryOtpPush';
import { usePaymentFailedPush } from '../src/hooks/usePaymentFailedPush';
import { OfflineBanner } from '../src/components/OfflineBanner';
import { parseDeepLink } from '../src/utils/deepLink';
import { captureError, initErrorReporting, setUser, clearUser } from '../src/utils/errorReporting';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { RootErrorFallback } from '../src/components/RootErrorFallback';
import '../src/i18n';

async function logLoginEvent(userId: string, event: 'login' | 'logout' | 'password_reset') {
  try {
    await supabase.rpc('log_login_event', {
      p_user_id: userId,
      p_event: event,
      p_ip: '',
      p_user_agent: '',
    });
  } catch (err) {
    console.error('Failed to log login event:', err);
  }
}

/* ======================================================
   ERROR BOUNDARY
====================================================== */

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    captureError(error, { componentStack: info.componentStack });
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <RootErrorFallback
          message={this.state.error?.message}
          onReset={this.handleReset}
        />
      );
    }
    return this.props.children;
  }
}

export function routeForUser(user: AppUser) {
  if (user.role === 'admin') return '/admin';
  if (user.role === 'delivery') return '/delivery';
  return '/(tabs)';
}

/* ======================================================
   ROOT LAYOUT
====================================================== */

function navigateDeepLink(
  router: ReturnType<typeof useRouter>,
  parsed: { screen: string; params: Record<string, string> },
) {
  router.push({
    pathname: parsed.screen as any,
    params: parsed.params,
  });
}

export default function RootLayout() {
  const router = useRouter();
  const { initAuth, fetchUser } = useAuthStore();
  const { fetchSettings } = useSettingsStore();
  const [, setOnboardingChecked] = useState(false);

  const currentUser = useAuthStore((s) => s.user);
  usePushNotifications(currentUser?.id);
  useDeliveryOtpPush(currentUser?.id);
  usePaymentFailedPush(currentUser?.id);

  useEffect(() => {
    initErrorReporting();
  }, []);

  useEffect(() => {
    let subscription: { unsubscribe: () => void } | undefined;
    let linkingSub: { remove: () => void } | undefined;

    async function bootstrap() {
      try {
        await initAuth();

        setOnboardingChecked(true);

        if (!supabaseConfigError) {
          setTimeout(() => {
            void coalesce('settings', fetchSettings);
          }, 800);
          const { data } = supabase.auth.onAuthStateChange(async (event, session) => {
            if (event === 'SIGNED_IN' && session?.user) {
              const current = useAuthStore.getState().user;
              if (current?.id !== session.user.id) {
                await fetchUser({ silent: true });
              }
              const u = useAuthStore.getState().user;
              if (u) setUser(u.id, u.role);
              // Audit log
              void logLoginEvent(session.user.id, 'login');
            }
            if (event === 'SIGNED_OUT') {
              const outgoingUser = useAuthStore.getState().user;
              clearUser();
              useAuthStore.setState({ user: null, isLoading: false, authReady: true });
              router.replace('/(auth)/login');
              // Best-effort audit log (session already cleared)
              if (outgoingUser?.id) {
                void logLoginEvent(outgoingUser.id, 'logout');
              }
            }
            if (event === 'TOKEN_REFRESHED') {
              fetchUser({ silent: true });
            }
            if (event === 'USER_UPDATED' && session?.user) {
              void logLoginEvent(session.user.id, 'password_reset');
            }
          });
          subscription = data.subscription;

          linkingSub = Linking.addEventListener('url', ({ url }) => {
            try {
              const parsed = parseDeepLink(url);
              if (parsed) navigateDeepLink(router, parsed);
            } catch {}
          });

          Linking.getInitialURL()
            .then((url) => {
              if (!url) return;
              try {
                const parsed = parseDeepLink(url);
                if (parsed) {
                  setTimeout(() => navigateDeepLink(router, parsed), 500);
                }
              } catch {}
            })
            .catch(() => {});
        }
      } catch (e) {
        captureError(e instanceof Error ? e : new Error(String(e)), { phase: 'bootstrap' });
        setOnboardingChecked(true);
        useAuthStore.setState({ authReady: true, user: null, isLoading: false });
      } finally {
        await SplashScreen.hideAsync().catch(() => {});
      }
    }

    bootstrap();

    const splashFailsafe = setTimeout(() => {
      SplashScreen.hideAsync().catch(() => {});
      if (!useAuthStore.getState().authReady) {
        useAuthStore.setState({ authReady: true, isLoading: false });
      }
    }, 12000);

    return () => {
      clearTimeout(splashFailsafe);
      subscription?.unsubscribe();
      linkingSub?.remove();
    };
  }, []);

  // C2+C3: Revalidate session when app returns to foreground
  // OPT-10: Throttled to once per 5 min — autoRefreshToken handles token refresh
  useEffect(() => {
    let lastRevalidation = 0;
    const REVALIDATION_INTERVAL_MS = 5 * 60 * 1000;

    const handleAppStateChange = async (nextAppState: string) => {
      if (nextAppState !== 'active') return;
      const now = Date.now();
      if (now - lastRevalidation < REVALIDATION_INTERVAL_MS) return;
      lastRevalidation = now;
      try {
        // getUser() makes a network call to validate the JWT (unlike getSession)
        const { data: userData, error } = await supabase.auth.getUser();
        if (error || !userData.user) {
          // JWT expired and refresh token is also invalid
          const current = useAuthStore.getState().user;
          if (current) {
            await supabase.auth.signOut();
            // SIGNED_OUT handler above clears state + redirects
          }
        } else {
          // Session valid (possibly refreshed) — sync Zustand profile
          fetchUser({ silent: true });
        }
      } catch {
        // Network error on resume — don't kick user out
      }
    };

    const sub = AppState.addEventListener('change', handleAppStateChange);
    return () => sub.remove();
  }, [fetchUser]);

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <ErrorBoundary>
            <OfflineBanner />
            <Slot />
          </ErrorBoundary>
        </ThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
