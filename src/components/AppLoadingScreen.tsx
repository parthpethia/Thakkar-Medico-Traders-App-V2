import React from 'react';
import {
  View,
  ActivityIndicator,
  Image,
  Text,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppTheme } from '../hooks/useAppTheme';
import { useThemedStyles } from '../theme/useThemedStyles';
import type { AppColors } from '../theme/colors';

type Props = {
  message?: string;
  onRetry?: () => void;
};

export function AppLoadingScreen({ message = 'Loading...', onRetry }: Props) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Image
          source={require('../../assets/icon.png')}
          style={styles.logo}
          resizeMode="contain"
        />
        <Text style={styles.title}>Thakkar Medico Traders</Text>
        <ActivityIndicator size="large" color={colors.primary} style={styles.spinner} />
        <Text style={styles.message}>{message}</Text>
        {onRetry ? (
          <TouchableOpacity style={styles.retryButton} onPress={onRetry}>
            <Text style={styles.retryText}>Try again</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

function createStyles(c: AppColors) {
  return {
    container: {
      flex: 1,
      backgroundColor: c.background,
    },
    content: {
      flex: 1,
      justifyContent: 'center' as const,
      alignItems: 'center' as const,
      padding: 24,
    },
    logo: {
      width: 88,
      height: 88,
      borderRadius: 18,
      marginBottom: 16,
    },
    title: {
      fontSize: 22,
      fontWeight: '700' as const,
      color: c.primary,
      marginBottom: 32,
      textAlign: 'center' as const,
    },
    spinner: {
      marginBottom: 12,
    },
    message: {
      fontSize: 14,
      color: c.textSecondary,
      textAlign: 'center' as const,
    },
    retryButton: {
      marginTop: 20,
      backgroundColor: c.primary,
      paddingHorizontal: 24,
      paddingVertical: 12,
      borderRadius: 10,
    },
    retryText: {
      color: c.onPrimary,
      fontWeight: '600' as const,
      fontSize: 16,
    },
  };
}
