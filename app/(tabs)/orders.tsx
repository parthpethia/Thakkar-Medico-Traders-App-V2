import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  RefreshControl,
  Animated,
} from 'react-native';
import { TabScreenFrame, useTabTopInset } from '../../src/components/TabScreenFrame';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../src/services/supabase';
import { Order, OrderStatus } from '../../src/types';
import { useAuthStore } from '../../src/store/authStore';
import { isTransientNetworkError, supabaseErrorMessage } from '../../src/utils/networkErrors';
import { executeSupabaseQuery, getUserFetchMessage } from '../../src/utils/supabaseQuery';
import { useRealtimeOrders } from '../../src/hooks/useRealtimeOrders';
import { format } from 'date-fns';
import { tabScrollBottomPadding } from '../../src/theme/tabBarTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import type { AppColors } from '../../src/theme/colors';
import { useTranslation } from 'react-i18next';

/* ================= CONSTANTS ================= */

const PAGE_SIZE = 20;

const statusFilters: { key: OrderStatus | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'packed', label: 'Packed' },
  { key: 'dispatched', label: 'Dispatched' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'cancelled', label: 'Cancelled' },
];

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

const statusColor: Record<string, string> = {
  pending: '#FFA726',
  pending_payment: '#FF7043',
  approved: '#42A5F5',
  packed: '#7E57C2',
  dispatched: '#26A69A',
  delivered: '#66BB6A',
  cancelled: '#EF5350',
};

/* ================= PROGRESS BAR ================= */

