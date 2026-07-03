import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  Alert,
  TextInput,
  Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, Stack, useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../src/services/supabase';
import { OrderStatus } from '../../src/types';
import { format } from 'date-fns';
import { getDeliveryOtpForOrder } from '../../src/utils/deliveryOtpStore';
import { useAuthStore } from '../../src/store/authStore';
import { startRazorpayPaymentForOrder } from '../../src/services/razorpayService';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import type { AppColors } from '../../src/theme/colors';

/* ================= TYPES ================= */

type OrderItem = {
  product_name?: string;
  name?: string;
  quantity: number;
  selling_price: number;
  gst_percent?: number;
};

type Order = {
  id: string;
  order_number: string;
  status: OrderStatus;
  items: OrderItem[];
  subtotal: number;
  gst: number;
  grand_total: number;
  discount_amount: number;
  delivery_address: string;
  delivery_snapshot?: {
    shop_name?: string;
    landmark?: string;
    entry_notes?: string;
    receiver_name?: string;
    receiver_phone?: string;
    best_delivery_window?: string;
  } | null;
  delivery_type: string;
  fulfillment_mode: string;
  payment_mode: string;
  notes?: string;
  user_name: string;
  user_phone: string;
  cancellation_requested?: boolean;
  cancellation_reason?: string;
  cancellation_requested_at?: string;
  rejection_reason?: string;
  created_at: string;
};

/* ================= CONSTANTS ================= */

const statusColor: Record<string, string> = {
  pending: '#FFA726',
  pending_payment: '#9B59B6',
  payment_failed: '#E53935',
  approved: '#42A5F5',
  packed: '#7E57C2',
  dispatched: '#26A69A',
  delivered: '#66BB6A',
  cancelled: '#EF5350',
  rejected: '#EF5350',
};

const statusIcon: Record<string, keyof typeof Ionicons.glyphMap> = {
  pending: 'time',
  pending_payment: 'card',
  payment_failed: 'alert-circle',
  approved: 'checkmark-circle',
  packed: 'cube',
  dispatched: 'car',
  delivered: 'checkmark-done-circle',
  cancelled: 'close-circle',
  rejected: 'close-circle',
};

const deliverySteps: { key: OrderStatus; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: 'pending', label: 'Pending', icon: 'time' },
  { key: 'approved', label: 'Approved', icon: 'checkmark-circle' },
  { key: 'packed', label: 'Packed', icon: 'cube' },
  { key: 'dispatched', label: 'Dispatched', icon: 'car' },
  { key: 'delivered', label: 'Delivered', icon: 'checkmark-done-circle' },
];

const pickupSteps: { key: OrderStatus; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: 'pending', label: 'Pending', icon: 'time' },
  { key: 'approved', label: 'Approved', icon: 'checkmark-circle' },
  { key: 'packed', label: 'Packed', icon: 'cube' },
  { key: 'delivered', label: 'Picked Up', icon: 'checkmark-done-circle' },
];

/* ================= PROGRESS BAR ================= */

