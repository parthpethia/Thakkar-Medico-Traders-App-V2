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
  Vibration,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, Stack } from 'expo-router';
import { supabase } from '../../src/services/supabase';
import { Order, OrderStatus } from '../../src/types';
import { useRealtimeOrders } from '../../src/hooks/useRealtimeOrders';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import type { AppColors } from '../../src/theme/colors';
import { format, formatDistanceToNow } from 'date-fns';
import { AssignDeliveryModal } from '../../src/components/delivery/AssignDeliveryModal';
import { getAdminOverflowStatuses } from '../../src/constants/orderFlow';

/* ================= CONSTANTS ================= */

const PAGE_SIZE = 15;

const statusColor: Record<string, string> = {
  pending: '#FF9800',
  pending_payment: '#9C27B0',
  payment_failed: '#E53935',
  assigned: '#3F51B5',
  accepted: '#009688',
  approved: '#2196F3',
  packed: '#673AB7',
  picked_up: '#00BCD4',
  dispatched: '#009688',
  delivered: '#4CAF50',
  cancelled: '#F44336',
  rejected: '#D32F2F',
  delivery_failed: '#E53935',
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

const nextStatus: Record<string, OrderStatus> = {
  pending: 'approved',
  approved: 'packed',
  packed: 'dispatched',
  picked_up: 'dispatched',
  dispatched: 'delivered',
};

type PageCursor = { created_at: string; id: string } | null;

function formatStatus(status: string): string {
  if (!status) return '';
  return status
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export default function AdminOrders() {
  const styles = useThemedStyles(createOrderStyles);
  const { colors, isDark } = useAppTheme();
  const router = useRouter();

  // Tab State: Zomato/Amazon Style pipelines
  const [activeTab, setActiveTab] = useState<'incoming' | 'active' | 'completed'>('incoming');
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const nextCursor = useRef<PageCursor>(null);

  // Tab Counts
  const [incomingCount, setIncomingCount] = useState(0);
  const [activeCount, setActiveCount] = useState(0);

  // Alarm and Mute State
  const [isMuted, setIsMuted] = useState(false);
  const [alarmActive, setAlarmActive] = useState(false);

  // Batch actions / selection state
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Toast / Modal State
  const [toast, setToast] = useState<string | null>(null);
  const toastOpacity = useRef(new Animated.Value(0)).current;
  const [assignTarget, setAssignTarget] = useState<Order | null>(null);

  // Blinking/pulse animation for incoming pending orders
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 0.4, duration: 800, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
      ])
    ).start();
  }, [pulseAnim]);

  const showToast = useCallback((message: string) => {
    setToast(message);
    Animated.sequence([
      Animated.timing(toastOpacity, { toValue: 1, duration: 300, useNativeDriver: true }),
      Animated.delay(2500),
      Animated.timing(toastOpacity, { toValue: 0, duration: 300, useNativeDriver: true }),
    ]).start(() => setToast(null));
  }, [toastOpacity]);

  // Realtime subscription for incoming orders
  useRealtimeOrders({
    table: 'orders',
    event: 'INSERT',
    filter: 'status=eq.pending',
    onInsert: (payload) => {
      setIncomingCount((c) => c + 1);
      const name = payload.new?.user_name || 'a retailer';
      showToast(`New order from ${name}`);
      fetchOrders(null, false); // Reload active tab lists
      // Trigger alarm
      setAlarmActive(true);
    },
  });

  // Realtime subscription for updates
  useRealtimeOrders({
    table: 'orders',
    event: 'UPDATE',
    onUpdate: () => {
      fetchTabCounts();
      fetchOrders(null, false);
    },
  });

  const fetchTabCounts = useCallback(async () => {
    try {
      const [incomingRes, activeRes] = await Promise.all([
        supabase
          .from('orders')
          .select('id', { count: 'exact', head: true })
          .or('status.eq.pending,status.eq.pending_payment,cancellation_requested.eq.true')
          .neq('status', 'cancelled'),
        supabase
          .from('orders')
          .select('id', { count: 'exact', head: true })
          .in('status', ['approved', 'packed', 'dispatched', 'assigned', 'accepted']),
      ]);

      setIncomingCount(incomingRes.count || 0);
      setActiveCount(activeRes.count || 0);

      // Trigger alarm if there are pending orders
      if ((incomingRes.count || 0) > 0) {
        setAlarmActive(true);
      } else {
        setAlarmActive(false);
      }
    } catch (err) {
      console.error('Error fetching tab counts:', err);
    }
  }, []);

  const fetchOrders = useCallback(async (cursor: PageCursor = null, append = false) => {
    try {
      if (!append) setLoading(true);
      else setIsLoadingMore(true);

      let query = supabase.from('orders').select('*');

      if (activeTab === 'incoming') {
        query = query
          .or('status.eq.pending,status.eq.pending_payment,cancellation_requested.eq.true')
          .neq('status', 'cancelled');
      } else if (activeTab === 'active') {
        query = query.in('status', ['approved', 'packed', 'dispatched', 'assigned', 'accepted']);
      } else {
        query = query.in('status', ['delivered', 'cancelled', 'rejected', 'delivery_failed']);
      }

      if (cursor) {
        query = query.or(`created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`);
      }

      const { data, error } = await query
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(PAGE_SIZE);

      if (error) throw error;

      const rows = (data || []) as Order[];

      // BATCH ENRICH PRODUCT NAMES TO FIX "UNKNOWN ITEM" BUG
      const productIds = Array.from(
        new Set(
          rows.flatMap((o) => {
            const itemsArray = Array.isArray(o.items)
              ? o.items
              : typeof o.items === 'string'
              ? JSON.parse(o.items)
              : [];
            return itemsArray.map((i: any) => i.product_id).filter(Boolean);
          })
        )
      );

      let enrichedRows = rows;
      if (productIds.length > 0) {
        const { data: productsData, error: productsError } = await supabase
          .from('products')
          .select('id, name')
          .in('id', productIds);
        
        if (!productsError && productsData) {
          const productMap = new Map(productsData.map((p) => [p.id, p.name]));
          enrichedRows = rows.map((order) => {
            const itemsArray = Array.isArray(order.items)
              ? order.items
              : typeof order.items === 'string'
              ? JSON.parse(order.items)
              : [];
            const enrichedItems = itemsArray.map((it: any) => ({
              ...it,
              product_name: it.product_name || it.name || productMap.get(it.product_id) || 'Unknown Product',
              qty: it.qty ?? it.quantity ?? 0,
            }));
            return { ...order, items: enrichedItems };
          });
        }
      }

      if (append) {
        setOrders((prev) => [...prev, ...enrichedRows]);
      } else {
        setOrders(enrichedRows);
      }

      if (rows.length < PAGE_SIZE) {
        setHasMore(false);
        nextCursor.current = null;
      } else {
        const last = rows[rows.length - 1];
        nextCursor.current = { created_at: last.created_at, id: last.id };
        setHasMore(true);
      }
    } catch (err: any) {
      Alert.alert('Error', err.message);
    } finally {
      setLoading(false);
      setIsLoadingMore(false);
    }
  }, [activeTab]);

  useEffect(() => {
    nextCursor.current = null;
    setHasMore(true);
    fetchOrders(null, false);
    fetchTabCounts();
  }, [activeTab, fetchOrders, fetchTabCounts]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    nextCursor.current = null;
    setHasMore(true);
    await fetchOrders(null, false);
    await fetchTabCounts();
    setRefreshing(false);
  }, [fetchOrders, fetchTabCounts]);

  const onEndReached = useCallback(() => {
    if (!hasMore || isLoadingMore || loading) return;
    fetchOrders(nextCursor.current, true);
  }, [hasMore, isLoadingMore, loading, fetchOrders]);

  // Loop alarm vibration
  useEffect(() => {
    let interval: NodeJS.Timeout;
    const hasIncomingPending = orders.some((o) => o.status === 'pending') || incomingCount > 0;

    if (hasIncomingPending && alarmActive && !isMuted) {
      // Looping vibration pattern: Vibrate 800ms, Pause 1000ms, repeat
      const runVibe = () => {
        Vibration.vibrate([0, 800, 1000, 800]);
      };
      runVibe();
      interval = setInterval(runVibe, 3000);
    } else {
      Vibration.cancel();
    }

    return () => {
      clearInterval(interval);
      Vibration.cancel();
    };
  }, [orders, incomingCount, alarmActive, isMuted]);

  // Selection Mode helpers
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
    const label = formatStatus(newStatus);

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
            fetchTabCounts();
          } catch (err: any) {
            Alert.alert('Error', err.message || 'Batch operation failed');
          }
        },
      },
    ]);
  };

  const updateStatus = async (order: Order, newStatus: OrderStatus) => {
    const label = formatStatus(newStatus);

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
              fetchTabCounts();
            }
          },
        },
      ]
    );
  };

  const showAllStatuses = (order: Order) => {
    const allowed = getAdminOverflowStatuses(order.status, order.payment_mode);
    if (allowed.length === 0) {
      Alert.alert('Status Info', 'No further status transitions are available for this order.');
      return;
    }

    Alert.alert(
      'Set Status',
      `Order #${order.order_number}`,
      [
        ...allowed.map((s) => ({
          text: formatStatus(s),
          onPress: () => updateStatus(order, s),
        })),
        { text: 'Cancel', style: 'cancel' },
      ]
    );
  };

  /* -------- CANCELLATION REQUESTS -------- */
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
              fetchTabCounts();
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
              fetchTabCounts();
            }
          },
        },
      ]
    );
  };

  /* -------- RENDER TICKETS (KITCHEN/BILLING DESIGN) -------- */
  const renderOrder = ({ item }: { item: Order }) => {
    const isSelected = selectedIds.has(item.id);
    const isPickup = item.fulfillment_mode === 'pickup' || item.delivery_type === 'pickup';
    const relativeTime = formatDistanceToNow(new Date(item.created_at), { addSuffix: true });

    // Item parsing
    const orderItems = Array.isArray(item.items) ? item.items : [];

    const next = nextStatus[item.status];
    const isFinal = item.status === 'delivered' || item.status === 'cancelled';

    const getNextLabel = (status: string) => {
      if (isPickup && status === 'dispatched') return 'Ready for Pickup';
      if (isPickup && status === 'delivered') return 'Collected / Paid';
      return formatStatus(status);
    };

    // Style helper for payment modes
    const getPaymentBadgeStyle = (mode: string) => {
      switch (mode?.toLowerCase()) {
        case 'cod':
          return { bg: '#E8F5E9', text: '#2E7D32', label: 'CASH TO COLLECT (COD)' };
        case 'credit':
          return { bg: '#E3F2FD', text: '#1565C0', label: 'BOOKED ON CREDIT' };
        case 'upi':
          return { bg: '#F3E5F5', text: '#6A1B9A', label: 'ONLINE PAID (UPI)' };
        default:
          return { bg: '#ECEFF1', text: '#37474F', label: mode?.toUpperCase() };
      }
    };
    const paymentStyle = getPaymentBadgeStyle(item.payment_mode);

    // Glowing border for incoming pending orders
    const isIncomingPending = item.status === 'pending' || item.status === 'pending_payment';

    return (
      <TouchableOpacity
        style={[
          styles.ticketCard,
          isSelected && selectionMode && styles.ticketCardSelected,
          isIncomingPending && activeTab === 'incoming' && styles.ticketCardIncoming,
        ]}
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
        {/* Top bar with Order Number, Time elapsed, Fulfillment */}
        <View style={styles.ticketHeader}>
          {selectionMode && (
            <Ionicons
              name={isSelected ? 'checkbox' : 'square-outline'}
              size={22}
              color={isSelected ? colors.primary : colors.textMuted}
              style={{ marginRight: 8 }}
            />
          )}
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={styles.ticketOrderNumber}>#{item.order_number}</Text>
              {item.items_adjusted && (
                <View style={styles.adjustedBadge}>
                  <Ionicons name="create-outline" size={10} color="#E65100" />
                  <Text style={styles.adjustedBadgeText}>Adjusted</Text>
                </View>
              )}
            </View>
            <Text style={styles.ticketTimeElapsed}>{relativeTime} · {format(new Date(item.created_at), 'hh:mm a')}</Text>
          </View>
          <View style={styles.headerRightCol}>
            <View style={[styles.fulfillmentBadge, { backgroundColor: isPickup ? '#FFF3E0' : '#E0F2F1' }]}>
              <Ionicons name={isPickup ? 'storefront-outline' : 'car-outline'} size={12} color={isPickup ? '#E65100' : '#004D40'} />
              <Text style={[styles.fulfillmentText, { color: isPickup ? '#E65100' : '#004D40' }]}>
                {isPickup ? 'Pickup' : 'Delivery'}
              </Text>
            </View>
          </View>
        </View>

        {/* Retailer Info */}
        <View style={styles.retailerContainer}>
          <Ionicons name="business-outline" size={16} color={colors.textSecondary} />
          <View style={{ flex: 1, marginLeft: 6 }}>
            <Text style={styles.retailerNameText}>{item.user_name || 'Counter Customer'}</Text>
            <Text style={styles.retailerPhoneText}>{item.user_phone || 'No phone'}</Text>
          </View>
        </View>

        {/* Yellow Instructions Banner */}
        {item.notes ? (
          <View style={styles.notesBanner}>
            <Ionicons name="alert-circle-outline" size={16} color="#E65100" />
            <Text style={styles.notesText} numberOfLines={2}>
              Note: "{item.notes}"
            </Text>
          </View>
        ) : null}

        {/* Cancellation Alert */}
        {item.cancellation_requested && item.status !== 'cancelled' && (
          <View style={styles.cancelAlertBanner}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <Ionicons name="warning" size={18} color="#D32F2F" />
              <Text style={styles.cancelAlertTitle}>Retailer requested Cancellation</Text>
            </View>
            {item.cancellation_reason ? (
              <Text style={styles.cancelAlertReason}>Reason: {item.cancellation_reason}</Text>
            ) : null}
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
              <TouchableOpacity style={styles.cancelActionBtnYes} onPress={() => confirmCancellation(item)}>
                <Text style={styles.cancelActionBtnTextYes}>Approve Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.cancelActionBtnNo} onPress={() => dismissCancelRequest(item)}>
                <Text style={styles.cancelActionBtnTextNo}>Decline</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Items Listing - Large & Highly Readable */}
        <View style={styles.ticketItemsContainer}>
          {orderItems.map((it: any, index: number) => (
            <View key={index} style={styles.ticketItemRow}>
              <Text style={styles.ticketItemQty}>{it.qty || it.quantity} x</Text>
              <Text style={styles.ticketItemName} numberOfLines={2}>
                {it.product_name || it.name || 'Unknown Item'}
              </Text>
            </View>
          ))}
        </View>

        {/* Payment Summary Footer */}
        <View style={styles.ticketFooter}>
          <View style={[styles.paymentBadge, { backgroundColor: paymentStyle.bg }]}>
            <Text style={[styles.paymentBadgeText, { color: paymentStyle.text }]}>{paymentStyle.label}</Text>
          </View>
          <View style={styles.priceContainer}>
            <Text style={styles.totalPriceLabel}>Grand Total</Text>
            <Text style={styles.totalPriceAmount}>₹{(item.grand_total || 0).toFixed(2)}</Text>
          </View>
        </View>

        {/* Action Button Row */}
        <View style={styles.ticketActionRow}>
          {item.fulfillment_mode === 'delivery' && ['pending', 'approved', 'packed'].includes(item.status) && (
            <TouchableOpacity
              style={[styles.actionButton, { backgroundColor: '#5C6BC0', flex: 1.2 }]}
              onPress={(e) => {
                e.stopPropagation?.();
                setAssignTarget(item);
              }}
            >
              <Ionicons name="person-add-outline" size={16} color="#fff" />
              <Text style={styles.actionButtonText}>Assign Rider</Text>
            </TouchableOpacity>
          )}

          {next && (
            <Animated.View style={{ flex: 2, opacity: isIncomingPending && activeTab === 'incoming' ? pulseAnim : 1 }}>
              <TouchableOpacity
                style={[styles.actionButton, { backgroundColor: statusColor[next] || '#2E7D32', width: '100%' }]}
                onPress={(e) => {
                  e.stopPropagation?.();
                  updateStatus(item, next);
                }}
              >
                <Ionicons name={statusIcon[next] || 'arrow-forward'} size={16} color="#fff" />
                <Text style={styles.actionButtonText}>Mark {getNextLabel(next)}</Text>
              </TouchableOpacity>
            </Animated.View>
          )}

          {!isFinal && (
            <TouchableOpacity
              style={[styles.actionButtonOutline, { flex: 1 }]}
              onPress={(e) => {
                e.stopPropagation?.();
                updateStatus(item, 'cancelled');
              }}
            >
              <Text style={styles.actionButtonOutlineText}>Cancel</Text>
            </TouchableOpacity>
          )}

          {item.status === 'delivered' && (
            <View style={[styles.statusBannerTextRow, { backgroundColor: '#E8F5E9' }]}>
              <Ionicons name="checkmark-done-circle" size={16} color="#2E7D32" />
              <Text style={{ color: '#2E7D32', fontWeight: '700', fontSize: 13 }}>DELIVERED</Text>
            </View>
          )}

          {item.status === 'cancelled' && (
            <View style={[styles.statusBannerTextRow, { backgroundColor: '#FFEBEE' }]}>
              <Ionicons name="close-circle" size={16} color="#C62828" />
              <Text style={{ color: '#C62828', fontWeight: '700', fontSize: 13 }}>CANCELLED</Text>
            </View>
          )}

          {item.status === 'delivery_failed' && (
            <View style={[styles.statusBannerTextRow, { backgroundColor: '#FFF3E0' }]}>
              <Ionicons name="alert-circle" size={16} color="#EF6C00" />
              <Text style={{ color: '#EF6C00', fontWeight: '700', fontSize: 13 }}>FAILED</Text>
            </View>
          )}

          <TouchableOpacity
            style={styles.moreActionBtn}
            onPress={(e) => {
              e.stopPropagation?.();
              showAllStatuses(item);
            }}
          >
            <Ionicons name="ellipsis-horizontal" size={18} color={colors.textSecondary} />
          </TouchableOpacity>
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
      <Stack.Screen
        options={{
          title: 'Store Orders Manager',
          headerRight: () => (
            <TouchableOpacity
              style={styles.posBillingButton}
              onPress={() => router.push('/admin/orders/pos')}
            >
              <Ionicons name="calculator-outline" size={16} color="#fff" />
              <Text style={styles.posBillingButtonText}>POS Bill</Text>
            </TouchableOpacity>
          ),
        }}
      />

      {/* Vibration Alarm Flashing Banner */}
      {orders.some((o) => o.status === 'pending') && alarmActive && !isMuted && (
        <TouchableOpacity style={styles.alarmBanner} onPress={() => setIsMuted(true)}>
          <Ionicons name="notifications-outline" size={18} color="#fff" style={styles.alarmIcon} />
          <Text style={styles.alarmBannerText}>🚨 NEW PENDING ORDERS! TAP TO SILENCE</Text>
        </TouchableOpacity>
      )}

      {/* Mute and POS quick info header */}
      <View style={styles.utilityHeader}>
        <Text style={styles.onlineBadge}>● Store Online</Text>
        <TouchableOpacity style={styles.muteToggle} onPress={() => setIsMuted(!isMuted)}>
          <Ionicons name={isMuted ? 'volume-mute-outline' : 'volume-high-outline'} size={18} color={colors.primary} />
          <Text style={styles.muteToggleText}>{isMuted ? 'Alerts Paused' : 'Alerts Active'}</Text>
        </TouchableOpacity>
      </View>

      {/* Zomato/Amazon Style Status Pipeline Tabs */}
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tabItem, activeTab === 'incoming' && styles.tabItemActive]}
          onPress={() => {
            setActiveTab('incoming');
            setAlarmActive(false); // Silence alarm when they click incoming
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={[styles.tabText, activeTab === 'incoming' && styles.tabTextActive]}>INCOMING</Text>
            {incomingCount > 0 && (
              <View style={[styles.tabBadge, { backgroundColor: '#FF5722' }]}>
                <Text style={styles.tabBadgeText}>{incomingCount}</Text>
              </View>
            )}
          </View>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tabItem, activeTab === 'active' && styles.tabItemActive]}
          onPress={() => setActiveTab('active')}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={[styles.tabText, activeTab === 'active' && styles.tabTextActive]}>ACTIVE</Text>
            {activeCount > 0 && (
              <View style={[styles.tabBadge, { backgroundColor: colors.primary }]}>
                <Text style={styles.tabBadgeText}>{activeCount}</Text>
              </View>
            )}
          </View>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tabItem, activeTab === 'completed' && styles.tabItemActive]}
          onPress={() => setActiveTab('completed')}
        >
          <Text style={[styles.tabText, activeTab === 'completed' && styles.tabTextActive]}>COMPLETED</Text>
        </TouchableOpacity>
      </View>

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
            padding: 12,
            paddingBottom: selectionMode ? 100 : 40,
          }}
          onEndReached={onEndReached}
          onEndReachedThreshold={0.3}
          ListFooterComponent={renderFooter}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Ionicons name="receipt-outline" size={64} color={colors.textMuted} />
              <Text style={styles.emptyTitle}>No orders in this stage</Text>
              <Text style={styles.emptySubtitle}>
                {activeTab === 'incoming'
                  ? 'No incoming orders or cancellation requests'
                  : activeTab === 'active'
                  ? 'No active orders in preparation'
                  : 'No completed or cancelled orders'}
              </Text>
            </View>
          }
        />
      )}

      {/* Toast Notification */}
      {toast && (
        <Animated.View style={[styles.toast, { opacity: toastOpacity }, selectionMode && { bottom: 100 }]}>
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
            fetchTabCounts();
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
  return {
    container: {
      flex: 1,
      backgroundColor: isDark ? c.background : '#F5F5F5',
    },
    center: {
      flex: 1,
      justifyContent: 'center' as const,
      alignItems: 'center' as const,
    },
    posBillingButton: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 4,
      backgroundColor: c.success,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 18,
      marginRight: 10,
    },
    posBillingButtonText: {
      color: '#fff',
      fontSize: 13,
      fontWeight: '700' as const,
    },
    alarmBanner: {
      backgroundColor: '#D32F2F',
      paddingVertical: 10,
      paddingHorizontal: 16,
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    alarmIcon: {
      marginRight: 6,
    },
    alarmBannerText: {
      color: '#fff',
      fontWeight: '700' as const,
      fontSize: 12,
      textAlign: 'center' as const,
    },
    utilityHeader: {
      flexDirection: 'row' as const,
      justifyContent: 'space-between' as const,
      alignItems: 'center' as const,
      paddingHorizontal: 16,
      paddingVertical: 10,
      backgroundColor: c.surface,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    onlineBadge: {
      color: '#4CAF50',
      fontWeight: '700' as const,
      fontSize: 13,
    },
    muteToggle: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 4,
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 14,
      backgroundColor: c.primaryMuted,
    },
    muteToggleText: {
      color: c.primary,
      fontSize: 12,
      fontWeight: '600' as const,
    },
    tabBar: {
      flexDirection: 'row' as const,
      backgroundColor: c.surface,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    tabItem: {
      flex: 1,
      paddingVertical: 12,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      borderBottomWidth: 3,
      borderBottomColor: 'transparent',
    },
    tabItemActive: {
      borderBottomColor: c.primary,
    },
    tabText: {
      fontSize: 13,
      fontWeight: '600' as const,
      color: c.textMuted,
    },
    tabTextActive: {
      color: c.primary,
      fontWeight: '700' as const,
    },
    tabBadge: {
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 10,
    },
    tabBadgeText: {
      color: '#fff',
      fontSize: 10,
      fontWeight: '700' as const,
    },

    /* Ticket Card styling */
    ticketCard: {
      backgroundColor: c.surface,
      borderRadius: 12,
      padding: 16,
      marginBottom: 12,
      borderWidth: 1,
      borderColor: c.border,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: isDark ? 0.3 : 0.06,
      shadowRadius: 6,
      elevation: 3,
    },
    ticketCardSelected: {
      borderColor: c.primary,
      borderWidth: 2,
    },
    ticketCardIncoming: {
      borderColor: '#FF9800',
      borderWidth: 2.5,
    },
    ticketHeader: {
      flexDirection: 'row' as const,
      justifyContent: 'space-between' as const,
      alignItems: 'center' as const,
      paddingBottom: 10,
      borderBottomWidth: 1,
      borderBottomColor: c.borderLight,
      marginBottom: 10,
    },
    ticketOrderNumber: {
      fontSize: 17,
      fontWeight: '800' as const,
      color: c.text,
    },
    ticketTimeElapsed: {
      fontSize: 11,
      color: c.textMuted,
      marginTop: 2,
    },
    headerRightCol: {
      alignItems: 'flex-end' as const,
    },
    fulfillmentBadge: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 6,
    },
    fulfillmentText: {
      fontSize: 11,
      fontWeight: '700' as const,
    },
    retailerContainer: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      marginBottom: 10,
    },
    retailerNameText: {
      fontSize: 14,
      fontWeight: '700' as const,
      color: c.text,
    },
    retailerPhoneText: {
      fontSize: 12,
      color: c.textSecondary,
    },
    notesBanner: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 6,
      backgroundColor: '#FFFDE7',
      borderWidth: 1,
      borderColor: '#FFF59D',
      padding: 8,
      borderRadius: 8,
      marginBottom: 10,
    },
    notesText: {
      fontSize: 12,
      color: '#E65100',
      fontWeight: '500' as const,
      flex: 1,
    },
    cancelAlertBanner: {
      backgroundColor: '#FFEBEE',
      borderWidth: 1,
      borderColor: '#FFCDD2',
      borderRadius: 8,
      padding: 10,
      marginBottom: 10,
    },
    cancelAlertTitle: {
      color: '#C62828',
      fontSize: 13,
      fontWeight: '700' as const,
    },
    cancelAlertReason: {
      fontSize: 12,
      color: '#D32F2F',
      fontStyle: 'italic' as const,
    },
    cancelActionBtnYes: {
      backgroundColor: '#D32F2F',
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 6,
    },
    cancelActionBtnTextYes: {
      color: '#fff',
      fontSize: 11,
      fontWeight: '700' as const,
    },
    cancelActionBtnNo: {
      backgroundColor: '#fff',
      borderWidth: 1,
      borderColor: c.border,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 6,
    },
    cancelActionBtnTextNo: {
      color: c.textSecondary,
      fontSize: 11,
      fontWeight: '600' as const,
    },
    ticketItemsContainer: {
      backgroundColor: isDark ? c.surfaceSecondary : '#FAF9F6',
      borderRadius: 8,
      padding: 12,
      marginBottom: 12,
      borderWidth: 1,
      borderColor: c.borderLight,
    },
    ticketItemRow: {
      flexDirection: 'row' as const,
      alignItems: 'flex-start' as const,
      marginBottom: 6,
    },
    ticketItemQty: {
      fontSize: 15,
      fontWeight: '800' as const,
      color: c.text,
      width: 38,
    },
    ticketItemName: {
      fontSize: 15,
      fontWeight: '600' as const,
      color: c.text,
      flex: 1,
    },
    ticketFooter: {
      flexDirection: 'row' as const,
      justifyContent: 'space-between' as const,
      alignItems: 'center' as const,
      paddingBottom: 12,
      borderBottomWidth: 1,
      borderBottomColor: c.borderLight,
      marginBottom: 12,
    },
    paymentBadge: {
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 6,
    },
    paymentBadgeText: {
      fontSize: 11,
      fontWeight: '700' as const,
    },
    priceContainer: {
      alignItems: 'flex-end' as const,
    },
    totalPriceLabel: {
      fontSize: 11,
      color: c.textMuted,
    },
    totalPriceAmount: {
      fontSize: 18,
      fontWeight: '800' as const,
      color: c.primary,
    },
    ticketActionRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 8,
    },
    actionButton: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      gap: 4,
      paddingVertical: 10,
      borderRadius: 8,
    },
    actionButtonText: {
      color: '#fff',
      fontWeight: '700' as const,
      fontSize: 13,
    },
    actionButtonOutline: {
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      paddingVertical: 10,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    actionButtonOutlineText: {
      color: c.textSecondary,
      fontWeight: '600' as const,
      fontSize: 13,
    },
    statusBannerTextRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 4,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderRadius: 8,
      flex: 2,
      justifyContent: 'center' as const,
    },
    moreActionBtn: {
      width: 38,
      height: 38,
      borderRadius: 8,
      backgroundColor: c.inputBackground,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      borderWidth: 1,
      borderColor: c.border,
    },

    /* Other styles */
    selectAllRow: {
      flexDirection: 'row' as const,
      justifyContent: 'flex-end' as const,
      paddingHorizontal: 16,
      paddingVertical: 6,
      gap: 8,
    },
    selectAllBtn: {
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 6,
      backgroundColor: c.primaryMuted,
    },
    selectAllText: {
      color: c.primary,
      fontSize: 11,
      fontWeight: '700' as const,
    },
    batchExitBtn: {
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 6,
      backgroundColor: c.inputBackground,
      borderWidth: 1,
      borderColor: c.border,
    },
    batchExitText: {
      color: c.textSecondary,
      fontSize: 11,
      fontWeight: '600' as const,
    },
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
      elevation: 8,
    },
    batchCount: {
      fontSize: 13,
      fontWeight: '700' as const,
      color: c.text,
      marginRight: 'auto' as const,
    },
    batchBtn: {
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 6,
      backgroundColor: c.primary,
    },
    batchBtnText: {
      color: '#fff',
      fontSize: 12,
      fontWeight: '700' as const,
    },
    batchBtnDanger: {
      backgroundColor: c.error,
    },
    footerLoader: {
      paddingVertical: 12,
      alignItems: 'center' as const,
    },
    allLoadedText: {
      fontSize: 12,
      color: c.textMuted,
    },
    emptyContainer: {
      alignItems: 'center' as const,
      marginTop: 80,
    },
    emptyTitle: {
      fontSize: 16,
      fontWeight: '700' as const,
      color: c.textSecondary,
      marginTop: 12,
    },
    emptySubtitle: {
      fontSize: 13,
      color: c.textMuted,
      marginTop: 4,
      textAlign: 'center' as const,
    },
    adjustedBadge: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 2,
      backgroundColor: '#FFF3E0',
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: '#FFE0B2',
    },
    adjustedBadgeText: {
      color: '#E65100',
      fontSize: 9,
      fontWeight: '700' as const,
    },
    toast: {
      position: 'absolute' as const,
      bottom: 24,
      left: 16,
      right: 16,
      backgroundColor: '#333',
      borderRadius: 12,
      paddingHorizontal: 16,
      paddingVertical: 12,
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 8,
      elevation: 6,
    },
    toastText: {
      color: '#fff',
      fontSize: 13,
      fontWeight: '500' as const,
      flex: 1,
    },
  };
}
