import React, { Component, type ReactNode } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { router } from 'expo-router';
import { useThemedStyles } from '../theme/useThemedStyles';
import type { AppColors } from '../theme/colors';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

function ErrorFallback({
  error,
  onReset,
  onGoHome,
}: {
  error: Error | null;
  onReset: () => void;
  onGoHome: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.container}>
      <Text style={styles.emoji}>⚠️</Text>
      <Text style={styles.title}>Something went wrong</Text>
      {__DEV__ && error && (
        <Text style={styles.devMessage}>{error.message}</Text>
      )}
      <View style={styles.actions}>
        <TouchableOpacity style={styles.primaryBtn} onPress={onReset}>
          <Text style={styles.primaryBtnText}>Try Again</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryBtn} onPress={onGoHome}>
          <Text style={styles.secondaryBtnText}>Go Home</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

/**
 * React error boundary for wrapping major screen sections.
 * Shows a user-friendly fallback with retry and navigation options.
 * Error details are only displayed in development mode.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  handleGoHome = () => {
    this.setState({ hasError: false, error: null });
    try {
      router.replace('/');
    } catch {
      // Navigation may fail if router isn't ready
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <ErrorFallback
          error={this.state.error}
          onReset={this.handleReset}
          onGoHome={this.handleGoHome}
        />
      );
    }
    return this.props.children;
  }
}

function createStyles(c: AppColors) {
  return {
    container: {
      flex: 1,
      justifyContent: 'center' as const,
      alignItems: 'center' as const,
      backgroundColor: c.background,
      padding: 32,
    },
    emoji: { fontSize: 48, marginBottom: 16 },
    title: { fontSize: 20, fontWeight: '700' as const, color: c.text, marginBottom: 8 },
    devMessage: {
      fontSize: 12,
      color: c.textMuted,
      textAlign: 'center' as const,
      marginBottom: 24,
      maxWidth: 300,
    },
    actions: { flexDirection: 'row' as const, gap: 12, marginTop: 16 },
    primaryBtn: {
      backgroundColor: c.primary,
      paddingHorizontal: 24,
      paddingVertical: 12,
      borderRadius: 10,
    },
    primaryBtnText: { color: c.onPrimary, fontWeight: '600' as const, fontSize: 15 },
    secondaryBtn: {
      backgroundColor: c.borderLight,
      paddingHorizontal: 24,
      paddingVertical: 12,
      borderRadius: 10,
    },
    secondaryBtnText: { color: c.textSecondary, fontWeight: '600' as const, fontSize: 15 },
  };
}
