// PA: H5 — pending_payment status color aligned with admin list
import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
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
import { useAppTheme } from '../../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../../src/theme/useThemedStyles';
import type { AppColors } from '../../../src/theme/colors';
import { AssignDeliveryModal } from '../../../src/components/delivery/AssignDeliveryModal';
import { RemoveItemsModal } from '../../../src/components/admin/RemoveItemsModal';
import { ResolveReturnModal, ReturnItem } from '../../../src/components/admin/ResolveReturnModal';

/* ================= TYPES ================= */

type RawOrderItem = {
  product_id?: string;
  product_name?: string;
  name?: string;
  quantity?: number;
  qty?: number;
  selling_price?: number;
  unit_price?: number;
  price?: number;
  line_total?: number;
  gst_percent?: number;
};

type OrderItem = {
  product_name?: string;
  name?: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  gst_percent?: number;
};

function normalizeOrderItems(
  rawItems: unknown,
  productById: Map<string, { name: string; selling_price: number }>,
): OrderItem[] {
  if (!Array.isArray(rawItems)) return [];

  return rawItems.map((raw) => {
    const item = raw as RawOrderItem;
    const product = item.product_id ? productById.get(item.product_id) : undefined;
    const quantity = Number(item.qty ?? item.quantity ?? 0);
    const unitPrice = Number(
      item.unit_price ?? item.selling_price ?? item.price ?? product?.selling_price ?? 0,
    );
    const name = item.product_name ?? item.name ?? product?.name ?? 'Unknown';
    const lineTotal = Number(item.line_total ?? unitPrice * quantity);

    return {
      product_name: name,
      name,
      quantity,
      unitPrice,
      lineTotal,
      gst_percent: item.gst_percent,
    };
  });
}

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
  delivery_failure_reason?: string;
  items_adjusted?: boolean;
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
  payment_failed: '#E53935',
  assigned: '#5C6BC0',
  accepted: '#00897B',
  approved: '#42A5F5',
  packed: '#7E57C2',
  picked_up: '#00ACC1',
  dispatched: '#26A69A',
  delivered: '#66BB6A',
  cancelled: '#EF5350',
  rejected: '#D32F2F',
  delivery_failed: '#E53935',
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
  payment_failed: 'alert-circle',
  assigned: 'person',
  accepted: 'checkbox-outline',
  approved: 'checkmark-circle',
  packed: 'cube',
  picked_up: 'car',
  dispatched: 'car',
  delivered: 'checkmark-done-circle',
  cancelled: 'close-circle',
  rejected: 'close-circle',
  delivery_failed: 'alert-circle',
};

const nextStatusMap: Record<string, OrderStatus> = {
  pending: 'approved',
  approved: 'packed',
  packed: 'dispatched',
  picked_up: 'dispatched',
  dispatched: 'delivered',
};

// CHANGED: FIX C — fulfillment mode colors
const fulfillmentColor: Record<string, string> = {
  delivery: '#26A69A',
  pickup: '#7E57C2',
};

/* ================= SCREEN ================= */

