import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../src/services/supabase';
import { Order, OrderStatus } from '../../src/types';
import { useAuthStore } from '../../src/store/authStore';
import { format } from 'date-fns';

/* ================= CONSTANTS ================= */

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
  approved: '#42A5F5',
  packed: '#7E57C2',
  dispatched: '#26A69A',
  delivered: '#66BB6A',
  cancelled: '#EF5350',
};

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

export default function Orders() {
  const { user } = useAuthStore();
  const router = useRouter();
  const [orders, setOrders] = useState<Order[]>([]);
  const [status, setStatus] = useState<OrderStatus | 'all'>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchOrders = async () => {
    if (!user) return;

    try {
      setLoading(true);

      let query = supabase
        .from('orders')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50);

      if (status !== 'all') {
        query = query.eq('status', status);
      }

      const { data, error } = await query;
      if (error) throw error;

      setOrders(data || []);
    } catch (err: any) {
      console.error('Orders fetch error:', err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOrders();
  }, [status]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchOrders();
    setRefreshing(false);
  }, [status]);

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
        <OrderProgress status={item.status} deliveryType={item.delivery_type || 'delivery'} />

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
              name={item.delivery_type === 'pickup' ? 'storefront-outline' : 'car-outline'}
              size={15}
              color="#888"
            />
            <Text style={styles.infoText}>
              {item.delivery_type === 'pickup' ? 'Pickup' : 'Delivery'}
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

        {/* Footer */}
        <View style={styles.cardFooter}>
          <Text style={styles.totalLabel}>Total</Text>
          <Text style={styles.totalAmount}>₹{(item.grand_total || 0).toFixed(2)}</Text>
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
                {status === 'all'
                  ? "You haven't placed any orders yet"
                  : `No ${status} orders`}
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
    marginBottom: 14,
  },
  orderNo: { fontSize: 15, fontWeight: '700', color: '#333' },
  orderDate: { fontSize: 12, color: '#999', marginTop: 3 },
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
    borderTopColor: '#f0f0f0',
  },
  infoItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  infoText: { fontSize: 12, color: '#888' },

  /* Footer */
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
  },
  totalLabel: { fontSize: 14, color: '#666' },
  totalAmount: { fontSize: 18, fontWeight: '700', color: '#4C51C9' },

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
});