function OrderProgress({ status, deliveryType }: { status: OrderStatus; deliveryType: string }) {
  const styles = useThemedStyles(createTabStyles);
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

/* ================= CURSOR TYPE ================= */

type PageCursor = { created_at: string; id: string } | null;

/* ================= SCREEN ================= */

export default function Orders() {
  const styles = useThemedStyles(createTabStyles);
  const topInset = useTabTopInset();
  const { t } = useTranslation();
  const { user, authReady } = useAuthStore();
  const router = useRouter();
  const [orders, setOrders] = useState<Order[]>([]);
  const [status, setStatus] = useState<OrderStatus | 'all'>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const nextCursor = useRef<PageCursor>(null);
  const listFetchInFlight = useRef<Promise<void> | null>(null);
  const fetchGeneration = useRef(0);

  // FIX A — toast state for status change notifications
  const [toast, setToast] = useState<string | null>(null);
  const toastOpacity = useRef(new Animated.Value(0)).current;

  const showToast = useCallback((message: string) => {
    setToast(message);
    Animated.sequence([
      Animated.timing(toastOpacity, { toValue: 1, duration: 300, useNativeDriver: true }),
      Animated.delay(2500),
      Animated.timing(toastOpacity, { toValue: 0, duration: 300, useNativeDriver: true }),
    ]).start(() => setToast(null));
  }, [toastOpacity]);

  // FIX A — Realtime: subscribe to status changes on the retailer's orders
  useRealtimeOrders({
    table: 'orders',
    event: 'UPDATE',
    filter: user?.id ? `user_id=eq.${user.id}` : undefined,
    enabled: authReady && !!user?.id,
    onUpdate: (payload) => {
      const updated = payload.new as Order;
      setOrders((prev) =>
        prev.map((o) => (o.id === updated.id ? { ...o, ...updated } : o)),
      );
      const orderNum = updated.order_number || '';
      const newStatus = updated.status?.charAt(0).toUpperCase() + updated.status?.slice(1);
      showToast(`Order #${orderNum} is now ${newStatus}`);
    },
  });

  // Replaces the old .from('orders').select('*').eq('user_id', ...).limit(50)
  // with server-side keyset pagination via get_orders_page RPC
  const fetchOrders = useCallback(async (cursor: PageCursor = null, append = false) => {
    if (!user?.id) return;

    if (!append && listFetchInFlight.current) {
      return listFetchInFlight.current;
    }

    const generation = append ? fetchGeneration.current : ++fetchGeneration.current;

    const run = (async () => {
      try {
        if (!append) setLoading(true);
        else setIsLoadingMore(true);

        const { data, error } = await executeSupabaseQuery(() =>
        supabase.rpc('get_orders_page', {
          p_role: 'retailer',
          p_user_id: user.id,
          p_status: status === 'all' ? null : status,
          p_cursor: cursor?.created_at ?? null,
          p_cursor_id: cursor?.id ?? null,
          p_page_size: PAGE_SIZE,
        }),
      );

        if (error) throw error;

        setFetchError(null);

        if (!append && generation !== fetchGeneration.current) {
          return;
        }

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
      } catch (err: unknown) {
        const message = getUserFetchMessage(err, 'Could not load orders');
        if (!append && generation === fetchGeneration.current) {
          setFetchError(message);
        }
        if (!isTransientNetworkError(err)) {
          console.error('Orders fetch error:', supabaseErrorMessage(err));
        }
      } finally {
        if (!append) {
          listFetchInFlight.current = null;
        }
        if (!append && generation === fetchGeneration.current) {
          setLoading(false);
        }
        setIsLoadingMore(false);
      }
    })();

    if (!append) {
      listFetchInFlight.current = run;
    }
    return run;
  }, [user?.id, status]);

  useEffect(() => {
    if (!authReady || !user?.id) return;
    nextCursor.current = null;
    setHasMore(true);
    fetchOrders(null, false);
  }, [authReady, user?.id, status, fetchOrders]);

  useEffect(() => {
    if (authReady && !user?.id) {
      setOrders([]);
      setLoading(false);
    }
  }, [authReady, user?.id]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    nextCursor.current = null;
    setHasMore(true);
    await fetchOrders(null, false);
    setRefreshing(false);
  }, [fetchOrders]);

  const onEndReached = useCallback(() => {
    if (!hasMore || isLoadingMore || loading) return;
    fetchOrders(nextCursor.current, true);
  }, [hasMore, isLoadingMore, loading, fetchOrders]);

  const renderOrder = ({ item }: { item: Order }) => {
    const itemCount = Array.isArray(item.items)
      ? item.items.reduce((sum: number, i: any) => sum + (i.quantity || 0), 0)
      : 0;

    return (
      <TouchableOpacity
        style={styles.card}
        activeOpacity={0.7}
        onPress={() => router.push(`/order/${item.id}`)}
      >
        {/* Header */}
        <View style={styles.cardHeader}>
          <View>
            <Text style={styles.orderNo}>#{item.order_number}</Text>
            <Text style={styles.orderDate}>
              {format(new Date(item.created_at), 'dd MMM yyyy, hh:mm a')}
            </Text>
          </View>
          <View style={[styles.statusBadge, { backgroundColor: statusColor[item.status] || '#999' }]}>
            <Text style={styles.statusBadgeText}>
              {item.status.charAt(0).toUpperCase() + item.status.slice(1)}
            </Text>
          </View>
        </View>

        {/* Progress */}
        <OrderProgress status={item.status} deliveryType={item.fulfillment_mode || item.delivery_type || 'delivery'} />

        {/* Cancellation Requested Badge */}
        {item.cancellation_requested && item.status !== 'cancelled' && (
          <View style={styles.cancelRequestBadge}>
            <Ionicons name="warning" size={14} color="#E65100" />
            <Text style={styles.cancelRequestBadgeText}>Cancellation Requested</Text>
          </View>
        )}

        {/* Info row */}
        <View style={styles.infoRow}>
          <View style={styles.infoItem}>
            <Ionicons name="cube-outline" size={15} color="#888" />
            <Text style={styles.infoText}>{itemCount} items</Text>
          </View>
          <View style={styles.infoItem}>
            <Ionicons
              name={(item.fulfillment_mode || item.delivery_type) === 'pickup' ? 'storefront-outline' : 'car-outline'}
              size={15}
              color="#888"
            />
            <Text style={styles.infoText}>
              {(item.fulfillment_mode || item.delivery_type) === 'pickup' ? 'Pickup' : 'Delivery'}
            </Text>
          </View>
          <View style={styles.infoItem}>
            <Ionicons name="card-outline" size={15} color="#888" />
            <Text style={styles.infoText}>
              {item.payment_mode === 'cod' ? 'COD' :
               item.payment_mode === 'credit' ? 'Credit' :
               item.payment_mode === 'upi' ? 'UPI' : item.payment_mode?.toUpperCase() || 'COD'}
            </Text>
          </View>
        </View>

        {/* Discount */}
        {(item.discount_amount || 0) > 0 && (
          <View style={[styles.infoItem, { marginTop: 8 }]}>
            <Ionicons name="pricetag-outline" size={14} color="#43A047" />
            <Text style={[styles.infoText, { color: '#43A047', fontWeight: '600' }]}>
              Discount: -₹{(item.discount_amount || 0).toFixed(2)}
            </Text>
          </View>
        )}

        {/* Footer */}
        <View style={styles.cardFooter}>
          <Text style={styles.totalLabel}>Total</Text>
          <Text style={styles.totalAmount}>₹{(item.grand_total || 0).toFixed(2)}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  const renderFooter = () => {
    if (isLoadingMore) {
      return (
        <View style={styles.footerLoader}>
          <ActivityIndicator size="small" color="#4C51C9" />
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
    <TabScreenFrame style={styles.container}>
      {/* Filters */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={[styles.filtersContainer, { paddingTop: topInset + 12 }]}
      >
        {statusFilters.map((f) => (
          <TouchableOpacity
            key={f.key}
            onPress={() => setStatus(f.key)}
            style={[
              styles.filterBtn,
              status === f.key && styles.filterActive,
            ]}
          >
            <Text
              style={[
                styles.filterText,
                status === f.key && styles.filterTextActive,
              ]}
            >
              {f.label}
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
          contentContainerStyle={{
            padding: 16,
            ...tabScrollBottomPadding(),
          }}
          initialNumToRender={8}
          maxToRenderPerBatch={8}
          windowSize={5}
          removeClippedSubviews
          onEndReached={onEndReached}
          onEndReachedThreshold={0.3}
          ListFooterComponent={renderFooter}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          ListEmptyComponent={
            fetchError ? (
              <View style={styles.emptyContainer}>
                <Ionicons name="cloud-offline-outline" size={64} color="#ccc" />
                <Text style={styles.emptyTitle}>Could not load orders</Text>
                <Text style={styles.emptySubtitle}>{fetchError}</Text>
              </View>
            ) : (
            <View style={styles.emptyContainer}>
              <Ionicons name="receipt-outline" size={64} color="#ccc" />
              <Text style={styles.emptyTitle}>{t('orders.noOrders')}</Text>
              <Text style={styles.emptySubtitle}>
                {status === 'all'
                  ? "You haven't placed any orders yet"
                  : `No ${status} orders`}
              </Text>
            </View>
            )
          }
        />
      )}

      {/* FIX A — Toast notification */}
      {toast && (
        <Animated.View style={styles.toast} pointerEvents="none">
          <Animated.View style={{ opacity: toastOpacity, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Ionicons name="notifications" size={16} color="#fff" />
            <Text style={styles.toastText}>{toast}</Text>
          </Animated.View>
        </Animated.View>
      )}
    </TabScreenFrame>
  );
}

/* ================= STYLES ================= */

function createTabStyles(c: AppColors) {
  return {
  container: { flex: 1, backgroundColor: c.background },
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
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
  },
  filterActive: {
    backgroundColor: '#4C51C9',
    borderColor: '#4C51C9',
  },
  filterText: { fontSize: 13, color: c.textSecondary },
  filterTextActive: { color: '#fff', fontWeight: '600' },

  /* Card */
  card: {
    backgroundColor: c.surface,
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
    marginBottom: 14,
  },
  orderNo: { fontSize: 15, fontWeight: '700', color: c.text },
  orderDate: { fontSize: 12, color: c.textMuted, marginTop: 3 },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
  },
  statusBadgeText: { color: '#fff', fontSize: 12, fontWeight: '600' },

  /* Progress */
  progressContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 14,
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
    marginBottom: 14,
  },
  cancelledText: {
    color: '#C62828',
    fontWeight: '600',
    fontSize: 13,
  },

  /* Cancel request badge */
  cancelRequestBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#FFF3E0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 14,
  },
  cancelRequestBadgeText: {
    color: '#E65100',
    fontSize: 12,
    fontWeight: '600',
  },

  /* Info row */
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: c.borderLight,
  },
  infoItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  infoText: { fontSize: 12, color: c.textMuted },

  /* Footer */
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: c.borderLight,
  },
  totalLabel: { fontSize: 14, color: c.textSecondary },
  totalAmount: { fontSize: 18, fontWeight: '700', color: '#4C51C9' },

  /* List footer */
  footerLoader: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  allLoadedText: {
    fontSize: 13,
    color: c.textMuted,
  },

  /* Empty */
  emptyContainer: {
    alignItems: 'center',
    marginTop: 60,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: c.textSecondary,
    marginTop: 16,
  },
  emptySubtitle: {
    fontSize: 14,
    color: c.textMuted,
    marginTop: 4,
  },

  /* Toast */
  toast: {
    position: 'absolute',
    bottom: 24,
    left: 24,
    right: 24,
    backgroundColor: '#333',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    elevation: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
  },
  toastText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
    flex: 1,
  },
};
}
