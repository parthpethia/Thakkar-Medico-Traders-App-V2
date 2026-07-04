// Razorpay checkout after UPI order placement (payment confirmation via webhook)

import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../../src/store/authStore';
import { startRazorpayPaymentForOrder, type RazorpayCheckoutResult } from '../../src/services/razorpayService';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import type { AppColors } from '../../src/theme/colors';

export default function UpiPaymentScreen() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const router = useRouter();
  const { user } = useAuthStore();
  const { orderId, orderNumber, amount } = useLocalSearchParams<{
    orderId: string;
    orderNumber: string;
    amount: string;
  }>();

  const parsedAmount = parseFloat(amount || '0');
  const started = useRef(false);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    if (!orderId || started.current) return;
    started.current = true;

    (async () => {
      const result = await startRazorpayPaymentForOrder(orderId, {
        contact: user?.phone || undefined,
        email: user?.email || undefined,
      });

      setBusy(false);

      if (result.ok) {
        Alert.alert(
          'Payment submitted',
          'Your order is being processed. You will be notified when payment is confirmed.',
          [{ text: 'OK', onPress: () => router.replace('/(tabs)') }],
        );
        return;
      }

      const errResult = result as Extract<RazorpayCheckoutResult, { ok: false }>;
      if (errResult.reason === 'cancelled') {
        Alert.alert(
          'Payment not completed',
          'You can retry payment from your order details.',
          [{ text: 'OK', onPress: () => router.replace('/(tabs)') }],
        );
        return;
      }

      Alert.alert('Payment error', errResult.message || 'Could not open payment', [
        { text: 'OK', onPress: () => router.replace('/(tabs)') },
      ]);
    })();
  }, [orderId, router, user?.email, user?.phone]);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <Stack.Screen options={{ title: 'UPI Payment' }} />

      <View style={styles.content}>
        <View style={styles.iconContainer}>
          <Ionicons name="card-outline" size={64} color={colors.primary} />
        </View>

        <Text style={styles.title}>Secure UPI Payment</Text>
        <Text style={styles.orderLabel}>Order #{orderNumber}</Text>

        <View style={styles.amountCard}>
          <Text style={styles.amountLabel}>Amount to Pay</Text>
          <Text style={styles.amountValue}>₹{parsedAmount.toFixed(2)}</Text>
        </View>

        {busy ? (
          <>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={styles.hint}>Opening Razorpay checkout…</Text>
          </>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

function createStyles(c: AppColors, isDark: boolean) {
  return {
    container: {
      flex: 1,
      backgroundColor: c.background,
    },
    content: {
      flex: 1,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      padding: 24,
    },
    iconContainer: {
      width: 100,
      height: 100,
      borderRadius: 50,
      backgroundColor: isDark ? c.primaryMuted : '#F3E5F5',
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      marginBottom: 20,
    },
    title: {
      fontSize: 20,
      fontWeight: '700' as const,
      color: c.text,
      marginBottom: 4,
    },
    orderLabel: {
      fontSize: 14,
      color: c.textMuted,
      marginBottom: 24,
    },
    amountCard: {
      backgroundColor: c.surface,
      borderRadius: 16,
      paddingHorizontal: 32,
      paddingVertical: 20,
      alignItems: 'center' as const,
      marginBottom: 28,
      elevation: 2,
      shadowColor: c.shadow,
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.08,
      shadowRadius: 4,
    },
    amountLabel: {
      fontSize: 13,
      color: c.textMuted,
      marginBottom: 4,
    },
    amountValue: {
      fontSize: 32,
      fontWeight: '700' as const,
      color: c.primary,
    },
    hint: {
      fontSize: 14,
      color: c.textSecondary,
      marginTop: 16,
      textAlign: 'center' as const,
    },
  };
}
