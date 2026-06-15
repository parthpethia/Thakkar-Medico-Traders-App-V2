import React, { Component, type ReactNode } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { router } from 'expo-router';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
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
        <View style={styles.container}>
          <Text style={styles.emoji}>⚠️</Text>
          <Text style={styles.title}>Something went wrong</Text>
          {__DEV__ && this.state.error && (
            <Text style={styles.devMessage}>{this.state.error.message}</Text>
          )}
          <View style={styles.actions}>
            <TouchableOpacity style={styles.primaryBtn} onPress={this.handleReset}>
              <Text style={styles.primaryBtnText}>Try Again</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.secondaryBtn} onPress={this.handleGoHome}>
              <Text style={styles.secondaryBtnText}>Go Home</Text>
            </TouchableOpacity>
          </View>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f5f5f5',
    padding: 32,
  },
  emoji: { fontSize: 48, marginBottom: 16 },
  title: { fontSize: 20, fontWeight: '700', color: '#333', marginBottom: 8 },
  devMessage: {
    fontSize: 12,
    color: '#888',
    textAlign: 'center',
    marginBottom: 24,
    maxWidth: 300,
  },
  actions: { flexDirection: 'row', gap: 12, marginTop: 16 },
  primaryBtn: {
    backgroundColor: '#4C51C9',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
  },
  primaryBtnText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  secondaryBtn: {
    backgroundColor: '#f0f0f0',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
  },
  secondaryBtnText: { color: '#555', fontWeight: '600', fontSize: 15 },
});
