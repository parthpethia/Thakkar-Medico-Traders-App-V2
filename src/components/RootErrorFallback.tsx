import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useThemedStyles } from '../theme/useThemedStyles';
import type { AppColors } from '../theme/colors';

type Props = {
  message?: string;
  onReset: () => void;
};

export function RootErrorFallback({ message, onReset }: Props) {
  const styles = useThemedStyles(createStyles);

  return (
    <View style={styles.container}>
      <Text style={styles.emoji}>⚠️</Text>
      <Text style={styles.title}>Something went wrong</Text>
      <Text style={styles.message}>{message || 'An unexpected error occurred'}</Text>
      <TouchableOpacity style={styles.button} onPress={onReset}>
        <Text style={styles.buttonText}>Try Again</Text>
      </TouchableOpacity>
    </View>
  );
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
    message: {
      fontSize: 14,
      color: c.textSecondary,
      textAlign: 'center' as const,
      marginBottom: 24,
    },
    button: {
      backgroundColor: c.primary,
      paddingHorizontal: 24,
      paddingVertical: 12,
      borderRadius: 10,
    },
    buttonText: { fontWeight: '600' as const, fontSize: 16, color: c.onPrimary },
  };
}
