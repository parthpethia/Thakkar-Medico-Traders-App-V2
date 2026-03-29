import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { supabase } from '../../src/services/supabase';
import { Order, OrderStatus } from '../../src/types';
import { format } from 'date-fns';

/* ================= CONSTANTS ================= */

const statusFilters: { key: OrderStatus | 'all' | 'cancel_requests'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'cancel_requests', label: '🔴 Cancel Requests' },
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'packed', label: 'Packed' },
  { key: 'dispatched', label: 'Dispatched' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'cancelled', label: 'Cancelled' },
];

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

// The next logical status transition for each status
const nextStatus: Record<string, OrderStatus> = {
  pending: 'approved',
  approved: 'packed',
  packed: 'dispatched',
  dispatched: 'delivered',
};

/* ================= SCREEN ================= */

export default function AdminOrders() {
  const router = useRouter();
  const [orders, setOrders] = useState<Order[]>([]);
  const [filter, setFilter] = useState<OrderStatus | 'all' | 'cancel_requests'>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [cancelRequestCount, setCancelRequestCount] = useState(0);

  const fetchOrders = async () => {
    try {
      setLoading(true);

      let query = supabase
        .from('orders')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);

      if (filter === 'cancel_requests') {
        query = query.eq('cancellation_requested', true).neq('status', 'cancelled');
      } else if (filter !== 'all') {
        query = query.eq('status', filter);
      }

      const { data, error } = await query;
      if (error) throw error;
      setOrders(data || []);
    } catch (err: any) {
      Alert.alert('Error', err.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchCancelRequestCount = async () => {
    try {
      const { count, error } = await supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('cancellation_requested', true)
        .neq('status', 'cancelled');

      if (!error && count !== null) {
        setCancelRequestCount(count);
      }
    } catch {}
  };

  useEffect(() => {
    fetchOrders();
    fetchCancelRequestCount();
  }, [filter]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchOrders();
    await fetchCancelRequestCount();
    setRefreshing(false);
  }, [filter]);

  /* -------- STATUS UPDATE -------- */

  const updateStatus = async (order: Order, newStatus: OrderStatus) => {
    const label = newStatus.charAt(0).toUpperCase() + newStatus.slice(1);

    Alert.alert(
      'Confirm Status Change',
      `Mark order #${order.order_number} as "${label}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: label,
          onPress: async () => {
            const { error } = await supabase
              .from('orders')
              .update({ status: newStatus })
              .eq('id', order.id);

            if (error) {
              Alert.alert('Error', error.message);
            } else {
              fetchOrders();
            }
          },
        },
      ]
    );
  };

  const showAllStatuses = (order: Order) => {
    const allStatuses: OrderStatus[] = [
      'pending',
      'approved',
      'packed',
      'dispatched',
      'delivered',
      'cancelled',
    ];

    Alert.alert(
      'Set Status',
      `Order #${order.order_number}`,
      [
        ...allStatuses
          .filter((s) => s !== order.status)
          .map((s) => ({
            text: s.charAt(0).toUpperCase() + s.slice(1),
            onPress: () => updateStatus(order, s),
          })),
        { text: 'Cancel', style: 'cancel' },
      ]
    );
  };

  /* -------- CANCELLATION REQUEST HANDLERS -------- */

  const confirmCancellation = (order: Order) => {
    Alert.alert(
      'Confirm Cancellation',
      `Are you sure you want to cancel order #${order.order_number}?\n\nCustomer reason: ${order.cancellation_reason || 'No reason provided'}`,
      [
        { text: 'No', style: 'cancel' },
        {
          text: 'Yes, Cancel Order',
          style: 'destructive',
          onPress: async () => {
            const { error } = await supabase
              .from('orders')
              .update({
                status: 'cancelled',
                cancellation_requested: false,
              })
              .eq('id', order.id);

            if (error) {
              Alert.alert('Error', error.message);
            } else {
              fetchOrders();
              fetchCancelRequestCount();
            }
          },
        },
      ]
    );
  };

  const dismissCancelRequest = (order: Order) => {
    Alert.alert(
      'Dismiss Request',
      `Dismiss the cancellation request for order #${order.order_number}? The order will continue processing.`,
      [
        { text: 'No', style: 'cancel' },
        {
          text: 'Dismiss',
          onPress: async () => {
            const { error } = await supabase
              .from('orders')
              .update({
                cancellation_requested: false,
                cancellation_reason: null,
                cancellation_requested_at: null,
              })
              .eq('id', order.id);

            if (error) {
              Alert.alert('Error', error.message);
            } else {
              fetchOrders();
              fetchCancelRequestCount();
            }
          },
        },
      ]
    );
  };

  /* -------- RENDER ORDER -------- */

  const renderOrder = ({ item }: { item: Order }) => {
    const itemCount = Array.isArray(item.items)
      ? item.items.reduce((sum: number, i: any) => sum + (i.quantity || 0), 0)
      : 0;

    const next = nextStatus[item.status];
    const isFinal = item.status === 'delivered' || item.status === 'cancelled';

    return (
      <TouchableOpacity
        style={styles.card}
        activeOpacity={0.7}
        onPress={() => router.push(`/order/${item.id}`)}
      >
        {/* Header */}
        <View style={styles.cardHeader}>
          <View style={{ flex: 1 }}>
            <Text style={styles.orderNo}>#{item.order_number}</Text>
            <Text style={styles.orderDate}>
              {format(new Date(item.created_at), 'dd MMM yyyy, hh:mm a')}
            </Text>
          </View>
          <View
            style={[
              styles.statusBadge,
              { backgroundColor: statusColor[item.status] || '#999' },
            ]}
          >
            <Ionicons
              name={statusIcon[item.status] || 'help-circle'}
              size={13}
              color="#fff"
            />
            <Text style={styles.statusBadgeText}>
              {item.status.charAt(0).toUpperCase() + item.status.slice(1)}
            </Text>
          </View>
        </View>

        {/* Customer info */}
        <View style={styles.customerRow}>
          <Ionicons name="person-outline" size={14} color="#888" />
          <Text style={styles.customerText}>
            {item.user_name || 'Unknown'} &middot; {item.user_phone || '—'}
          </Text>
        </View>

        {/* Cancellation Request Notification */}
        {item.cancellation_requested && item.status !== 'cancelled' && (
          <View style={styles.cancelRequestNotification}>
            <View style={styles.cancelRequestHeader}>
              <Ionicons name="warning" size={16} color="#E65100" />
              <Text style={styles.cancelRequestTitle}>Cancellation Requested</Text>
            </View>
            {item.cancellation_reason ? (
              <Text style={styles.cancelRequestReason}>
                Reason: {item.cancellation_reason}
              </Text>
            ) : null}
            {item.cancellation_requested_at ? (
              <Text style={styles.cancelRequestTime}>
                Requested: {format(new Date(item.cancellation_requested_at), 'dd MMM yyyy, hh:mm a')}
              </Text>
            ) : null}
            <View style={styles.cancelRequestActions}>
              <TouchableOpacity
                style={styles.confirmCancelBtn}
                onPress={() => confirmCancellation(item)}
              >
                <Ionicons name="checkmark-circle" size={16} color="#fff" />
                <Text style={styles.confirmCancelBtnText}>Confirm Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.dismissCancelBtn}
                onPress={() => dismissCancelRequest(item)}
              >
                <Ionicons name="close-outline" size={16} color="#666" />
                <Text style={styles.dismissCancelBtnText}>Dismiss</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Info row */}
        <View style={styles.infoRow}>
          <View style={styles.infoItem}>
            <Ionicons name="cube-outline" size={14} color="#888" />
            <Text style={styles.infoText}>{itemCount} items</Text>
          </View>
          <View style={styles.infoItem}>
            <Ionicons
              name={
                item.delivery_type === 'pickup'
                  ? 'storefront-outline'
                  : 'car-outline'
              }
              size={14}
              color="#888"
            />
            <Text style={styles.infoText}>
              {item.delivery_type === 'pickup' ? 'Pickup' : 'Delivery'}
            </Text>
          </View>
          <View style={styles.infoItem}>
            <Ionicons name="card-outline" size={14} color="#888" />
            <Text style={styles.infoText}>
              {item.payment_mode === 'cod'
                ? 'COD'
                : item.payment_mode === 'credit'
                ? 'Credit'
                : item.payment_mode === 'upi'
                ? 'UPI'
                : item.payment_mode?.toUpperCase() || 'COD'}
            </Text>
          </View>
        </View>

        {/* Total */}
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Grand Total</Text>
          <Text style={styles.totalAmount}>
            ₹{(item.grand_total || 0).toFixed(2)}
          </Text>
        </View>

        {/* Action buttons */}
        <View style={styles.actionRow}>
          {/* Next step button */}
          {next && (
            <TouchableOpacity
              style={[
                styles.nextBtn,
                { backgroundColor: statusColor[next] || '#4C51C9' },
              ]}
              onPress={() => updateStatus(item, next)}
            >
              <Ionicons
                name={statusIcon[next] || 'arrow-forward'}
                size={16}
                color="#fff"
              />
              <Text style={styles.nextBtnText}>
                Mark {next.charAt(0).toUpperCase() + next.slice(1)}
              </Text>
            </TouchableOpacity>
          )}

          {/* Cancel button (only if not final) */}
          {!isFinal && (
            <TouchableOpacity
              style={styles.cancelBtn}
              onPress={() => updateStatus(item, 'cancelled')}
            >
              <Ionicons name="close-circle-outline" size={16} color="#EF5350" />
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
          )}

          {/* More options */}
          <TouchableOpacity
            style={styles.moreBtn}
            onPress={() => showAllStatuses(item)}
          >
            <Ionicons name="ellipsis-horizontal" size={18} color="#888" />
          </TouchableOpacity>

          {/* Delivered badge */}
          {item.status === 'delivered' && (
            <View style={styles.completedBadge}>
              <Ionicons name="checkmark-done-circle" size={16} color="#66BB6A" />
              <Text style={styles.completedText}>Completed</Text>
            </View>
          )}

          {/* Cancelled badge */}
          {item.status === 'cancelled' && (
            <View style={styles.cancelledBadge}>
              <Ionicons name="close-circle" size={16} color="#EF5350" />
              <Text style={styles.cancelledText}>Cancelled</Text>
            </View>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* Filters */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filtersContainer}
      >
        {statusFilters.map((f) => (
          <TouchableOpacity
            key={f.key}
            onPress={() => setFilter(f.key)}
            style={[
              styles.filterBtn,
              filter === f.key && styles.filterActive,
              f.key === 'cancel_requests' && cancelRequestCount > 0 && styles.filterCancelRequests,
            ]}
          >
            <Text
              style={[
                styles.filterText,
                filter === f.key && styles.filterTextActive,
                f.key === 'cancel_requests' && cancelRequestCount > 0 && filter !== f.key && styles.filterCancelRequestsText,
              ]}
            >
              {f.label}
              {f.key === 'cancel_requests' && cancelRequestCount > 0
                ? ` (${cancelRequestCount})`
                : ''}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Orders list */}
      {loading && !refreshing ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#4C51C9" />
        </View>
      ) : (
        <FlatList
          data={orders}
          keyExtractor={(i) => i.id}
          renderItem={renderOrder}
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          initialNumToRender={8}
          maxToRenderPerBatch={8}
          windowSize={5}
          removeClippedSubviews
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Ionicons name="receipt-outline" size={64} color="#ccc" />
              <Text style={styles.emptyTitle}>No orders found</Text>
              <Text style={styles.emptySubtitle}>
                {filter === 'all'
                  ? 'No orders have been placed yet'
                  : `No ${filter} orders`}
              </Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

/* ================= STYLES ================= */

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  /* Filters */
  filtersContainer: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 8,
  },
  filterBtn: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  filterActive: {
    backgroundColor: '#4C51C9',
    borderColor: '#4C51C9',
  },
  filterText: { fontSize: 13, color: '#666' },
  filterTextActive: { color: '#fff', fontWeight: '600' },

  /* Card */
  card: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 16,
    marginBottom: 14,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 10,
  },
  orderNo: { fontSize: 15, fontWeight: '700', color: '#333' },
  orderDate: { fontSize: 12, color: '#999', marginTop: 2 },

  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
  },
  statusBadgeText: { color: '#fff', fontSize: 12, fontWeight: '600' },

  /* Customer */
  customerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 10,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  customerText: { fontSize: 13, color: '#555' },

  /* Info row */
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  infoItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  infoText: { fontSize: 12, color: '#888' },

  /* Total */
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
    marginBottom: 12,
  },
  totalLabel: { fontSize: 14, color: '#666' },
  totalAmount: { fontSize: 18, fontWeight: '700', color: '#4C51C9' },

  /* Actions */
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  nextBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  nextBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  cancelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#FFCDD2',
    backgroundColor: '#FFF5F5',
  },
  cancelBtnText: {
    color: '#EF5350',
    fontSize: 13,
    fontWeight: '600',
  },
  moreBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#f5f5f5',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 'auto',
  },
  completedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#E8F5E9',
    borderRadius: 8,
  },
  completedText: {
    color: '#43A047',
    fontSize: 13,
    fontWeight: '600',
  },
  cancelledBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#FFEBEE',
    borderRadius: 8,
  },
  cancelledText: {
    color: '#C62828',
    fontSize: 13,
    fontWeight: '600',
  },

  /* Empty */
  emptyContainer: {
    alignItems: 'center',
    marginTop: 60,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#666',
    marginTop: 16,
  },
  emptySubtitle: {
    fontSize: 14,
    color: '#999',
    marginTop: 4,
  },

  /* Cancel request filter */
  filterCancelRequests: {
    borderColor: '#FF6D00',
    backgroundColor: '#FFF3E0',
  },
  filterCancelRequestsText: {
    color: '#E65100',
    fontWeight: '600',
  },

  /* Cancel request notification in card */
  cancelRequestNotification: {
    backgroundColor: '#FFF3E0',
    borderWidth: 1,
    borderColor: '#FFE0B2',
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
  },
  cancelRequestHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  cancelRequestTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#E65100',
  },
  cancelRequestReason: {
    fontSize: 12,
    color: '#8D6E63',
    marginBottom: 4,
    fontStyle: 'italic',
  },
  cancelRequestTime: {
    fontSize: 11,
    color: '#A1887F',
    marginBottom: 8,
  },
  cancelRequestActions: {
    flexDirection: 'row',
    gap: 8,
  },
  confirmCancelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#EF5350',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  confirmCancelBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  dismissCancelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#f5f5f5',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  dismissCancelBtnText: {
    color: '#666',
    fontSize: 12,
    fontWeight: '600',
  },
});
