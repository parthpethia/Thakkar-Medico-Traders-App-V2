// PA: H5 — pending_payment status color aligned with admin list
import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../../src/services/supabase';
import { OrderStatus } from '../../../src/types';
import { format } from 'date-fns';

/* ================= TYPES ================= */

type OrderItem = {
  product_name?: string;
  name?: string;
  quantity: number;
  selling_price: number;
  gst_percent?: number;
};

type OrderDetail = {
  id: string;
  order_number: string;
  status: OrderStatus;
  items: OrderItem[];
  subtotal: number;
  gst: number;
  grand_total: number;
  discount_amount: number;             // CHANGED: FIX B
  delivery_address: string;
  delivery_type: string;
  fulfillment_mode: string;            // CHANGED: FIX C
  payment_mode: string;
  notes?: string;
  user_name: string;
  user_phone: string;
  user_id: string;
  cancellation_requested?: boolean;
  cancellation_reason?: string;
  cancellation_requested_at?: string;
  created_at: string;
};

type TimelineEvent = {
  from_status: string | null;
  to_status: string;
  actor_name: string;
  created_at: string;
};

/* ================= CONSTANTS ================= */

const statusColor: Record<string, string> = {
  pending: '#FFA726',
  pending_payment: '#9B59B6',
  approved: '#42A5F5',
  packed: '#7E57C2',
  dispatched: '#26A69A',
  delivered: '#66BB6A',
  cancelled: '#EF5350',
};

const paymentModeColor: Record<string, string> = {
  cod: '#66BB6A',
  credit: '#42A5F5',
  upi: '#7E57C2',
};

const paymentModeLabel: Record<string, string> = {
  cod: 'COD',
  credit: 'Credit',
  upi: 'UPI',
};

const statusIcon: Record<string, keyof typeof Ionicons.glyphMap> = {
  pending: 'time',
  pending_payment: 'card',
  approved: 'checkmark-circle',
  packed: 'cube',
  dispatched: 'car',
  delivered: 'checkmark-done-circle',
  cancelled: 'close-circle',
};

const nextStatusMap: Record<string, OrderStatus> = {
  pending: 'approved',
  approved: 'packed',
  packed: 'dispatched',
  dispatched: 'delivered',
};

// CHANGED: FIX C — fulfillment mode colors
const fulfillmentColor: Record<string, string> = {
  delivery: '#26A69A',
  pickup: '#7E57C2',
};

/* ================= SCREEN ================= */

