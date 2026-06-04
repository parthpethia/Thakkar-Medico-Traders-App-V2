import { Slot, useRouter } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import React, { useEffect, Component, type ReactNode } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useAuthStore } from '../src/store/authStore';
import { useSettingsStore } from '../src/store/settingsStore';
import { supabase, supabaseConfigError } from '../src/services/supabase';

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
    console.error('App ErrorBoundary caught:', error, info.componentStack);
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

function routeForUser(user: NonNullable<ReturnType<typeof useAuthStore.getState>['user']>) {
  if (user.role === 'admin') return '/admin';
  if (user.role === 'delivery') return '/delivery';
  return '/(tabs)';
}

/* ======================================================
   ROOT LAYOUT
====================================================== */

export default function RootLayout() {
  const router = useRouter();
  const { initAuth, fetchUser } = useAuthStore();
  const { fetchSettings } = useSettingsStore();

  useEffect(() => {
    let subscription: { unsubscribe: () => void } | undefined;

    async function bootstrap() {
      await SplashScreen.hideAsync().catch(() => {});

      try {
        await initAuth();

        if (!supabaseConfigError) {
          fetchSettings();
          const { data } = supabase.auth.onAuthStateChange((event) => {
            if (event === 'SIGNED_IN') {
              fetchUser({ silent: true });
            }
            if (event === 'SIGNED_OUT') {
              useAuthStore.setState({ user: null, isLoading: false, authReady: true });
              router.replace('/(auth)/login');
            }
          });
          subscription = data.subscription;
        }

        const { user } = useAuthStore.getState();
        if (user) {
          router.replace(routeForUser(user));
        }
      } catch (e) {
        console.error('Bootstrap error:', e);
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
    };
  }, []);

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <Slot />
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