export default function AdminOrderDetail() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [timelineLoading, setTimelineLoading] = useState(true);
  const [assignOpen, setAssignOpen] = useState(false);
  const [assigneeName, setAssigneeName] = useState<string | null>(null);
  const [removeItemsOpen, setRemoveItemsOpen] = useState(false);
  const [returns, setReturns] = useState<(ReturnItem & { product_name?: string })[]>([]);
  const [resolveReturn, setResolveReturn] = useState<ReturnItem | null>(null);

  useEffect(() => {
    fetchOrder();
    fetchTimeline();
    fetchReturns();
  }, [id]);

  const fetchOrder = async () => {
    try {
      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .eq('id', id)
        .single();

      if (error) throw error;
      if (!data) {
        setOrder(null);
        return;
      }

      const rawItems = Array.isArray(data.items) ? (data.items as RawOrderItem[]) : [];
      const productIds = [
        ...new Set(rawItems.map((i) => i.product_id).filter((pid): pid is string => !!pid)),
      ];

      const productById = new Map<string, { name: string; selling_price: number }>();
      if (productIds.length > 0) {
        const { data: products, error: productsError } = await supabase
          .from('products')
          .select('id, name, selling_price')
          .in('id', productIds);

        if (productsError) throw productsError;
        for (const p of products ?? []) {
          productById.set(p.id, {
            name: p.name,
            selling_price: Number(p.selling_price ?? 0),
          });
        }
      }

      setOrder({
        ...(data as OrderDetail),
        items: normalizeOrderItems(rawItems, productById),
      });

      const assignedId = (data as { assigned_to?: string | null }).assigned_to;
      if (assignedId) {
        const { data: driver } = await supabase
          .from('profiles')
          .select('name, business_name')
          .eq('id', assignedId)
          .maybeSingle();
        setAssigneeName(driver?.name || driver?.business_name || 'Driver');
      } else {
        setAssigneeName(null);
      }
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

  const fetchReturns = async () => {
    try {
      const { data, error } = await supabase
        .from('returns')
        .select('*')
        .eq('order_id', id)
        .order('created_at', { ascending: false });

      if (error) throw error;
      if (!data || data.length === 0) {
        setReturns([]);
        return;
      }

      // Fetch product names
      const productIds = [...new Set(data.map((r: any) => r.product_id))];
      const { data: products } = await supabase
        .from('products')
        .select('id, name')
        .in('id', productIds);

      const nameMap = new Map(
        (products ?? []).map((p: any) => [p.id, p.name]),
      );

      setReturns(
        data.map((r: any) => ({
          ...r,
          product_name: nameMap.get(r.product_id) ?? 'Unknown Product',
        })),
      );
    } catch (err: any) {
      console.error('Error fetching returns:', err);
    }
  };

  const updateStatus = async (newStatus: OrderStatus) => {
    if (!order) return;
    const label = formatStatus(newStatus);

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
      <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
        <Stack.Screen options={{ title: 'Loading...' }} />
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  if (!order) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
        <Stack.Screen options={{ title: 'Not Found' }} />
        <View style={styles.center}>
          <Ionicons name="alert-circle" size={64} color={colors.textMuted} />
          <Text style={styles.error}>Order not found</Text>
        </View>
      </SafeAreaView>
    );
  }

  const itemCount = Array.isArray(order.items)
    ? order.items.reduce((sum, i) => sum + (i.quantity ?? 0), 0)
    : 0;

  const paymentLabel =
    order.payment_mode === 'cod' ? 'Cash on Delivery'
    : order.payment_mode === 'credit' ? 'Credit'
    : order.payment_mode === 'upi' ? 'UPI'
    : order.payment_mode?.toUpperCase() || 'COD';

  const isPickup = order.fulfillment_mode === 'pickup' || order.delivery_type === 'pickup';  // CHANGED: FIX C
  const next = nextStatusMap[order.status];
  const isFinal = order.status === 'delivered' || order.status === 'cancelled';
  const isFailed = order.status === 'delivery_failed';

  // CHANGED: FIX C — for pickup orders, "dispatched" label becomes "Ready for Pickup"
  const getNextLabel = (status: string) => {
    if (isPickup && status === 'dispatched') return 'Ready for Pickup';
    if (isPickup && status === 'delivered') return 'Collected';
    return status.charAt(0).toUpperCase() + status.slice(1);
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <Stack.Screen options={{ title: `#${order.order_number}` }} />

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        {/* Status card */}
        <View style={styles.section}>
          <View style={styles.statusHeader}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <View
                style={[styles.statusBadge, { backgroundColor: statusColor[order.status] || colors.textMuted }]}
              >
                <Ionicons name={statusIcon[order.status] || 'help-circle'} size={14} color={colors.onPrimary} />
                <Text style={styles.statusBadgeText}>
                  {formatStatus(order.status)}
                </Text>
              </View>
              {/* Payment mode badge */}
              <View
                style={[styles.paymentBadge, { backgroundColor: paymentModeColor[order.payment_mode] || colors.textMuted }]}
              >
                <Ionicons name="card-outline" size={12} color={colors.onPrimary} />
                <Text style={styles.paymentBadgeText}>
                  {paymentModeLabel[order.payment_mode] || order.payment_mode?.toUpperCase() || 'COD'}
                </Text>
              </View>
              {/* CHANGED: FIX C — Fulfillment mode badge */}
              <View
                style={[styles.paymentBadge, { backgroundColor: fulfillmentColor[order.fulfillment_mode] || colors.textMuted }]}
              >
                <Ionicons
                  name={isPickup ? 'storefront' : 'car'}
                  size={12}
                  color={colors.onPrimary}
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

          {!isPickup &&
            ['pending', 'approved', 'packed'].includes(order.status) && (
              <TouchableOpacity
                style={[styles.nextBtn, { backgroundColor: '#5C6BC0', marginTop: 8 }]}
                onPress={() => setAssignOpen(true)}
              >
                <Ionicons name="person-add-outline" size={16} color={colors.onPrimary} />
                <Text style={styles.nextBtnText}>Assign driver</Text>
              </TouchableOpacity>
            )}

          {assigneeName ? (
            <Text style={{ marginTop: 8, fontSize: 13, color: colors.textSecondary }}>
              Assigned to: {assigneeName}
            </Text>
          ) : null}

          {/* Quick action buttons */}
          <View style={styles.actionRow}>
            {next && (
              <TouchableOpacity
                style={[styles.nextBtn, { backgroundColor: statusColor[next] || colors.primary }]}
                onPress={() => updateStatus(next)}
              >
                <Ionicons name={statusIcon[next] || 'arrow-forward'} size={16} color={colors.onPrimary} />
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
                <Ionicons name="close-circle-outline" size={16} color={colors.error} />
                <Text style={styles.cancelOrderBtnText}>Cancel</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Mark items unavailable (before dispatch) */}
          {['pending', 'approved', 'packed', 'assigned', 'accepted'].includes(order.status) && (
            <TouchableOpacity
              style={[styles.nextBtn, { backgroundColor: colors.warning, marginTop: 8 }]}
              onPress={() => setRemoveItemsOpen(true)}
            >
              <Ionicons name="remove-circle-outline" size={16} color="#fff" />
              <Text style={[styles.nextBtnText, { color: '#fff' }]}>Mark Items Unavailable</Text>
            </TouchableOpacity>
          )}

          {/* Delivery failed actions */}
          {isFailed && (
            <View style={styles.failedBanner}>
              <Ionicons name="alert-circle" size={20} color={colors.error} />
              <View style={{ flex: 1, marginLeft: 8 }}>
                <Text style={styles.failedBannerTitle}>Delivery Failed</Text>
                {(order as any).delivery_failure_reason ? (
                  <Text style={styles.failedReasonText}>
                    Reason: {(order as any).delivery_failure_reason.replace(/_/g, ' ')}
                  </Text>
                ) : null}
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                  <TouchableOpacity
                    style={[styles.nextBtn, { backgroundColor: '#5C6BC0' }]}
                    onPress={() => setAssignOpen(true)}
                  >
                    <Ionicons name="refresh-outline" size={16} color={colors.onPrimary} />
                    <Text style={styles.nextBtnText}>Reschedule</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.cancelOrderBtn}
                    onPress={() => updateStatus('cancelled')}
                  >
                    <Ionicons name="close-circle-outline" size={16} color={colors.error} />
                    <Text style={styles.cancelOrderBtnText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          )}
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
          {order.notes ? (
            <InfoRow icon="create-outline" label="Notes" value={order.notes} />
          ) : null}
        </View>

        {/* Delivery address — hide for pickup */}
        {!isPickup && order.delivery_address ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Delivery Address</Text>
            <View style={styles.addressRow}>
              <Ionicons name="location-outline" size={18} color={colors.primary} />
              <Text style={styles.addressText}>{order.delivery_address}</Text>
            </View>
          </View>
        ) : null}

        {/* Items */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Items ({itemCount})</Text>
          {order.items.map((item, index) => {
            const name = item.product_name || item.name || 'Unknown';

            return (
              <View
                key={index}
                style={[styles.itemRow, index < order.items.length - 1 && styles.itemBorder]}
              >
                <View style={styles.itemLeft}>
                  <Text style={styles.itemName}>{name}</Text>
                  <Text style={styles.itemMeta}>
                    ₹{item.unitPrice.toFixed(2)} x {item.quantity}
                  </Text>
                </View>
                <Text style={styles.itemTotal}>₹{item.lineTotal.toFixed(2)}</Text>
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

        {/* Cancellation Request */}
        {order.cancellation_requested && order.status !== 'cancelled' && (
          <View style={styles.cancelBanner}>
            <Ionicons name="warning" size={20} color={colors.error} />
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
            <ActivityIndicator size="small" color={colors.primary} style={{ marginVertical: 12 }} />
          ) : timeline.length === 0 ? (
            <Text style={styles.timelineEmpty}>No timeline events recorded.</Text>
          ) : (
            <View style={styles.timelineContainer}>
              {timeline.map((event, index) => {
                const isLast = index === timeline.length - 1;
                const dotColor = statusColor[event.to_status] || colors.textMuted;
                const label = event.from_status
                  ? `${formatStatus(event.from_status)} → ${formatStatus(event.to_status)}`
                  : `Order ${formatStatus(event.to_status)}`;

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

        {/* Returns / Claims */}
        {returns.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Returns / Claims ({returns.length})</Text>
            {returns.map((ret, idx) => {
              const reasonLabel: Record<string, string> = {
                damaged: 'Damaged',
                wrong_item: 'Wrong item',
                rejected: 'Rejected',
                expired: 'Expired',
                other: 'Other',
              };
              const resLabel: Record<string, string> = {
                refund: 'Refund',
                replace: 'Replace',
                credit_note: 'Credit note',
                pending: 'Pending',
              };

              return (
                <View
                  key={ret.id}
                  style={[
                    styles.itemRow,
                    idx < returns.length - 1 && styles.itemBorder,
                  ]}
                >
                  <View style={styles.itemLeft}>
                    <Text style={styles.itemName}>{ret.product_name}</Text>
                    <Text style={styles.itemMeta}>
                      Qty: {ret.quantity} · {reasonLabel[ret.reason] ?? ret.reason}
                    </Text>
                    {ret.reason_detail ? (
                      <Text style={[styles.itemMeta, { fontStyle: 'italic' }]}>
                        {ret.reason_detail}
                      </Text>
                    ) : null}
                  </View>
                  {ret.status === 'pending' ? (
                    <TouchableOpacity
                      style={[styles.nextBtn, { backgroundColor: colors.success }]}
                      onPress={() => setResolveReturn(ret)}
                    >
                      <Text style={styles.nextBtnText}>Resolve</Text>
                    </TouchableOpacity>
                  ) : (
                    <View style={[styles.nextBtn, { backgroundColor: colors.textMuted }]}>
                      <Text style={styles.nextBtnText}>
                        {resLabel[ret.resolution ?? ''] ?? ret.resolution}
                      </Text>
                    </View>
                  )}
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>

      <AssignDeliveryModal
        visible={assignOpen}
        orderId={order.id}
        orderNumber={order.order_number}
        onClose={() => setAssignOpen(false)}
        onAssigned={() => {
          setAssignOpen(false);
          fetchOrder();
          fetchTimeline();
        }}
      />
      <RemoveItemsModal
        visible={removeItemsOpen}
        order={order as any}
        onClose={() => setRemoveItemsOpen(false)}
        onSuccess={() => {
          setRemoveItemsOpen(false);
          fetchOrder();
        }}
        showToast={(msg) => {
          Alert.alert('Done', msg);
        }}
      />
      <ResolveReturnModal
        visible={!!resolveReturn}
        returnItem={resolveReturn}
        onClose={() => setResolveReturn(null)}
        onSuccess={() => {
          setResolveReturn(null);
          fetchReturns();
        }}
        showToast={(msg) => {
          Alert.alert('Done', msg);
        }}
      />
    </SafeAreaView>
  );
}

/* ================= HELPERS ================= */

function formatStatus(status: string): string {
  if (!status) return '';
  return status
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function InfoRow({ icon, label, value }: {
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

function createStyles(c: AppColors, _isDark: boolean) {
  return {
    container: { flex: 1, backgroundColor: c.background },
    center: { flex: 1, justifyContent: 'center' as const, alignItems: 'center' as const },
    error: { marginTop: 12, color: c.textMuted, fontSize: 16 },

    section: { backgroundColor: c.surface, padding: 16, borderRadius: 14, marginBottom: 12 },
    sectionTitle: { fontSize: 16, fontWeight: '700' as const, color: c.text, marginBottom: 12 },

    statusHeader: {
      flexDirection: 'row' as const,
      justifyContent: 'space-between' as const,
      alignItems: 'center' as const,
      flexWrap: 'wrap' as const,
      gap: 10,
      marginBottom: 12,
    },
    statusBadge: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 5, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20 },
    statusBadgeText: { color: c.onPrimary, fontSize: 13, fontWeight: '600' as const },
    orderDate: { fontSize: 12, color: c.textMuted },

    actionRow: { flexDirection: 'row' as const, gap: 8 },
    nextBtn: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
    nextBtnText: { color: c.onPrimary, fontSize: 13, fontWeight: '600' as const },
    cancelOrderBtn: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 4,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.warningBg,
    },
    cancelOrderBtnText: { color: c.error, fontSize: 13, fontWeight: '600' as const },

    infoRow: { flexDirection: 'row' as const, justifyContent: 'space-between' as const, alignItems: 'center' as const, paddingVertical: 8 },
    infoLeft: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8 },
    infoLabel: { fontSize: 13, color: c.textMuted },
    infoValue: { fontSize: 13, fontWeight: '600' as const, color: c.text },

    addressRow: { flexDirection: 'row' as const, alignItems: 'flex-start' as const, gap: 8 },
    addressText: { fontSize: 14, color: c.textSecondary, flex: 1, lineHeight: 20 },

    itemRow: { flexDirection: 'row' as const, justifyContent: 'space-between' as const, alignItems: 'center' as const, paddingVertical: 10 },
    itemBorder: { borderBottomWidth: 1, borderBottomColor: c.borderLight },
    itemLeft: { flex: 1, marginRight: 12 },
    itemName: { fontSize: 14, fontWeight: '600' as const, color: c.text },
    itemMeta: { fontSize: 12, color: c.textMuted, marginTop: 2 },
    itemTotal: { fontSize: 14, fontWeight: '700' as const, color: c.text },

    summaryRow: { flexDirection: 'row' as const, justifyContent: 'space-between' as const, paddingVertical: 6 },
    summaryLabel: { fontSize: 14, color: c.textSecondary },
    summaryValue: { fontSize: 14, color: c.text },
    divider: { height: 1, backgroundColor: c.border, marginVertical: 8 },
    grandTotalLabel: { fontSize: 16, fontWeight: '700' as const, color: c.text },
    grandTotalValue: { fontSize: 16, fontWeight: '700' as const, color: c.primary },

    cancelBanner: {
      flexDirection: 'row' as const,
      alignItems: 'flex-start' as const,
      backgroundColor: _isDark ? '#2a181a' : '#FFF5F5',
      borderWidth: 1,
      borderColor: _isDark ? '#5c232a' : '#FFCDD2',
      borderRadius: 12,
      padding: 14,
      marginBottom: 12,
    },
    cancelBannerTitle: { fontSize: 14, fontWeight: '700' as const, color: c.error, marginBottom: 2 },
    cancelReasonText: { fontSize: 12, color: c.textSecondary, marginTop: 4, fontStyle: 'italic' as const },

    timelineContainer: { paddingLeft: 4 },
    timelineRow: { flexDirection: 'row' as const, minHeight: 60 },
    timelineDotCol: { width: 24, alignItems: 'center' as const },
    timelineDot: { width: 12, height: 12, borderRadius: 6, marginTop: 4 },
    timelineLine: { width: 2, flex: 1, backgroundColor: c.border, marginTop: 4 },
    timelineContent: { flex: 1, paddingLeft: 12, paddingBottom: 16 },
    timelineLabel: { fontSize: 14, fontWeight: '600' as const, color: c.text },
    timelineActor: { fontSize: 12, color: c.textMuted, marginTop: 2 },
    timelineTime: { fontSize: 11, color: c.textMuted, marginTop: 2 },
    timelineEmpty: { fontSize: 13, color: c.textMuted, fontStyle: 'italic' as const },

    paymentBadge: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 16 },
    paymentBadgeText: { color: c.onPrimary, fontSize: 11, fontWeight: '600' as const },
    invoiceBtn: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      gap: 8,
      backgroundColor: c.primaryMuted,
      borderWidth: 1,
      borderColor: c.cardBorder,
      borderRadius: 12,
      paddingVertical: 14,
      marginBottom: 12,
    },
    invoiceBtnText: { color: c.primary, fontSize: 15, fontWeight: '600' as const },

    /* Phase 1 — delivery ops */
    failedBanner: {
      flexDirection: 'row' as const,
      alignItems: 'flex-start' as const,
      backgroundColor: _isDark ? c.surfaceSecondary : '#FFF5F5',
      borderWidth: 1,
      borderColor: c.error,
      borderRadius: 12,
      padding: 14,
      marginBottom: 12,
    },
    failedBannerTitle: { fontSize: 14, fontWeight: '700' as const, color: c.error, marginBottom: 2 },
    failedReasonText: { fontSize: 12, color: c.textSecondary, marginTop: 2, fontStyle: 'italic' as const },
  } as const;
}
