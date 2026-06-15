// PA: CRIT-4 — Single routing authority; onboarding + auth decided in root layout
import { Slot, useRouter } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import React, { useEffect, useState, Component, type ReactNode } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Linking } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useAuthStore, type AppUser } from '../src/store/authStore';
import { useSettingsStore } from '../src/store/settingsStore';
import { supabase, supabaseConfigError } from '../src/services/supabase';
import { usePushNotifications } from '../src/hooks/usePushNotifications';
import { useAuthSession } from '../src/hooks/useAuthSession';
import { OfflineBanner } from '../src/components/OfflineBanner';
import { parseDeepLink } from '../src/utils/deepLink';
import { captureError, initErrorReporting, setUser, clearUser } from '../src/utils/errorReporting';
import '../src/i18n';

const ONBOARDING_KEY = 'onboarding_complete';

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
        <View style={ebStyles.container}>
          <Text style={ebStyles.emoji}>⚠️</Text>
          <Text style={ebStyles.title}>Something went wrong</Text>
          <Text style={ebStyles.message}>
            {this.state.error?.message || 'An unexpected error occurred'}
          </Text>
          <TouchableOpacity style={ebStyles.button} onPress={this.handleReset}>
            <Text style={ebStyles.buttonText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}

const ebStyles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f5f5f5',
    padding: 32,
  },
  emoji: { fontSize: 48, marginBottom: 16 },
  title: { fontSize: 20, fontWeight: '700', color: '#333', marginBottom: 8 },
  message: { fontSize: 14, color: '#666', textAlign: 'center', marginBottom: 24 },
  button: {
    backgroundColor: '#4C51C9',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
  },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
});

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

  useEffect(() => {
    initErrorReporting();
  }, []);

  useEffect(() => {
    let subscription: { unsubscribe: () => void } | undefined;
    let linkingSub: { remove: () => void } | undefined;
    let initialRouteSet = false;

    async function bootstrap() {
      await SplashScreen.hideAsync().catch(() => {});

      try {
        await initAuth();

        const onboardingRaw = await AsyncStorage.getItem(ONBOARDING_KEY);
        setOnboardingChecked(true);

        const onboardingDone = onboardingRaw === 'true';
        const { user: bootUser } = useAuthStore.getState();
        const hasSession = !!bootUser;

        if (!supabaseConfigError) {
          setTimeout(() => fetchSettings(), 800);
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

        if (!initialRouteSet) {
          initialRouteSet = true;
          if (!onboardingDone) {
            router.replace('/onboarding');
          } else if (!hasSession) {
            router.replace('/(auth)/login');
          } else {
            const { user } = useAuthStore.getState();
            if (user) {
              router.replace(routeForUser(user));
            } else {
              router.replace('/(auth)/login');
            }
          }
        }
      } catch (e) {
        captureError(e instanceof Error ? e : new Error(String(e)), { phase: 'bootstrap' });
        setOnboardingChecked(true);
        await SplashScreen.hideAsync().catch(() => {});
      }
    }

    bootstrap();

    const splashFailsafe = setTimeout(() => {
      SplashScreen.hideAsync().catch(() => {});
    }, 1500);

    return () => {
      clearTimeout(splashFailsafe);
      subscription?.unsubscribe();
      linkingSub?.remove();
    };
  }, []);

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <OfflineBanner />
        <Slot />
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