function OrderProgress({ status, deliveryType }: { status: OrderStatus; deliveryType: string }) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();

  if (status === 'cancelled') {
    return (
      <View style={styles.cancelledBar}>
        <Ionicons name="close-circle" size={20} color={colors.error} />
        <Text style={styles.cancelledText}>Order Cancelled</Text>
      </View>
    );
  }

  if (status === 'rejected') {
    return null;
  }

  const steps = deliveryType === 'pickup' ? pickupSteps : deliverySteps;
  const currentIndex = steps.findIndex((s) => s.key === status);

  return (
    <View style={styles.progressContainer}>
      {steps.map((step, index) => {
        const isCompleted = index <= currentIndex;
        const isLast = index === steps.length - 1;
        const color = isCompleted ? colors.success : colors.switchTrackOff;

        return (
          <View key={step.key} style={styles.stepWrapper}>
            <View style={styles.stepRow}>
              <View style={[styles.stepCircle, { backgroundColor: color }]}>
                <Ionicons
                  name={isCompleted ? 'checkmark' : step.icon}
                  size={14}
                  color={isCompleted ? colors.onPrimary : colors.textMuted}
                />
              </View>
              {!isLast && (
                <View
                  style={[
                    styles.stepLine,
                    { backgroundColor: index < currentIndex ? colors.success : colors.switchTrackOff },
                  ]}
                />
              )}
            </View>
            <Text style={[styles.stepLabel, isCompleted && styles.stepLabelActive]}>
              {step.label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/* ================= SCREEN ================= */

export default function OrderDetail() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
const { id, retryPayment } = useLocalSearchParams<{ id: string; retryPayment?: string }>();
  const router = useRouter();
  const { user } = useAuthStore();
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [cancelModalVisible, setCancelModalVisible] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [paymentRetrying, setPaymentRetrying] = useState(false);
  const [deliveryOtp, setDeliveryOtp] = useState<string | null>(null);
  const [otpChecked, setOtpChecked] = useState(false);
  const autoRetryDone = useRef(false);
  const [enabledModes, setEnabledModes] = useState<string[]>(['cod']);

  // Fetch settings on mount to see which payment modes are enabled
  useEffect(() => {
    (async () => {
      try {
        const { data } = await supabase
          .from('settings')
          .select('payment_modes_enabled')
          .limit(1)
          .single();
        if (data?.payment_modes_enabled && Array.isArray(data.payment_modes_enabled)) {
          setEnabledModes(data.payment_modes_enabled);
        }
      } catch (err) {
        console.error('Error fetching settings:', err);
      }
    })();
  }, []);

  const loadStoredOtp = useCallback(async () => {
    if (!id) return;
    const code = await getDeliveryOtpForOrder(String(id));
    setDeliveryOtp(code);
    setOtpChecked(true);
  }, [id]);

  const fetchOrder = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .eq('id', id)
        .single();

      if (error) throw error;
      setOrder(data);
    } catch (err) {
      console.error('Error fetching order:', err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchOrder();
  }, [fetchOrder]);

  useEffect(() => {
    void loadStoredOtp();
  }, [loadStoredOtp]);

  useFocusEffect(
    useCallback(() => {
      void loadStoredOtp();
    }, [loadStoredOtp]),
  );

  const retryUpiPayment = useCallback(async () => {
    if (!id || !order) return;
    setPaymentRetrying(true);
    try {
      const result = await startRazorpayPaymentForOrder(String(id), {
        contact: user?.phone || order.user_phone || undefined,
        email: user?.email || undefined,
      });

      if (result.ok) {
        Alert.alert(
          'Payment submitted',
          'Your order is being processed. You will be notified when payment is confirmed.',
        );
        await fetchOrder();
        return;
      }

      if (result.reason === 'cancelled') {
        Alert.alert('Payment not completed', 'You can try again when ready.');
        return;
      }

      Alert.alert('Payment error', result.message || 'Could not complete payment');
    } finally {
      setPaymentRetrying(false);
    }
  }, [id, order, user?.email, user?.phone, fetchOrder]);

  const changePaymentMode = async (newMode: 'cod' | 'credit') => {
    if (!id || !order) return;
    setPaymentRetrying(true);
    try {
      const { data, error } = await supabase.rpc('change_order_payment_mode', {
        p_order_id: String(id),
        p_payment_mode: newMode,
      });

      if (error) throw error;

      Alert.alert(
        'Success',
        `Payment mode successfully changed to ${
          newMode === 'cod' ? 'Cash on Delivery (COD)' : 'Credit'
        }.`,
      );
      await fetchOrder();
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to change payment mode');
    } finally {
      setPaymentRetrying(false);
    }
  };

  useEffect(() => {
    if (
      retryPayment !== '1' ||
      autoRetryDone.current ||
      !order ||
      order.status !== 'payment_failed'
    ) {
      return;
    }
    autoRetryDone.current = true;
    void retryUpiPayment();
  }, [retryPayment, order, retryUpiPayment]);

  const requestCancellation = async () => {
    if (!cancelReason.trim()) {
      Alert.alert('Required', 'Please provide a reason for cancellation.');
      return;
    }
    try {
      setSubmitting(true);
      const { error } = await supabase
        .from('orders')
        .update({
          cancellation_requested: true,
          cancellation_reason: cancelReason.trim(),
          cancellation_requested_at: new Date().toISOString(),
        })
        .eq('id', id);

      if (error) throw error;

      Alert.alert('Submitted', 'Your cancellation request has been sent to the admin for review.');
      setCancelModalVisible(false);
      setCancelReason('');
      fetchOrder();
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to submit request.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <Stack.Screen options={{ title: 'Loading...' }} />
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  if (!order) {
    return (
      <SafeAreaView style={styles.container}>
        <Stack.Screen options={{ title: 'Not Found' }} />
        <View style={styles.center}>
          <Ionicons name="alert-circle" size={64} color={colors.switchThumbOff} />
          <Text style={styles.error}>Order not found</Text>
        </View>
      </SafeAreaView>
    );
  }

  const itemCount = Array.isArray(order.items)
    ? order.items.reduce((sum, i) => sum + (i.quantity || 0), 0)
    : 0;

  const paymentLabel =
    order.payment_mode === 'cod'
      ? 'Cash on Delivery'
      : order.payment_mode === 'credit'
      ? 'Credit'
      : order.payment_mode === 'upi'
      ? 'UPI'
      : order.payment_mode?.toUpperCase() || 'COD';

  const isRejected = order.status === 'rejected';

  return (
    <SafeAreaView style={styles.container}>
      <Stack.Screen options={{ title: `#${order.order_number}` }} />

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        {/* Status card */}
        <View style={styles.statusCard}>
          <View style={styles.statusHeader}>
            <View
              style={[
                styles.statusBadge,
                { backgroundColor: statusColor[order.status] || colors.textMuted },
              ]}
            >
              <Ionicons
                name={statusIcon[order.status] || 'help-circle'}
                size={14}
                color={colors.onPrimary}
              />
              <Text style={styles.statusBadgeText}>
                {order.status.charAt(0).toUpperCase() + order.status.slice(1)}
              </Text>
            </View>
            <Text style={styles.orderDate}>
              {format(new Date(order.created_at), 'dd MMM yyyy, hh:mm a')}
            </Text>
          </View>

          {/* Progress tracker */}
          <OrderProgress status={order.status} deliveryType={order.delivery_type || 'delivery'} />
        </View>

        {isRejected ? (
          <View style={styles.rejectedBanner}>
            <Ionicons name="close-circle" size={24} color={colors.error} />
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={styles.rejectedBannerTitle}>Order rejected</Text>
              {order.rejection_reason ? (
                <Text style={styles.rejectedReasonText}>Reason: {order.rejection_reason}</Text>
              ) : null}
              <TouchableOpacity
                style={styles.placeNewOrderBtn}
                onPress={() => router.push('/(tabs)/products' as any)}
              >
                <Ionicons name="cart-outline" size={18} color={colors.onPrimary} />
                <Text style={styles.placeNewOrderBtnText}>Place new order</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}

        {!isRejected &&
          (order.status === 'pending_payment' || order.status === 'payment_failed') &&
          order.payment_mode === 'upi' && (
            <View style={styles.paymentCard}>
              <View style={styles.paymentCardHeader}>
                <Ionicons
                  name={order.status === 'payment_failed' ? 'alert-circle' : 'time-outline'}
                  size={20}
                  color={order.status === 'payment_failed' ? colors.error : colors.primary}
                />
                <Text style={styles.paymentCardTitle}>
                  {order.status === 'payment_failed' ? 'Payment Failed' : 'Payment Awaiting'}
                </Text>
              </View>
              <Text style={styles.paymentCardText}>
                {order.status === 'payment_failed'
                  ? 'Your UPI payment could not be completed. You can try again or switch to another payment method.'
                  : 'Your order is currently awaiting online payment. You can complete the UPI payment or switch to a different payment method below.'}
              </Text>

              <View style={styles.paymentCardActions}>
                <TouchableOpacity
                  style={styles.payRetryBtn}
                  onPress={() => void retryUpiPayment()}
                  disabled={paymentRetrying}
                >
                  {paymentRetrying ? (
                    <ActivityIndicator color={colors.onPrimary} size="small" />
                  ) : (
                    <>
                      <Ionicons
                        name={order.status === 'payment_failed' ? 'refresh' : 'card-outline'}
                        size={18}
                        color={colors.onPrimary}
                      />
                      <Text style={styles.payRetryBtnText}>
                        {order.status === 'payment_failed' ? 'Retry UPI Payment' : 'Pay via UPI Now'}
                      </Text>
                    </>
                  )}
                </TouchableOpacity>

                <Text style={styles.switchTitle}>Or switch payment method:</Text>

                <View style={styles.switchOptionsContainer}>
                  {enabledModes.includes('cod') && (
                    <TouchableOpacity
                      style={[styles.switchOptionBtn, paymentRetrying && { opacity: 0.6 }]}
                      onPress={() => void changePaymentMode('cod')}
                      disabled={paymentRetrying}
                    >
                      <Ionicons name="cash-outline" size={18} color={colors.primary} />
                      <Text style={styles.switchOptionBtnText}>Cash on Delivery (COD)</Text>
                    </TouchableOpacity>
                  )}

                  {enabledModes.includes('credit') && user?.role === 'retailer' && (
                    <TouchableOpacity
                      style={[styles.switchOptionBtn, paymentRetrying && { opacity: 0.6 }]}
                      onPress={() => void changePaymentMode('credit')}
                      disabled={paymentRetrying}
                    >
                      <Ionicons name="wallet-outline" size={18} color={colors.primary} />
                      <Text style={styles.switchOptionBtnText}>Use Credit</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            </View>
          )}

        {!isRejected && order.status === 'dispatched' && order.delivery_type !== 'pickup' ? (
          <View style={styles.otpCard}>
            {deliveryOtp ? (
              <>
                <Text style={styles.otpCardTitle}>Delivery OTP</Text>
                <Text style={styles.otpCodeDisplay}>{deliveryOtp}</Text>
                <Text style={styles.otpCardSubtext}>
                  Share this code with the delivery person to confirm receipt
                </Text>
              </>
            ) : otpChecked ? (
              <>
                <Text style={styles.otpCardTitle}>Delivery OTP</Text>
                <Text style={styles.otpMissingText}>
                  Your delivery OTP was sent to your notification. Check your notifications or ask
                  the delivery person to resend.
                </Text>
              </>
            ) : null}
          </View>
        ) : null}

        {/* Order info */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Order Details</Text>

          <InfoRow
            icon="receipt-outline"
            label="Order Number"
            value={`#${order.order_number}`}
          />
          <InfoRow
            icon="time-outline"
            label="Placed On"
            value={format(new Date(order.created_at), 'dd MMM yyyy, hh:mm a')}
          />
          <InfoRow
            icon={order.delivery_type === 'pickup' ? 'storefront-outline' : 'car-outline'}
            label="Delivery Type"
            value={order.delivery_type === 'pickup' ? 'Self Pickup' : 'Home Delivery'}
          />
          <InfoRow
            icon="card-outline"
            label="Payment Mode"
            value={paymentLabel}
          />
          <InfoRow
            icon="cube-outline"
            label="Total Items"
            value={`${itemCount} items`}
          />
        </View>

        {/* Delivery address */}
        {order.delivery_type !== 'pickup' && order.delivery_address ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Deliver To</Text>
            {order.delivery_snapshot?.shop_name ? (
              <Text style={styles.shopTitle}>{order.delivery_snapshot.shop_name}</Text>
            ) : null}
            <View style={styles.addressRow}>
              <Ionicons name="location-outline" size={18} color={colors.primary} />
              <Text style={styles.addressText}>{order.delivery_address}</Text>
            </View>
            {order.delivery_snapshot?.landmark ? (
              <Text style={styles.metaLine}>Landmark: {order.delivery_snapshot.landmark}</Text>
            ) : null}
            {order.delivery_snapshot?.receiver_name ? (
              <Text style={styles.metaLine}>
                Receiver: {order.delivery_snapshot.receiver_name}
                {order.delivery_snapshot.receiver_phone
                  ? ` · ${order.delivery_snapshot.receiver_phone}`
                  : ''}
              </Text>
            ) : null}
            {order.delivery_snapshot?.best_delivery_window ? (
              <View style={styles.windowBanner}>
                <Ionicons name="time-outline" size={16} color={colors.primary} />
                <Text style={styles.windowText}>
                  Preferred delivery: {order.delivery_snapshot.best_delivery_window}
                </Text>
              </View>
            ) : null}
            {order.delivery_snapshot?.entry_notes ? (
              <Text style={styles.metaLine}>Entry: {order.delivery_snapshot.entry_notes}</Text>
            ) : null}
          </View>
        ) : null}

        {/* Notes */}
        {order.notes ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Notes</Text>
            <Text style={styles.notesText}>{order.notes}</Text>
          </View>
        ) : null}

        {/* Items */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Items ({itemCount})</Text>

          {order.items.map((item, index) => {
            const name = item.product_name || item.name || 'Unknown';
            const unitPrice = Number(item.selling_price ?? (item as { price?: number }).price ?? 0);
            const qty = Number(item.quantity ?? 0);
            const lineTotal = unitPrice * qty;

            return (
              <View
                key={index}
                style={[
                  styles.itemRow,
                  index < order.items.length - 1 && styles.itemBorder,
                ]}
              >
                <View style={styles.itemLeft}>
                  <Text style={styles.itemName}>{name}</Text>
                  <Text style={styles.itemMeta}>
                    ₹{unitPrice.toFixed(2)} x {qty}
                  </Text>
                </View>
                <Text style={styles.itemTotal}>₹{lineTotal.toFixed(2)}</Text>
              </View>
            );
          })}
        </View>

        {/* Price summary */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Price Summary</Text>

          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Subtotal</Text>
            <Text style={styles.summaryValue}>₹{(order.subtotal || 0).toFixed(2)}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>GST</Text>
            <Text style={styles.summaryValue}>₹{(order.gst || 0).toFixed(2)}</Text>
          </View>
          {(order.discount_amount || 0) > 0 && (
            <View style={styles.summaryRow}>
              <Text style={[styles.summaryLabel, { color: colors.success }]}>Loyalty Discount</Text>
              <Text style={[styles.summaryValue, { color: colors.success }]}>
                -₹{(order.discount_amount || 0).toFixed(2)}
              </Text>
            </View>
          )}
          <View style={styles.divider} />
          <View style={styles.summaryRow}>
            <Text style={styles.grandTotalLabel}>Grand Total</Text>
            <Text style={styles.grandTotalValue}>₹{(order.grand_total || 0).toFixed(2)}</Text>
          </View>
        </View>

        {order.status !== 'cancelled' && !isRejected && (
          <TouchableOpacity
            style={styles.invoiceBtn}
            onPress={() =>
              router.push({
                pathname: '/order/invoice',
                params: { orderId: order.id },
              } as any)
            }
          >
            <Ionicons name="document-text-outline" size={20} color={colors.primary} />
            <Text style={styles.invoiceBtnText}>View Invoice</Text>
          </TouchableOpacity>
        )}

        {/* Cancellation Request Section */}
        {order.cancellation_requested && order.status !== 'cancelled' && (
          <View style={styles.cancelRequestBanner}>
            <Ionicons name="warning" size={20} color={colors.warning} />
            <View style={{ flex: 1, marginLeft: 8 }}>
              <Text style={styles.cancelRequestBannerTitle}>Cancellation Requested</Text>
              <Text style={styles.cancelRequestBannerText}>
                Your cancellation request is pending admin review.
              </Text>
              {order.cancellation_reason ? (
                <Text style={styles.cancelReasonText}>Reason: {order.cancellation_reason}</Text>
              ) : null}
            </View>
          </View>
        )}

        {/* Request Cancellation Button */}
        {!isRejected &&
         order.status !== 'cancelled' &&
         order.status !== 'delivered' &&
         !order.cancellation_requested && (
          <TouchableOpacity
            style={styles.requestCancelBtn}
            onPress={() => setCancelModalVisible(true)}
          >
            <Ionicons name="close-circle-outline" size={20} color={colors.error} />
            <Text style={styles.requestCancelBtnText}>Request Cancellation</Text>
          </TouchableOpacity>
        )}
      </ScrollView>

      {/* Cancel Request Modal */}
      <Modal
        visible={cancelModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setCancelModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Request Cancellation</Text>
            <Text style={styles.modalSubtitle}>
              Please provide a reason for cancelling order #{order.order_number}
            </Text>

            <TextInput
              style={styles.modalInput}
              placeholder="Reason for cancellation..."
              placeholderTextColor={colors.textMuted}
              multiline
              numberOfLines={3}
              value={cancelReason}
              onChangeText={setCancelReason}
            />

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.modalCancelBtn}
                onPress={() => {
                  setCancelModalVisible(false);
                  setCancelReason('');
                }}
              >
                <Text style={styles.modalCancelBtnText}>Go Back</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.modalSubmitBtn, submitting && { opacity: 0.6 }]}
                onPress={requestCancellation}
                disabled={submitting}
              >
                {submitting ? (
                  <ActivityIndicator size="small" color={colors.onPrimary} />
                ) : (
                  <Text style={styles.modalSubmitBtnText}>Submit Request</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

/* ================= COMPONENTS ================= */

function InfoRow({
  icon,
  label,
  value,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
}) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();

  return (
    <View style={styles.infoRow}>
      <View style={styles.infoLeft}>
        <Ionicons name={icon} size={16} color={colors.textMuted} />
        <Text style={styles.infoLabel}>{label}</Text>
      </View>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

/* ================= STYLES ================= */

function createStyles(c: AppColors, isDark: boolean) {
  return {
  container: { flex: 1, backgroundColor: c.background },

  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },

  error: { marginTop: 12, color: c.textMuted, fontSize: 16 },

  /* Status card */
  statusCard: {
    backgroundColor: c.surface,
    padding: 16,
    borderRadius: 14,
    marginBottom: 12,
  },
  otpCard: {
    backgroundColor: c.primaryMuted,
    borderWidth: 1,
    borderColor: c.cardBorder,
    padding: 20,
    borderRadius: 14,
    marginBottom: 12,
    alignItems: 'center',
  },
  otpCardTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: c.primary,
    marginBottom: 8,
  },
  otpCodeDisplay: {
    fontSize: 40,
    fontWeight: '800',
    letterSpacing: 8,
    color: c.text,
    marginVertical: 4,
  },
  otpCardSubtext: {
    fontSize: 13,
    color: c.textSecondary,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 18,
  },
  otpMissingText: {
    fontSize: 13,
    color: c.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  statusHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  statusBadgeText: { color: c.surface, fontSize: 13, fontWeight: '600' },
  orderDate: { fontSize: 12, color: c.textMuted },

  /* Progress */
  progressContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
  },
  stepWrapper: {
    alignItems: 'center',
    flex: 1,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    justifyContent: 'center',
  },
  stepCircle: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepLine: {
    flex: 1,
    height: 3,
    borderRadius: 2,
  },
  stepLabel: {
    fontSize: 9,
    color: c.textMuted,
    marginTop: 4,
    textAlign: 'center',
  },
  stepLabelActive: {
    color: c.success,
    fontWeight: '600',
  },
  cancelledBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: isDark ? c.surfaceSecondary : '#FFEBEE',
    borderRadius: 8,
    paddingVertical: 8,
  },
  cancelledText: {
    color: c.error,
    fontWeight: '600',
    fontSize: 13,
  },
  rejectedBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: isDark ? c.surfaceSecondary : '#FFEBEE',
    borderWidth: 1,
    borderColor: c.error,
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
  },
  rejectedBannerTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: c.error,
    marginBottom: 6,
  },
  rejectedReasonText: {
    fontSize: 14,
    color: c.textSecondary,
    lineHeight: 20,
    marginBottom: 12,
  },
  placeNewOrderBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: c.primary,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignSelf: 'flex-start',
  },
  placeNewOrderBtnText: {
    color: c.surface,
    fontSize: 14,
    fontWeight: '600',
  },

  /* Section */
  section: {
    backgroundColor: c.surface,
    padding: 16,
    borderRadius: 14,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: c.text,
    marginBottom: 12,
  },

  /* Info rows */
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
  },
  infoLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  infoLabel: { fontSize: 13, color: c.textMuted },
  infoValue: { fontSize: 13, fontWeight: '600', color: c.text },

  /* Address */
  addressRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  addressText: {
    fontSize: 14,
    color: c.text,
    flex: 1,
    lineHeight: 20,
  },
  shopTitle: { fontSize: 16, fontWeight: '700', color: c.text, marginBottom: 8 },
  metaLine: { fontSize: 13, color: c.textSecondary, marginTop: 6 },
  windowBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
    backgroundColor: c.primaryMuted,
    padding: 10,
    borderRadius: 8,
  },
  windowText: { fontSize: 13, color: c.text, fontWeight: '600', flex: 1 },

  /* Notes */
  notesText: {
    fontSize: 14,
    color: c.textSecondary,
    lineHeight: 20,
  },

  /* Item rows */
  itemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
  },
  itemBorder: {
    borderBottomWidth: 1,
    borderBottomColor: c.borderLight,
  },
  itemLeft: { flex: 1, marginRight: 12 },
  itemName: { fontSize: 14, fontWeight: '600', color: c.text },
  itemMeta: { fontSize: 12, color: c.textMuted, marginTop: 2 },
  itemTotal: { fontSize: 14, fontWeight: '700', color: c.text },

  /* Price summary */
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  summaryLabel: { fontSize: 14, color: c.textSecondary },
  summaryValue: { fontSize: 14, color: c.text },
  divider: {
    height: 1,
    backgroundColor: c.border,
    marginVertical: 8,
  },
  grandTotalLabel: { fontSize: 16, fontWeight: '700', color: c.text },
  grandTotalValue: { fontSize: 16, fontWeight: '700', color: c.primary },

  paymentCard: {
    backgroundColor: isDark ? '#20202e' : '#f0f1ff',
    borderWidth: 1.5,
    borderColor: c.primary,
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    shadowColor: c.shadow,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  paymentCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  paymentCardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: c.text,
  },
  paymentCardText: {
    fontSize: 13,
    color: c.textSecondary,
    lineHeight: 18,
    marginBottom: 14,
  },
  paymentCardActions: {
    gap: 12,
  },
  payRetryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: c.primary,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
    width: '100%',
  },
  payRetryBtnText: {
    color: c.onPrimary,
    fontWeight: '600',
    fontSize: 15,
  },
  switchTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: c.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 4,
  },
  switchOptionsContainer: {
    flexDirection: 'column',
    gap: 8,
  },
  switchOptionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  switchOptionBtnText: {
    color: c.text,
    fontSize: 14,
    fontWeight: '600',
  },

  /* Cancel request */
  cancelRequestBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: c.warningBg,
    borderWidth: 1,
    borderColor: c.warning,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  cancelRequestBannerTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: c.warning,
    marginBottom: 2,
  },
  cancelRequestBannerText: {
    fontSize: 13,
    color: c.warning,
  },
  cancelReasonText: {
    fontSize: 12,
    color: c.loyaltyInfoText,
    marginTop: 4,
    fontStyle: 'italic',
  },
  requestCancelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: isDark ? c.surfaceSecondary : '#FFF5F5',
    borderWidth: 1,
    borderColor: c.error,
    borderRadius: 12,
    paddingVertical: 14,
    marginBottom: 12,
  },
  requestCancelBtnText: {
    color: c.error,
    fontSize: 15,
    fontWeight: '600',
  },

  /* Modal */
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalContent: {
    backgroundColor: c.surface,
    borderRadius: 16,
    padding: 24,
    width: '100%',
    maxWidth: 400,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: c.text,
    marginBottom: 4,
  },
  modalSubtitle: {
    fontSize: 13,
    color: c.textMuted,
    marginBottom: 16,
  },
  modalInput: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 10,
    padding: 12,
    fontSize: 14,
    color: c.text,
    minHeight: 80,
    textAlignVertical: 'top',
    marginBottom: 16,
  },
  modalActions: {
    flexDirection: 'row',
    gap: 10,
  },
  modalCancelBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: c.background,
    alignItems: 'center',
  },
  modalCancelBtnText: {
    color: c.textSecondary,
    fontSize: 14,
    fontWeight: '600',
  },
  modalSubmitBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: c.error,
    alignItems: 'center',
  },
  modalSubmitBtnText: {
    color: c.surface,
    fontSize: 14,
    fontWeight: '600',
  },
  invoiceBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: c.primaryMuted,
    borderWidth: 1,
    borderColor: c.cardBorder,
    borderRadius: 12,
    paddingVertical: 14,
    marginBottom: 12,
  },
  invoiceBtnText: { color: c.primary, fontSize: 15, fontWeight: '600' },
};
}