export default function AdminOrderDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [timelineLoading, setTimelineLoading] = useState(true);

  useEffect(() => {
    fetchOrder();
    fetchTimeline();
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
    } catch (err: any) {
      console.error('Error fetching order:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchTimeline = async () => {
    try {
      setTimelineLoading(true);
      const { data, error } = await supabase.rpc('get_order_timeline', {
        p_order_id: id,
      });

      if (error) throw error;
      setTimeline((data || []) as TimelineEvent[]);
    } catch (err: any) {
      console.error('Error fetching timeline:', err);
    } finally {
      setTimelineLoading(false);
    }
  };

  const updateStatus = async (newStatus: OrderStatus) => {
    if (!order) return;
    const label = newStatus.charAt(0).toUpperCase() + newStatus.slice(1);

    Alert.alert('Confirm', `Mark order #${order.order_number} as "${label}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: label,
        onPress: async () => {
          const { error } = await supabase
            .from('orders')
            .update({ status: newStatus })
            .eq('id', order.id);

          if (error) {
            if (error.message?.includes('invalid_transition') || error.code === 'P0001') {
              Alert.alert('Invalid Transition', 'This status change is not allowed.');
            } else {
              Alert.alert('Error', error.message);
            }
            return;
          }

          fetchOrder();
          fetchTimeline();
        },
      },
    ]);
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
    order.payment_mode === 'cod' ? 'Cash on Delivery'
    : order.payment_mode === 'credit' ? 'Credit'
    : order.payment_mode === 'upi' ? 'UPI'
    : order.payment_mode?.toUpperCase() || 'COD';

  const isPickup = order.fulfillment_mode === 'pickup' || order.delivery_type === 'pickup';  // CHANGED: FIX C
  const next = nextStatusMap[order.status];
  const isFinal = order.status === 'delivered' || order.status === 'cancelled';

  // CHANGED: FIX C — for pickup orders, "dispatched" label becomes "Ready for Pickup"
  const getNextLabel = (status: string) => {
    if (isPickup && status === 'dispatched') return 'Ready for Pickup';
    if (isPickup && status === 'delivered') return 'Collected';
    return status.charAt(0).toUpperCase() + status.slice(1);
  };

  return (
    <SafeAreaView style={styles.container}>
      <Stack.Screen options={{ title: `#${order.order_number}` }} />

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        {/* Status card */}
        <View style={styles.section}>
          <View style={styles.statusHeader}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <View
                style={[styles.statusBadge, { backgroundColor: statusColor[order.status] || '#999' }]}
              >
                <Ionicons name={statusIcon[order.status] || 'help-circle'} size={14} color="#fff" />
                <Text style={styles.statusBadgeText}>
                  {order.status.charAt(0).toUpperCase() + order.status.slice(1)}
                </Text>
              </View>
              {/* Payment mode badge */}
              <View
                style={[styles.paymentBadge, { backgroundColor: paymentModeColor[order.payment_mode] || '#999' }]}
              >
                <Ionicons name="card-outline" size={12} color="#fff" />
                <Text style={styles.paymentBadgeText}>
                  {paymentModeLabel[order.payment_mode] || order.payment_mode?.toUpperCase() || 'COD'}
                </Text>
              </View>
              {/* CHANGED: FIX C — Fulfillment mode badge */}
              <View
                style={[styles.paymentBadge, { backgroundColor: fulfillmentColor[order.fulfillment_mode] || '#999' }]}
              >
                <Ionicons
                  name={isPickup ? 'storefront' : 'car'}
                  size={12}
                  color="#fff"
                />
                <Text style={styles.paymentBadgeText}>
                  {isPickup ? 'Pickup' : 'Delivery'}
                </Text>
              </View>
            </View>
            <Text style={styles.orderDate}>
              {format(new Date(order.created_at), 'dd MMM yyyy, hh:mm a')}
            </Text>
          </View>

          {/* Quick action buttons */}
          <View style={styles.actionRow}>
            {next && (
              <TouchableOpacity
                style={[styles.nextBtn, { backgroundColor: statusColor[next] || '#4C51C9' }]}
                onPress={() => updateStatus(next)}
              >
                <Ionicons name={statusIcon[next] || 'arrow-forward'} size={16} color="#fff" />
                <Text style={styles.nextBtnText}>
                  Mark {getNextLabel(next)}
                </Text>
              </TouchableOpacity>
            )}
            {!isFinal && (
              <TouchableOpacity
                style={styles.cancelOrderBtn}
                onPress={() => updateStatus('cancelled')}
              >
                <Ionicons name="close-circle-outline" size={16} color="#EF5350" />
                <Text style={styles.cancelOrderBtnText}>Cancel</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* Order info */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Order Details</Text>
          <InfoRow icon="receipt-outline" label="Order Number" value={`#${order.order_number}`} />
          <InfoRow icon="person-outline" label="Customer" value={order.user_name || 'Unknown'} />
          <InfoRow icon="call-outline" label="Phone" value={order.user_phone || '—'} />
          <InfoRow
            icon="time-outline"
            label="Placed On"
            value={format(new Date(order.created_at), 'dd MMM yyyy, hh:mm a')}
          />
          {/* CHANGED: FIX C — Show fulfillment mode */}
          <InfoRow
            icon={isPickup ? 'storefront-outline' : 'car-outline'}
            label="Fulfillment"
            value={isPickup ? 'Self Pickup' : 'Home Delivery'}
          />
          <InfoRow icon="card-outline" label="Payment" value={paymentLabel} />
          <InfoRow icon="cube-outline" label="Total Items" value={`${itemCount} items`} />
        </View>

        {/* Delivery address — hide for pickup */}
        {!isPickup && order.delivery_address ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Delivery Address</Text>
            <View style={styles.addressRow}>
              <Ionicons name="location-outline" size={18} color="#4C51C9" />
              <Text style={styles.addressText}>{order.delivery_address}</Text>
            </View>
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
                style={[styles.itemRow, index < order.items.length - 1 && styles.itemBorder]}
              >
                <View style={styles.itemLeft}>
                  <Text style={styles.itemName}>{name}</Text>
                  <Text style={styles.itemMeta}>₹{item.selling_price.toFixed(2)} x {item.quantity}</Text>
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
          {/* CHANGED: FIX B — Show discount if any */}
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

        {/* Cancellation Request */}
        {order.cancellation_requested && order.status !== 'cancelled' && (
          <View style={styles.cancelBanner}>
            <Ionicons name="warning" size={20} color="#E65100" />
            <View style={{ flex: 1, marginLeft: 8 }}>
              <Text style={styles.cancelBannerTitle}>Cancellation Requested</Text>
              {order.cancellation_reason ? (
                <Text style={styles.cancelReasonText}>Reason: {order.cancellation_reason}</Text>
              ) : null}
            </View>
          </View>
        )}

        {/* Timeline */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Timeline</Text>

          {timelineLoading ? (
            <ActivityIndicator size="small" color="#4C51C9" style={{ marginVertical: 12 }} />
          ) : timeline.length === 0 ? (
            <Text style={styles.timelineEmpty}>No timeline events recorded.</Text>
          ) : (
            <View style={styles.timelineContainer}>
              {timeline.map((event, index) => {
                const isLast = index === timeline.length - 1;
                const dotColor = statusColor[event.to_status] || '#999';
                const label = event.from_status
                  ? `${capitalize(event.from_status)} → ${capitalize(event.to_status)}`
                  : `Order ${capitalize(event.to_status)}`;

                return (
                  <View key={index} style={styles.timelineRow}>
                    <View style={styles.timelineDotCol}>
                      <View style={[styles.timelineDot, { backgroundColor: dotColor }]} />
                      {!isLast && <View style={styles.timelineLine} />}
                    </View>
                    <View style={styles.timelineContent}>
                      <Text style={styles.timelineLabel}>{label}</Text>
                      <Text style={styles.timelineActor}>{event.actor_name}</Text>
                      <Text style={styles.timelineTime}>
                        {format(new Date(event.created_at), 'dd MMM hh:mm a')}
                      </Text>
                    </View>
                  </View>
                );
              })}
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

/* ================= HELPERS ================= */

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function InfoRow({ icon, label, value }: {
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
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  error: { marginTop: 12, color: '#888', fontSize: 16 },

  section: { backgroundColor: '#fff', padding: 16, borderRadius: 14, marginBottom: 12 },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: '#333', marginBottom: 12 },

  statusHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  statusBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20 },
  statusBadgeText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  orderDate: { fontSize: 12, color: '#999' },

  actionRow: { flexDirection: 'row', gap: 8 },
  nextBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  nextBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  cancelOrderBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: '#FFCDD2', backgroundColor: '#FFF5F5' },
  cancelOrderBtnText: { color: '#EF5350', fontSize: 13, fontWeight: '600' },

  infoRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8 },
  infoLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  infoLabel: { fontSize: 13, color: '#888' },
  infoValue: { fontSize: 13, fontWeight: '600', color: '#333' },

  addressRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  addressText: { fontSize: 14, color: '#444', flex: 1, lineHeight: 20 },

  itemRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10 },
  itemBorder: { borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  itemLeft: { flex: 1, marginRight: 12 },
  itemName: { fontSize: 14, fontWeight: '600', color: '#333' },
  itemMeta: { fontSize: 12, color: '#888', marginTop: 2 },
  itemTotal: { fontSize: 14, fontWeight: '700', color: '#333' },

  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  summaryLabel: { fontSize: 14, color: '#666' },
  summaryValue: { fontSize: 14, color: '#333' },
  divider: { height: 1, backgroundColor: '#eee', marginVertical: 8 },
  grandTotalLabel: { fontSize: 16, fontWeight: '700', color: '#333' },
  grandTotalValue: { fontSize: 16, fontWeight: '700', color: '#4C51C9' },

  cancelBanner: { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: '#FFF3E0', borderWidth: 1, borderColor: '#FFE0B2', borderRadius: 12, padding: 14, marginBottom: 12 },
  cancelBannerTitle: { fontSize: 14, fontWeight: '700', color: '#E65100', marginBottom: 2 },
  cancelReasonText: { fontSize: 12, color: '#8D6E63', marginTop: 4, fontStyle: 'italic' },

  timelineContainer: { paddingLeft: 4 },
  timelineRow: { flexDirection: 'row', minHeight: 60 },
  timelineDotCol: { width: 24, alignItems: 'center' },
  timelineDot: { width: 12, height: 12, borderRadius: 6, marginTop: 4 },
  timelineLine: { width: 2, flex: 1, backgroundColor: '#e0e0e0', marginTop: 4 },
  timelineContent: { flex: 1, paddingLeft: 12, paddingBottom: 16 },
  timelineLabel: { fontSize: 14, fontWeight: '600', color: '#333' },
  timelineActor: { fontSize: 12, color: '#888', marginTop: 2 },
  timelineTime: { fontSize: 11, color: '#aaa', marginTop: 2 },
  timelineEmpty: { fontSize: 13, color: '#999', fontStyle: 'italic' },

  paymentBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 16 },
  paymentBadgeText: { color: '#fff', fontSize: 11, fontWeight: '600' },
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
