// =============================================================================
// FIX E — UPI Payment Stub Screen
// Generates a UPI deeplink for the order amount and provides a "payment done"
// flow. In production, integrate with a payment gateway for confirmation.
// =============================================================================

import React, { useMemo, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  Linking,
  AppState,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

const UPI_PAYEE_VPA = 'merchant@upi';
const UPI_PAYEE_NAME = 'Thakkar Medico Traders';

export default function UpiPaymentScreen() {
  const router = useRouter();
  const { orderId, orderNumber, amount } = useLocalSearchParams<{
    orderId: string;
    orderNumber: string;
    amount: string;
  }>();

  const parsedAmount = parseFloat(amount || '0');
  const returnUrl = `thakkarmedico://checkout/upi-payment?orderId=${encodeURIComponent(orderId || '')}&orderNumber=${encodeURIComponent(orderNumber || '')}&amount=${encodeURIComponent(amount || '0')}`;

  const upiDeeplink = useMemo(() => {
    const params = new URLSearchParams({
      pa: UPI_PAYEE_VPA,
      pn: UPI_PAYEE_NAME,
      am: parsedAmount.toFixed(2),
      cu: 'INR',
      tn: `Order ${orderNumber}`,
      tr: orderId || '',
      url: returnUrl,
    });
    return `upi://pay?${params.toString()}`;
  }, [orderId, orderNumber, parsedAmount, returnUrl]);

  const openedUpi = useRef(false);

  const markPaymentDone = () => {
    Alert.alert(
      'Payment Confirmation',
      'Have you completed the payment?',
      [
        { text: 'Not Yet', style: 'cancel' },
        {
          text: 'Yes, Done',
          onPress: () => {
            Alert.alert(
              'Order Submitted',
              `Order #${orderNumber} is pending payment confirmation. You will be notified once verified.`,
              [{ text: 'OK', onPress: () => router.replace('/(tabs)') }],
            );
          },
        },
      ],
    );
  };

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && openedUpi.current) {
        openedUpi.current = false;
        markPaymentDone();
      }
    });
    return () => sub.remove();
  }, [orderNumber, router]);

  const openUpiApp = async () => {
    try {
      const supported = await Linking.canOpenURL(upiDeeplink);
      if (supported) {
        openedUpi.current = true;
        await Linking.openURL(upiDeeplink);
      } else {
        Alert.alert(
          'No UPI App Found',
          'Please install a UPI-enabled app (Google Pay, PhonePe, Paytm, etc.) to complete payment.',
        );
      }
    } catch {
      Alert.alert('Error', 'Could not open UPI app');
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <Stack.Screen options={{ title: 'UPI Payment' }} />

      <View style={styles.content}>
        <View style={styles.iconContainer}>
          <Ionicons name="phone-portrait-outline" size={64} color="#7E57C2" />
        </View>

        <Text style={styles.title}>Complete Payment via UPI</Text>
        <Text style={styles.orderLabel}>Order #{orderNumber}</Text>

        <View style={styles.amountCard}>
          <Text style={styles.amountLabel}>Amount to Pay</Text>
          <Text style={styles.amountValue}>₹{parsedAmount.toFixed(2)}</Text>
        </View>

        <TouchableOpacity style={styles.upiBtn} onPress={openUpiApp}>
          <Ionicons name="open-outline" size={20} color="#fff" />
          <Text style={styles.upiBtnText}>Open UPI App</Text>
        </TouchableOpacity>

        <Text style={styles.hint}>
          This will open your default UPI app (GPay, PhonePe, Paytm, etc.)
        </Text>

        <View style={styles.divider} />

        <TouchableOpacity style={styles.doneBtn} onPress={markPaymentDone}>
          <Ionicons name="checkmark-circle-outline" size={20} color="#4C51C9" />
          <Text style={styles.doneBtnText}>I've Completed Payment</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.cancelBtn}
          onPress={() => router.replace('/(tabs)')}
        >
          <Text style={styles.cancelBtnText}>Pay Later</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  iconContainer: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: '#F3E5F5',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#333',
    marginBottom: 4,
  },
  orderLabel: {
    fontSize: 14,
    color: '#888',
    marginBottom: 24,
  },
  amountCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    paddingHorizontal: 32,
    paddingVertical: 20,
    alignItems: 'center',
    marginBottom: 28,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
  },
  amountLabel: {
    fontSize: 13,
    color: '#888',
    marginBottom: 4,
  },
  amountValue: {
    fontSize: 32,
    fontWeight: '700',
    color: '#4C51C9',
  },
  upiBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#7E57C2',
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 12,
    marginBottom: 12,
  },
  upiBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  hint: {
    fontSize: 12,
    color: '#999',
    textAlign: 'center',
    marginBottom: 24,
  },
  divider: {
    height: 1,
    backgroundColor: '#e0e0e0',
    width: '100%',
    marginBottom: 24,
  },
  doneBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1.5,
    borderColor: '#4C51C9',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 12,
    marginBottom: 12,
  },
  doneBtnText: {
    color: '#4C51C9',
    fontSize: 15,
    fontWeight: '600',
  },
  cancelBtn: {
    paddingVertical: 12,
  },
  cancelBtnText: {
    color: '#888',
    fontSize: 14,
  },
});
