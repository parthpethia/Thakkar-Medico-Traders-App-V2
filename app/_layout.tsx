// PA: CRIT-4 — Single routing authority; onboarding + auth decided in root layout
import 'react-native-get-random-values';
import { Slot, useRouter } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import React, { useEffect, useState, Component, type ReactNode } from 'react';
import { Linking } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useAuthStore, type AppUser } from '../src/store/authStore';
import { useSettingsStore } from '../src/store/settingsStore';
import { coalesce } from '../src/lib/queryCoalescer';
import { supabase, supabaseConfigError } from '../src/services/supabase';
import { usePushNotifications } from '../src/hooks/usePushNotifications';
import { useDeliveryOtpPush } from '../src/hooks/useDeliveryOtpPush';
import { usePaymentFailedPush } from '../src/hooks/usePaymentFailedPush';
import { useAuthSession } from '../src/hooks/useAuthSession';
import { OfflineBanner } from '../src/components/OfflineBanner';
import { parseDeepLink } from '../src/utils/deepLink';
import { captureError, initErrorReporting, setUser, clearUser } from '../src/utils/errorReporting';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { RootErrorFallback } from '../src/components/RootErrorFallback';
import '../src/i18n';

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

  useAuthSession();

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
          const { data } = supabase.auth.onAuthStateChange((event, session) => {
            if (event === 'SIGNED_IN' && session?.user) {
              const current = useAuthStore.getState().user;
              if (current?.id !== session.user.id) {
                fetchUser({ silent: true });
              }
              const u = useAuthStore.getState().user;
              if (u) setUser(u.id, u.role);
            }
            if (event === 'SIGNED_OUT') {
              clearUser();
              useAuthStore.setState({ user: null, isLoading: false, authReady: true });
              router.replace('/(auth)/login');
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

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ErrorBoundary>
          <OfflineBanner />
          <Slot />
        </ErrorBoundary>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
