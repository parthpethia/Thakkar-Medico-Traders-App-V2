// PA: H5 — Surface pending_payment orders in admin filters and status maps
import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  ScrollView,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  RefreshControl,
  Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { supabase } from '../../src/services/supabase';
import { Order, OrderStatus } from '../../src/types';
import { useRealtimeOrders } from '../../src/hooks/useRealtimeOrders';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import { tabScreenBase } from '../../src/theme/tabScreenStyles';
import type { AppColors } from '../../src/theme/colors';
import { format, startOfDay, endOfDay, startOfWeek, endOfWeek, startOfMonth, endOfMonth } from 'date-fns';
import { AssignDeliveryModal } from '../../src/components/delivery/AssignDeliveryModal';

/* ================= CONSTANTS ================= */

const PAGE_SIZE = 20;

const statusFilters: { key: OrderStatus | 'all' | 'cancel_requests'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'cancel_requests', label: '🔴 Cancel Requests' },
  { key: 'pending_payment', label: '💳 Pending Payment' },
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'packed', label: 'Packed' },
  { key: 'dispatched', label: 'Dispatched' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'cancelled', label: 'Cancelled' },
];

type DateRangeKey = 'all_time' | 'today' | 'this_week' | 'this_month';

const dateRangeOptions: { key: DateRangeKey; label: string }[] = [
  { key: 'all_time', label: 'All Time' },
  { key: 'today', label: 'Today' },
  { key: 'this_week', label: 'This Week' },
  { key: 'this_month', label: 'This Month' },
];

