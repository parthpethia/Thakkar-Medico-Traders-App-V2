import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  Alert,
  TextInput,
  Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../src/services/supabase';
import { OrderStatus } from '../../src/types';
import { format } from 'date-fns';

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
  delivery_type: string;
  fulfillment_mode: string;
  payment_mode: string;
  notes?: string;
  user_name: string;
  user_phone: string;
  cancellation_requested?: boolean;
  cancellation_reason?: string;
  cancellation_requested_at?: string;
  created_at: string;
};

/* ================= CONSTANTS ================= */

const statusColor: Record<string, string> = {
  pending: '#FFA726',
  approved: '#42A5F5',
  packed: '#7E57C2',
  dispatched: '#26A69A',
  delivered: '#66BB6A',
  cancelled: '#EF5350',
};

const statusIcon: Record<string, keyof typeof Ionicons.glyphMap> = {
  pending: 'time',
  approved: 'checkmark-circle',
  packed: 'cube',
  dispatched: 'car',
  delivered: 'checkmark-done-circle',
  cancelled: 'close-circle',
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
  if (status === 'cancelled') {
    return (
      <View style={styles.cancelledBar}>
        <Ionicons name="close-circle" size={20} color="#EF5350" />
        <Text style={styles.cancelledText}>Order Cancelled</Text>
      </View>
    );
  }

  const steps = deliveryType === 'pickup' ? pickupSteps : deliverySteps;
  const currentIndex = steps.findIndex((s) => s.key === status);

  return (
    <View style={styles.progressContainer}>
      {steps.map((step, index) => {
        const isCompleted = index <= currentIndex;
        const isLast = index === steps.length - 1;
        const color = isCompleted ? '#43A047' : '#ddd';

        return (
          <View key={step.key} style={styles.stepWrapper}>
            <View style={styles.stepRow}>
              <View style={[styles.stepCircle, { backgroundColor: color }]}>
                <Ionicons
                  name={isCompleted ? 'checkmark' : step.icon}
                  size={14}
                  color={isCompleted ? '#fff' : '#999'}
                />
              </View>
              {!isLast && (
                <View style={[styles.stepLine, { backgroundColor: index < currentIndex ? '#43A047' : '#ddd' }]} />
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
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [cancelModalVisible, setCancelModalVisible] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchOrder();
  }, [id]);

  const fetchOrder = async () => {
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
  };

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
          <ActivityIndicator size="large" color="#4C51C9" />
        </View>
      </SafeAreaView>
    );
  }

  if (!order) {
    return (
      <SafeAreaView style={styles.container}>
        <Stack.Screen options={{ title: 'Not Found' }} />
        <View style={styles.center}>
          <Ionicons name="alert-circle" size={64} color="#ccc" />
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
                { backgroundColor: statusColor[order.status] || '#999' },
              ]}
            >
              <Ionicons
                name={statusIcon[order.status] || 'help-circle'}
                size={14}
                color="#fff"
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
            <Text style={styles.sectionTitle}>Delivery Address</Text>
            <View style={styles.addressRow}>
              <Ionicons name="location-outline" size={18} color="#4C51C9" />
              <Text style={styles.addressText}>{order.delivery_address}</Text>
            </View>
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
            const lineTotal = item.selling_price * item.quantity;

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
                    ₹{item.selling_price.toFixed(2)} x {item.quantity}
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
              <Text style={[styles.summaryLabel, { color: '#43A047' }]}>Loyalty Discount</Text>
              <Text style={[styles.summaryValue, { color: '#43A047' }]}>
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

        {order.status !== 'cancelled' && (
          <TouchableOpacity
            style={styles.invoiceBtn}
            onPress={() =>
              router.push({
                pathname: '/order/invoice',
                params: { orderId: order.id },
              } as any)
            }
          >
            <Ionicons name="document-text-outline" size={20} color="#4C51C9" />
            <Text style={styles.invoiceBtnText}>View Invoice</Text>
          </TouchableOpacity>
        )}

        {/* Cancellation Request Section */}
        {order.cancellation_requested && order.status !== 'cancelled' && (
          <View style={styles.cancelRequestBanner}>
            <Ionicons name="warning" size={20} color="#E65100" />
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
        {order.status !== 'cancelled' &&
         order.status !== 'delivered' &&
         !order.cancellation_requested && (
          <TouchableOpacity
            style={styles.requestCancelBtn}
            onPress={() => setCancelModalVisible(true)}
          >
            <Ionicons name="close-circle-outline" size={20} color="#EF5350" />
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
              placeholderTextColor="#999"
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
                  <ActivityIndicator size="small" color="#fff" />
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
  return (
    <View style={styles.infoRow}>
      <View style={styles.infoLeft}>
        <Ionicons name={icon} size={16} color="#888" />
        <Text style={styles.infoLabel}>{label}</Text>
      </View>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

/* ================= STYLES ================= */

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },

  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },

  error: { marginTop: 12, color: '#888', fontSize: 16 },

  /* Status card */
  statusCard: {
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 14,
    marginBottom: 12,
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
  statusBadgeText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  orderDate: { fontSize: 12, color: '#999' },

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
    color: '#999',
    marginTop: 4,
    textAlign: 'center',
  },
  stepLabelActive: {
    color: '#43A047',
    fontWeight: '600',
  },
  cancelledBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#FFEBEE',
    borderRadius: 8,
    paddingVertical: 8,
  },
  cancelledText: {
    color: '#C62828',
    fontWeight: '600',
    fontSize: 13,
  },

  /* Section */
  section: {
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 14,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#333',
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
  infoLabel: { fontSize: 13, color: '#888' },
  infoValue: { fontSize: 13, fontWeight: '600', color: '#333' },

  /* Address */
  addressRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  addressText: {
    fontSize: 14,
    color: '#444',
    flex: 1,
    lineHeight: 20,
  },

  /* Notes */
  notesText: {
    fontSize: 14,
    color: '#555',
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
    borderBottomColor: '#f0f0f0',
  },
  itemLeft: { flex: 1, marginRight: 12 },
  itemName: { fontSize: 14, fontWeight: '600', color: '#333' },
  itemMeta: { fontSize: 12, color: '#888', marginTop: 2 },
  itemTotal: { fontSize: 14, fontWeight: '700', color: '#333' },

  /* Price summary */
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  summaryLabel: { fontSize: 14, color: '#666' },
  summaryValue: { fontSize: 14, color: '#333' },
  divider: {
    height: 1,
    backgroundColor: '#eee',
    marginVertical: 8,
  },
  grandTotalLabel: { fontSize: 16, fontWeight: '700', color: '#333' },
  grandTotalValue: { fontSize: 16, fontWeight: '700', color: '#4C51C9' },

  /* Cancel request */
  cancelRequestBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#FFF3E0',
    borderWidth: 1,
    borderColor: '#FFE0B2',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  cancelRequestBannerTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#E65100',
    marginBottom: 2,
  },
  cancelRequestBannerText: {
    fontSize: 13,
    color: '#BF360C',
  },
  cancelReasonText: {
    fontSize: 12,
    color: '#8D6E63',
    marginTop: 4,
    fontStyle: 'italic',
  },
  requestCancelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#FFF5F5',
    borderWidth: 1,
    borderColor: '#FFCDD2',
    borderRadius: 12,
    paddingVertical: 14,
    marginBottom: 12,
  },
  requestCancelBtnText: {
    color: '#EF5350',
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
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 24,
    width: '100%',
    maxWidth: 400,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#333',
    marginBottom: 4,
  },
  modalSubtitle: {
    fontSize: 13,
    color: '#888',
    marginBottom: 16,
  },
  modalInput: {
    borderWidth: 1,
    borderColor: '#e0e0e0',
    borderRadius: 10,
    padding: 12,
    fontSize: 14,
    color: '#333',
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
    backgroundColor: '#f5f5f5',
    alignItems: 'center',
  },
  modalCancelBtnText: {
    color: '#666',
    fontSize: 14,
    fontWeight: '600',
  },
  modalSubmitBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#EF5350',
    alignItems: 'center',
  },
  modalSubmitBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  invoiceBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#F3F3FF',
    borderWidth: 1,
    borderColor: '#DDDDF9',
    borderRadius: 12,
    paddingVertical: 14,
    marginBottom: 12,
  },
  invoiceBtnText: { color: '#4C51C9', fontSize: 15, fontWeight: '600' },
});