const statusColor: Record<string, string> = {
  pending: '#FFA726',
  pending_payment: '#9B59B6',
  approved: '#42A5F5',
  packed: '#7E57C2',
  dispatched: '#26A69A',
  delivered: '#66BB6A',
  cancelled: '#EF5350',
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

const nextStatus: Record<string, OrderStatus> = {
  pending: 'approved',
  approved: 'packed',
  packed: 'dispatched',
  dispatched: 'delivered',
};

type PageCursor = { created_at: string; id: string } | null;

/* ================= HELPERS ================= */

function getDateRange(key: DateRangeKey): { from: string | null; to: string | null } {
  const now = new Date();
  switch (key) {
    case 'today':
      return { from: startOfDay(now).toISOString(), to: endOfDay(now).toISOString() };
    case 'this_week':
      return { from: startOfWeek(now, { weekStartsOn: 1 }).toISOString(), to: endOfWeek(now, { weekStartsOn: 1 }).toISOString() };
    case 'this_month':
      return { from: startOfMonth(now).toISOString(), to: endOfMonth(now).toISOString() };
    default:
      return { from: null, to: null };
  }
}

/* ================= SCREEN ================= */

export default function AdminOrders() {
  const styles = useThemedStyles(createOrderStyles);
  const { colors } = useAppTheme();
  const router = useRouter();
  const [orders, setOrders] = useState<Order[]>([]);
  const [filter, setFilter] = useState<OrderStatus | 'all' | 'cancel_requests'>('all');
  const [dateRange, setDateRange] = useState<DateRangeKey>('all_time');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const nextCursor = useRef<PageCursor>(null);
  const [cancelRequestCount, setCancelRequestCount] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);

  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // FIX A — toast state for new order notifications
  const [toast, setToast] = useState<string | null>(null);
  const toastOpacity = useRef(new Animated.Value(0)).current;
  const [assignTarget, setAssignTarget] = useState<Order | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    Animated.sequence([
      Animated.timing(toastOpacity, { toValue: 1, duration: 300, useNativeDriver: true }),
      Animated.delay(2500),
      Animated.timing(toastOpacity, { toValue: 0, duration: 300, useNativeDriver: true }),
    ]).start(() => setToast(null));
  }, [toastOpacity]);

  // FIX A — Realtime: subscribe to new pending orders
  useRealtimeOrders({
    table: 'orders',
    event: 'INSERT',
    filter: 'status=eq.pending',
    onInsert: (payload) => {
      setPendingCount((c) => c + 1);
      const name = payload.new?.user_name || 'a retailer';
      showToast(`New order from ${name}`);
    },
  });

  // Fetch pending count on mount and filter change
  const fetchPendingCount = useCallback(async () => {
    try {
      const { count, error } = await supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'pending');

      if (!error && count !== null) {
        setPendingCount(count);
      }
    } catch {}
  }, []);

  // Replaces the old .from('orders').select('*').limit(100)
  // with server-side keyset pagination + status/date filters via get_orders_page RPC
  const fetchOrders = useCallback(async (cursor: PageCursor = null, append = false) => {
    try {
      if (!append) setLoading(true);
      else setIsLoadingMore(true);

      const { from: p_from_date, to: p_to_date } = getDateRange(dateRange);

      if (filter === 'cancel_requests') {
        // Cancel requests can't use the single-status RPC filter,
        // so we query Supabase directly with keyset pagination
        let query = supabase
          .from('orders')
          .select('*')
          .eq('cancellation_requested', true)
          .neq('status', 'cancelled')
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(PAGE_SIZE);

        if (cursor) {
          query = query.or(`created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`);
        }
        if (p_from_date) query = query.gte('created_at', p_from_date);
        if (p_to_date) query = query.lte('created_at', p_to_date);

        const { data, error } = await query;
        if (error) throw error;

        const rows = (data || []) as Order[];
        if (append) {
          setOrders((prev) => [...prev, ...rows]);
        } else {
          setOrders(rows);
        }

        if (rows.length < PAGE_SIZE) {
          setHasMore(false);
          nextCursor.current = null;
        } else {
          const last = rows[rows.length - 1];
          nextCursor.current = { created_at: last.created_at, id: last.id };
          setHasMore(true);
        }
      } else {
        const { data, error } = await supabase.rpc('get_orders_page', {
          p_role: 'admin',
          p_user_id: null as unknown as string,
          p_status: filter === 'all' ? null : filter,
          p_cursor: cursor?.created_at ?? null,
          p_cursor_id: cursor?.id ?? null,
          p_page_size: PAGE_SIZE,
          p_from_date,
          p_to_date,
        });

        if (error) throw error;

        const rows = (data || []) as Order[];
        if (append) {
          setOrders((prev) => [...prev, ...rows]);
        } else {
          setOrders(rows);
        }

        if (rows.length < PAGE_SIZE) {
          setHasMore(false);
          nextCursor.current = null;
        } else {
          const last = rows[rows.length - 1];
          nextCursor.current = { created_at: last.created_at, id: last.id };
          setHasMore(true);
        }
      }
    } catch (err: any) {
      Alert.alert('Error', err.message);
    } finally {
      setLoading(false);
      setIsLoadingMore(false);
    }
  }, [filter, dateRange]);

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
    nextCursor.current = null;
    setHasMore(true);
    fetchOrders(null, false);
    fetchCancelRequestCount();
    fetchPendingCount();
  }, [filter, dateRange]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    nextCursor.current = null;
    setHasMore(true);
    await fetchOrders(null, false);
    await fetchCancelRequestCount();
    await fetchPendingCount();
    setRefreshing(false);
  }, [fetchOrders, fetchPendingCount]);

  const onEndReached = useCallback(() => {
    if (!hasMore || isLoadingMore || loading) return;
    fetchOrders(nextCursor.current, true);
  }, [hasMore, isLoadingMore, loading, fetchOrders]);

  const toggleSelection = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelectedIds(new Set(orders.map((o) => o.id)));
  const deselectAll = () => setSelectedIds(new Set());
  const exitSelectionMode = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  };

  const selectedOrders = orders.filter((o) => selectedIds.has(o.id));
  const allSelectedPending =
    selectedOrders.length > 0 && selectedOrders.every((o) => o.status === 'pending');
  const allSelectedApproved =
    selectedOrders.length > 0 && selectedOrders.every((o) => o.status === 'approved');
  const canBatchCancel =
    selectedOrders.length > 0 &&
    selectedOrders.every((o) => o.status === 'pending' || o.status === 'approved');

  const handleBatchAction = async (newStatus: OrderStatus) => {
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    const label = newStatus.charAt(0).toUpperCase() + newStatus.slice(1);

    Alert.alert(`Batch ${label}`, `${label} ${ids.length} order(s)?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: label,
        onPress: async () => {
          try {
            const { data, error } = await supabase.rpc('batch_update_order_status', {
              p_order_ids: ids,
              p_new_status: newStatus,
            });
            if (error) throw error;

            const result = data as {
              updated: string[];
              failed: { id: string; reason: string }[];
            };
            const updatedCount = result.updated?.length || 0;
            const failedCount = result.failed?.length || 0;
            let msg = `${updatedCount} ${label.toLowerCase()}`;
            if (failedCount > 0) {
              const reasons = result.failed.map((f) => f.reason).join(', ');
              msg += `, ${failedCount} failed: ${reasons}`;
            }
            Alert.alert('Batch Result', msg);
            exitSelectionMode();
            nextCursor.current = null;
            setHasMore(true);
            fetchOrders(null, false);
            fetchPendingCount();
          } catch (err: any) {
            Alert.alert('Error', err.message || 'Batch operation failed');
          }
        },
      },
    ]);
  };

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
              if (error.message?.includes('invalid_transition') || error.code === 'P0001') {
                Alert.alert('Invalid Transition', 'This status change is not allowed. Refresh and try again.');
              } else {
                Alert.alert('Error', error.message);
              }
            } else {
              nextCursor.current = null;
              setHasMore(true);
              fetchOrders(null, false);
            }
          },
        },
      ]
    );
  };

  const showAllStatuses = (order: Order) => {
    const allStatuses: OrderStatus[] = [
      'pending_payment',
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
              nextCursor.current = null;
              setHasMore(true);
              fetchOrders(null, false);
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
              nextCursor.current = null;
              setHasMore(true);
              fetchOrders(null, false);
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

    const isSelected = selectedIds.has(item.id);

    return (
      <TouchableOpacity
        style={[styles.card, isSelected && selectionMode && styles.cardSelected]}
        activeOpacity={0.7}
        onLongPress={() => {
          if (!selectionMode) {
            setSelectionMode(true);
            setSelectedIds(new Set([item.id]));
          }
        }}
        onPress={() => {
          if (selectionMode) toggleSelection(item.id);
          else router.push(`/admin/orders/${item.id}` as any);
        }}
      >
        {/* Header */}
        <View style={styles.cardHeader}>
          {selectionMode && (
            <Ionicons
              name={isSelected ? 'checkbox' : 'square-outline'}
              size={22}
              color={isSelected ? '#4C51C9' : '#999'}
              style={styles.selectionCheckbox}
            />
          )}
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
          {item.fulfillment_mode === 'delivery' &&
            ['pending', 'approved', 'packed'].includes(item.status) && (
              <TouchableOpacity
                style={[styles.nextBtn, { backgroundColor: '#5C6BC0' }]}
                onPress={(e) => {
                  e.stopPropagation?.();
                  setAssignTarget(item);
                }}
              >
                <Ionicons name="person-add-outline" size={16} color="#fff" />
                <Text style={styles.nextBtnText}>Assign driver</Text>
              </TouchableOpacity>
            )}

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

          {!isFinal && (
            <TouchableOpacity
              style={styles.cancelBtn}
              onPress={() => updateStatus(item, 'cancelled')}
            >
              <Ionicons name="close-circle-outline" size={16} color="#EF5350" />
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            style={styles.moreBtn}
            onPress={() => showAllStatuses(item)}
          >
            <Ionicons name="ellipsis-horizontal" size={18} color="#888" />
          </TouchableOpacity>

          {item.status === 'delivered' && (
            <View style={styles.completedBadge}>
              <Ionicons name="checkmark-done-circle" size={16} color="#66BB6A" />
              <Text style={styles.completedText}>Completed</Text>
            </View>
          )}

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

  const renderFooter = () => {
    if (isLoadingMore) {
      return (
        <View style={styles.footerLoader}>
          <ActivityIndicator size="small" color={colors.primary} />
        </View>
      );
    }
    if (!hasMore && orders.length > 0) {
      return (
        <View style={styles.footerLoader}>
          <Text style={styles.allLoadedText}>All orders loaded</Text>
        </View>
      );
    }
    return null;
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      {/* Status Filters */}
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
              f.key === 'pending' && pendingCount > 0 && filter !== f.key && styles.filterPending,
            ]}
          >
            <Text
              style={[
                styles.filterText,
                filter === f.key && styles.filterTextActive,
                f.key === 'cancel_requests' && cancelRequestCount > 0 && filter !== f.key && styles.filterCancelRequestsText,
                f.key === 'pending' && pendingCount > 0 && filter !== f.key && styles.filterPendingText,
              ]}
            >
              {f.label}
              {f.key === 'cancel_requests' && cancelRequestCount > 0
                ? ` (${cancelRequestCount})`
                : ''}
              {f.key === 'pending' && pendingCount > 0
                ? ` (${pendingCount})`
                : ''}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Date Range Filter — passes p_from_date/p_to_date to get_orders_page */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.dateFiltersContainer}
      >
        {dateRangeOptions.map((d) => (
          <TouchableOpacity
            key={d.key}
            onPress={() => setDateRange(d.key)}
            style={[
              styles.dateFilterBtn,
              dateRange === d.key && styles.dateFilterActive,
            ]}
          >
            <Ionicons
              name="calendar-outline"
              size={13}
              color={dateRange === d.key ? colors.onPrimary : colors.textMuted}
            />
            <Text
              style={[
                styles.dateFilterText,
                dateRange === d.key && styles.dateFilterTextActive,
              ]}
            >
              {d.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {selectionMode && (
        <View style={styles.selectAllRow}>
          <TouchableOpacity style={styles.selectAllBtn} onPress={selectAll}>
            <Text style={styles.selectAllText}>Select All</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.selectAllBtn} onPress={deselectAll}>
            <Text style={styles.selectAllText}>Deselect All</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.batchExitBtn} onPress={exitSelectionMode}>
            <Text style={styles.batchExitText}>Exit</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Orders list */}
      {loading && !refreshing ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <FlatList
          data={orders}
          keyExtractor={(i) => i.id}
          renderItem={renderOrder}
          contentContainerStyle={{
            padding: 16,
            paddingBottom: selectionMode ? 100 : 40,
          }}
          initialNumToRender={8}
          maxToRenderPerBatch={8}
          windowSize={5}
          removeClippedSubviews
          onEndReached={onEndReached}
          onEndReachedThreshold={0.3}
          ListFooterComponent={renderFooter}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Ionicons name="receipt-outline" size={64} color={colors.textMuted} />
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

      {/* FIX A — Toast notification */}
      {toast && (
        <Animated.View style={[styles.toast, { opacity: toastOpacity }]}>
          <Ionicons name="notifications" size={16} color="#fff" />
          <Text style={styles.toastText}>{toast}</Text>
        </Animated.View>
      )}

      {assignTarget && (
        <AssignDeliveryModal
          visible={!!assignTarget}
          orderId={assignTarget.id}
          orderNumber={assignTarget.order_number}
          onClose={() => setAssignTarget(null)}
          onAssigned={() => {
            setAssignTarget(null);
            nextCursor.current = null;
            setHasMore(true);
            fetchOrders(null, false);
          }}
        />
      )}

      {selectionMode && selectedIds.size > 0 && (
        <View style={styles.batchBar}>
          <Text style={styles.batchCount}>{selectedIds.size} selected</Text>
          {allSelectedPending && (
            <TouchableOpacity
              style={styles.batchBtn}
              onPress={() => handleBatchAction('approved')}
            >
              <Text style={styles.batchBtnText}>Approve All</Text>
            </TouchableOpacity>
          )}
          {allSelectedApproved && (
            <TouchableOpacity
              style={styles.batchBtn}
              onPress={() => handleBatchAction('packed')}
            >
              <Text style={styles.batchBtnText}>Pack All</Text>
            </TouchableOpacity>
          )}
          {canBatchCancel && (
            <TouchableOpacity
              style={[styles.batchBtn, styles.batchBtnDanger]}
              onPress={() => handleBatchAction('cancelled')}
            >
              <Text style={styles.batchBtnText}>Cancel All</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </SafeAreaView>
  );
}

/* ================= STYLES ================= */

function createOrderStyles(c: AppColors, isDark: boolean) {
  const tab = tabScreenBase(c);
  const cancelBtnBg = isDark ? '#3d2024' : '#FFF5F5';
  const cancelledBadgeBg = isDark ? '#3d2024' : '#FFEBEE';
  return {
  container: tab.container,
  center: { flex: 1, justifyContent: 'center' as const, alignItems: 'center' as const },

  filtersContainer: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
    gap: 8,
  },
  filterBtn: {
    ...tab.filterChip,
    paddingVertical: 6,
    borderRadius: 16,
  },
  filterActive: tab.filterChipActive,
  filterText: { fontSize: 13, color: c.textSecondary },
  filterTextActive: tab.filterTextActive,

  dateFiltersContainer: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
    gap: 8,
  },
  dateFilterBtn: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 14,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
  },
  dateFilterActive: {
    backgroundColor: c.success,
    borderColor: c.success,
  },
  dateFilterText: { fontSize: 12, color: c.textSecondary },
  dateFilterTextActive: { color: c.onPrimary, fontWeight: '600' as const },

  card: {
    backgroundColor: c.surface,
    borderRadius: 14,
    padding: 16,
    marginBottom: 14,
    elevation: 2,
    shadowColor: c.shadow,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: isDark ? 0.3 : 0.08,
    shadowRadius: 4,
    borderWidth: isDark ? 1 : 0,
    borderColor: c.border,
  },
  cardHeader: {
    flexDirection: 'row' as const,
    justifyContent: 'space-between' as const,
    alignItems: 'flex-start' as const,
    marginBottom: 10,
  },
  orderNo: { fontSize: 15, fontWeight: '700' as const, color: c.text },
  orderDate: { fontSize: 12, color: c.textMuted, marginTop: 2 },

  statusBadge: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
  },
  statusBadgeText: { color: c.onPrimary, fontSize: 12, fontWeight: '600' as const },

  customerRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 6,
    marginBottom: 10,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: c.borderLight,
  },
  customerText: { fontSize: 13, color: c.textSecondary },

  infoRow: {
    flexDirection: 'row' as const,
    justifyContent: 'space-between' as const,
    marginBottom: 10,
  },
  infoItem: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 4,
  },
  infoText: { fontSize: 12, color: c.textMuted },

  totalRow: {
    flexDirection: 'row' as const,
    justifyContent: 'space-between' as const,
    alignItems: 'center' as const,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: c.borderLight,
    marginBottom: 12,
  },
  totalLabel: { fontSize: 14, color: c.textSecondary },
  totalAmount: { fontSize: 18, fontWeight: '700' as const, color: c.primary },

  actionRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 8,
  },
  nextBtn: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  nextBtnText: {
    color: c.onPrimary,
    fontSize: 13,
    fontWeight: '600' as const,
  },
  cancelBtn: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: isDark ? c.error : '#FFCDD2',
    backgroundColor: cancelBtnBg,
  },
  cancelBtnText: {
    color: c.error,
    fontSize: 13,
    fontWeight: '600' as const,
  },
  moreBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: c.inputBackground,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    marginLeft: 'auto' as const,
  },
  completedBadge: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: c.successMuted,
    borderRadius: 8,
  },
  completedText: {
    color: c.success,
    fontSize: 13,
    fontWeight: '600' as const,
  },
  cancelledBadge: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: cancelledBadgeBg,
    borderRadius: 8,
  },
  cancelledText: {
    color: c.error,
    fontSize: 13,
    fontWeight: '600' as const,
  },

  footerLoader: {
    paddingVertical: 16,
    alignItems: 'center' as const,
  },
  allLoadedText: {
    fontSize: 13,
    color: c.textMuted,
  },

  emptyContainer: {
    alignItems: 'center' as const,
    marginTop: 60,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600' as const,
    color: c.textSecondary,
    marginTop: 16,
  },
  emptySubtitle: {
    fontSize: 14,
    color: c.textMuted,
    marginTop: 4,
  },

  filterCancelRequests: {
    borderColor: '#FF6D00',
    backgroundColor: c.warningBg,
  },
  filterCancelRequestsText: {
    color: '#E65100',
    fontWeight: '600' as const,
  },

  cancelRequestNotification: {
    backgroundColor: c.warningBg,
    borderWidth: 1,
    borderColor: isDark ? c.border : '#FFE0B2',
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
  },
  cancelRequestHeader: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 6,
    marginBottom: 4,
  },
  cancelRequestTitle: {
    fontSize: 13,
    fontWeight: '700' as const,
    color: '#E65100',
  },
  cancelRequestReason: {
    fontSize: 12,
    color: c.loyaltyInfoText,
    marginBottom: 4,
    fontStyle: 'italic' as const,
  },
  cancelRequestTime: {
    fontSize: 11,
    color: c.textMuted,
    marginBottom: 8,
  },
  cancelRequestActions: {
    flexDirection: 'row' as const,
    gap: 8,
  },
  confirmCancelBtn: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 4,
    backgroundColor: c.error,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  confirmCancelBtnText: {
    color: c.onPrimary,
    fontSize: 12,
    fontWeight: '600' as const,
  },
  dismissCancelBtn: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 4,
    backgroundColor: c.inputBackground,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: c.border,
  },
  dismissCancelBtnText: {
    color: c.textSecondary,
    fontSize: 12,
    fontWeight: '600' as const,
  },

  filterPending: {
    borderColor: c.warning,
    backgroundColor: isDark ? c.warningBg : '#FFF8E1',
  },
  filterPendingText: {
    color: '#E65100',
    fontWeight: '600' as const,
  },

  toast: {
    position: 'absolute' as const,
    bottom: 24,
    left: 24,
    right: 24,
    backgroundColor: isDark ? c.surfaceSecondary : '#333',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 8,
    elevation: 6,
    shadowColor: c.shadow,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
  },
  toastText: {
    color: c.onPrimary,
    fontSize: 14,
    fontWeight: '500' as const,
    flex: 1,
  },

  cardSelected: {
    borderWidth: 2,
    borderColor: c.primary,
  },
  selectionCheckbox: { marginRight: 8 },
  selectAllRow: {
    flexDirection: 'row' as const,
    justifyContent: 'flex-end' as const,
    paddingHorizontal: 16,
    paddingBottom: 4,
    gap: 8,
    alignItems: 'center' as const,
  },
  selectAllBtn: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: c.primaryMuted,
  },
  selectAllText: { color: c.primary, fontSize: 12, fontWeight: '600' as const },
  batchBar: {
    position: 'absolute' as const,
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: c.surface,
    borderTopWidth: 1,
    borderTopColor: c.border,
    padding: 12,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 8,
    flexWrap: 'wrap' as const,
    elevation: 8,
  },
  batchCount: { fontSize: 14, fontWeight: '700' as const, color: c.text, marginRight: 'auto' as const },
  batchBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: c.primary,
  },
  batchBtnText: { color: c.onPrimary, fontSize: 13, fontWeight: '600' as const },
  batchBtnDanger: { backgroundColor: c.error },
  batchExitBtn: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: c.inputBackground,
    borderWidth: 1,
    borderColor: c.border,
  },
  batchExitText: { color: c.textSecondary, fontSize: 12, fontWeight: '600' as const },
};
}
