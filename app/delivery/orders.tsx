import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Alert,
  ScrollView,
  Modal,
  TextInput,
  Animated,
  KeyboardAvoidingView,
  Platform,
  Switch,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { format } from 'date-fns';
import { supabase } from '../../src/services/supabase';
import { useAuthStore } from '../../src/store/authStore';
import { Order, OrderStatus } from '../../src/types';
import { withRetry } from '../../src/utils/retryable';
import { trackRpc } from '../../src/utils/performanceMonitor';
import { useTranslation } from 'react-i18next';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import { driverActionForStatus } from '../../src/constants/orderFlow';
import { useRealtimeOrders } from '../../src/hooks/useRealtimeOrders';
import { googleMapsDirUrl, resolveOrderCoords } from '../../src/utils/orderDeliveryCoords';

/* ================= CONSTANTS ================= */

const PAGE_SIZE = 20;

type StatusFilter = OrderStatus | 'all' | 'to_deliver' | 'pickup' | 'by_area';  // CHANGED: added by_area

const statusFilters: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'to_deliver', label: 'To Deliver' },
  { key: 'by_area', label: 'By Area' },           // CHANGED: FIX D — Area grouping tab
  { key: 'pickup', label: 'Pickup' },
  { key: 'assigned', label: 'Assigned' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'packed', label: 'Packed' },
  { key: 'dispatched', label: 'Dispatched' },
  { key: 'delivered', label: 'Delivered' },
];

type AreaSummary = {
  area: string;
  pending_count: number;
  approved_count: number;
  total_orders: number;
  retailer_names: string[];
};

const statusColor: Record<string, string> = {
  pending: '#FFA726',
  assigned: '#5C6BC0',
  accepted: '#00897B',
  picked_up: '#00897B',
  approved: '#42A5F5',
  packed: '#7E57C2',
  dispatched: '#26A69A',
  delivered: '#66BB6A',
  cancelled: '#EF5350',
};

type PageCursor = { created_at: string; id: string } | null;

async function callSendDeliveryOtp(orderId: string): Promise<{
  sent: boolean;
  channel?: string;
  reason?: string;
  error?: string;
}> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    return { sent: false, error: 'Not authenticated' };
  }

  const baseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const response = await fetch(`${baseUrl}/functions/v1/send-delivery-otp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ order_id: orderId }),
  });

  try {
    return await response.json();
  } catch {
    return { sent: false, error: 'Invalid response from server' };
  }
}

function parseOtpRpcError(message: string): string | null {
  if (message.includes('otp_invalid')) return 'otp_invalid';
  if (message.includes('otp_expired')) return 'otp_expired';
  if (message.includes('otp_max_attempts')) return 'otp_max_attempts';
  if (message.includes('otp_too_soon')) return 'otp_too_soon';
  return null;
}

/* ================= OTP MODAL ================= */

type DeliveryOtpModalProps = {
  visible: boolean;
  order: Order | null;
  isPickup: boolean;
  onClose: () => void;
  onSuccess: () => void;
  showToast: (msg: string) => void;
};

function DeliveryOtpModal({
  visible,
  order,
  isPickup,
  onClose,
  onSuccess,
  showToast,
}: DeliveryOtpModalProps) {
  const [digits, setDigits] = useState(['', '', '', '']);
  const [sendStatus, setSendStatus] = useState<string | null>(null);
  const [sendWarning, setSendWarning] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [locked, setLocked] = useState(false);
  const inputRefs = useRef<(TextInput | null)[]>([]);
  const lastSendOrderId = useRef<string | null>(null);

  const resetForm = useCallback(() => {
    setDigits(['', '', '', '']);
    setSendStatus(null);
    setSendWarning(null);
    setVerifyError(null);
    setLocked(false);
  }, []);

  const sendOtp = useCallback(async (isResend: boolean) => {
    if (!order) return;
    setSending(true);
    setVerifyError(null);
    try {
      const result = await callSendDeliveryOtp(order.id);
      if (result.reason === 'no_push_token') {
        setSendWarning(
          'Retailer has not enabled notifications. Show them the app or contact them directly.',
        );
        if (!isResend) {
          setSendStatus("OTP generated. Ask the retailer to open the app or check notifications.");
        }
      } else if (result.reason === 'otp_too_soon') {
        setVerifyError('OTP was just sent. Wait 2 minutes before resending.');
      } else if (result.sent) {
        setSendWarning(null);
        const via =
          result.channel === 'sms'
            ? 'SMS sent to retailer phone.'
            : "OTP sent to retailer's app. Ask them to check their phone.";
        setSendStatus(isResend ? `OTP resent. ${via}` : via);
      } else {
        setVerifyError(result.error || 'Could not send OTP. Try again or contact admin.');
      }
    } catch {
      setVerifyError('Could not send OTP. Check your connection.');
    } finally {
      setSending(false);
    }
  }, [order]);

  useEffect(() => {
    if (!visible || !order) {
      resetForm();
      lastSendOrderId.current = null;
      return;
    }
    if (lastSendOrderId.current === order.id) return;
    lastSendOrderId.current = order.id;
    resetForm();
    void sendOtp(false);
  }, [visible, order, resetForm, sendOtp]);

  const otpValue = digits.join('');

  const handleDigitChange = (index: number, value: string) => {
    if (locked) return;
    const d = value.replace(/\D/g, '').slice(-1);
    const next = [...digits];
    next[index] = d;
    setDigits(next);
    setVerifyError(null);
    if (d && index < 3) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyPress = (index: number, key: string) => {
    if (key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const fetchAttemptsRemaining = async (): Promise<number | null> => {
    if (!order) return null;
    const { data } = await supabase
      .from('delivery_proofs')
      .select('otp_attempts')
      .eq('order_id', order.id)
      .maybeSingle();
    if (!data) return null;
    return Math.max(0, 5 - (data.otp_attempts ?? 0));
  };

  const confirmDelivery = async () => {
    if (!order || locked || otpValue.length !== 4) return;
    setVerifying(true);
    setVerifyError(null);
    try {
      const { error } = await supabase.rpc('verify_delivery_otp', {
        p_order_id: order.id,
        p_otp: otpValue,
      });

      if (error) {
        const code = parseOtpRpcError(error.message || '');
        if (code === 'otp_invalid') {
          const remaining = await fetchAttemptsRemaining();
          if (remaining !== null && remaining <= 0) {
            setLocked(true);
            setVerifyError('Too many wrong attempts. Contact admin.');
          } else {
            setVerifyError(
              `Incorrect OTP. ${remaining ?? 4} attempts remaining.`,
            );
          }
        } else if (code === 'otp_expired') {
          setVerifyError('OTP has expired. Tap Resend to send a new one.');
        } else if (code === 'otp_max_attempts') {
          setLocked(true);
          setVerifyError('Too many wrong attempts. Contact admin.');
        } else {
          setVerifyError(error.message || 'Verification failed');
        }
        return;
      }

      onClose();
      onSuccess();
      showToast('Delivery confirmed');
    } catch (err: any) {
      setVerifyError(err?.message || 'Verification failed');
    } finally {
      setVerifying(false);
    }
  };

  if (!order) return null;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.modalOverlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.modalSheet}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Enter delivery OTP</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Ionicons name="close" size={24} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <Text style={styles.modalSubtext}>
            Ask the retailer for the code sent to their app
          </Text>

          {sendStatus ? <Text style={styles.sendStatusText}>{sendStatus}</Text> : null}
          {sendWarning ? <Text style={styles.sendWarningText}>{sendWarning}</Text> : null}
          {sending ? (
            <ActivityIndicator size="small" color={colors.primary} style={{ marginVertical: 8 }} />
          ) : null}

          <View style={styles.otpRow}>
            {digits.map((digit, i) => (
              <TextInput
                key={i}
                ref={(el) => { inputRefs.current[i] = el; }}
                style={[styles.otpBox, locked && styles.otpBoxDisabled]}
                value={digit}
                onChangeText={(v) => handleDigitChange(i, v)}
                onKeyPress={({ nativeEvent }) => handleKeyPress(i, nativeEvent.key)}
                keyboardType="number-pad"
                maxLength={1}
                editable={!locked && !verifying}
                selectTextOnFocus
              />
            ))}
          </View>

          {verifyError ? <Text style={styles.verifyErrorText}>{verifyError}</Text> : null}

          <TouchableOpacity
            style={[
              styles.confirmOtpBtn,
              (otpValue.length !== 4 || verifying || locked) && styles.confirmOtpBtnDisabled,
            ]}
            onPress={confirmDelivery}
            disabled={otpValue.length !== 4 || verifying || locked}
          >
            {verifying ? (
              <ActivityIndicator color={colors.onPrimary} size="small" />
            ) : (
              <Text style={styles.actionBtnText}>
                {isPickup ? 'Confirm collection' : 'Confirm delivery'}
              </Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.resendLink}
            onPress={() => sendOtp(true)}
            disabled={sending || locked}
          >
            <Text style={styles.resendLinkText}>Resend OTP</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/* ================= SCREEN ================= */

export default function DeliveryOrders() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const { user } = useAuthStore();
  const [orders, setOrders] = useState<Order[]>([]);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const nextCursor = useRef<PageCursor>(null);
  const [profileAddresses, setProfileAddresses] = useState<Record<string, string>>({});

  // CHANGED: FIX D — Area grouping state
  const [areaSummary, setAreaSummary] = useState<AreaSummary[]>([]);
  const [loadingAreas, setLoadingAreas] = useState(false);
  const [selectedArea, setSelectedArea] = useState<string | null>(null);

  const [otpModalOrder, setOtpModalOrder] = useState<Order | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastOpacity = useRef(new Animated.Value(0)).current;
  const [isOnDuty, setIsOnDuty] = useState(false);
  const [dutyLoading, setDutyLoading] = useState(true);
  const [dutyToggling, setDutyToggling] = useState(false);

  const loadDutyStatus = useCallback(async () => {
    try {
      const { data: authData } = await supabase.auth.getUser();
      const uid = authData.user?.id;
      if (!uid) return;

      const { data, error } = await supabase
        .from('profiles')
        .select('is_on_duty, current_order_count')
        .eq('id', uid)
        .single();

      if (error) throw error;
      setIsOnDuty(!!data?.is_on_duty);
    } catch (err: any) {
      console.error('Duty status load error:', err.message);
    } finally {
      setDutyLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDutyStatus();
  }, [loadDutyStatus]);

  const applyDutyChange = async (nextOnDuty: boolean) => {
    setDutyToggling(true);
    try {
      const { data: authData } = await supabase.auth.getUser();
      const uid = authData.user?.id;
      if (!uid) throw new Error('Not signed in');

      const { error } = await supabase
        .from('profiles')
        .update({ is_on_duty: nextOnDuty })
        .eq('id', uid);

      if (error) throw error;
      setIsOnDuty(nextOnDuty);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Could not update duty status');
    } finally {
      setDutyToggling(false);
    }
  };

  const toggleOnDuty = async (nextOnDuty: boolean) => {
    if (nextOnDuty) {
      await applyDutyChange(true);
      return;
    }

    try {
      const { data: authData } = await supabase.auth.getUser();
      const uid = authData.user?.id;
      if (!uid) return;

      const { data, error } = await supabase
        .from('profiles')
        .select('current_order_count')
        .eq('id', uid)
        .single();

      if (error) throw error;
      const active = data?.current_order_count ?? 0;

      if (active > 0) {
        Alert.alert(
          'Go off duty?',
          `You have ${active} active orders. Going off duty will not unassign them.`,
          [
            { text: 'Stay on duty', style: 'cancel' },
            { text: 'Go off duty', onPress: () => void applyDutyChange(false) },
          ],
        );
        return;
      }

      await applyDutyChange(false);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Could not check active orders');
    }
  };

  const showToast = useCallback((message: string) => {
    setToast(message);
    toastOpacity.setValue(0);
    Animated.sequence([
      Animated.timing(toastOpacity, { toValue: 1, duration: 300, useNativeDriver: true }),
      Animated.delay(2000),
      Animated.timing(toastOpacity, { toValue: 0, duration: 300, useNativeDriver: true }),
    ]).start(() => setToast(null));
  }, [toastOpacity]);

  const fetchOrders = useCallback(async (cursor: PageCursor = null, append = false) => {
    try {
      if (!append) setLoading(true);
      else setIsLoadingMore(true);

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);

      let p_status: string | null = null;
      let p_from_date: string | null = null;
      let p_to_date: string | null = null;

      if (filter === 'to_deliver') {
        p_from_date = todayStart.toISOString();
        p_to_date = todayEnd.toISOString();
      } else if (filter === 'pickup') {
        // CHANGED: FIX C — pickup filter handled client-side
      } else if (filter !== 'all') {
        p_status = filter;
      }

      const { data, error } = await withRetry(
        () => trackRpc('get_orders_page', () =>
          supabase.rpc('get_orders_page', {
            p_role: 'delivery',
            p_user_id: null as unknown as string,
            p_status,
            p_cursor: cursor?.created_at ?? null,
            p_cursor_id: cursor?.id ?? null,
            p_page_size: PAGE_SIZE,
            p_from_date,
            p_to_date,
            p_area: selectedArea,  // CHANGED: FIX D — area filter
          })
        ),
        { retries: 1, delayMs: 300 },
      );

      if (error) throw error;

      const rows = (data || []) as Order[];

      // Client-side filtering
      let filtered = rows;
      if (filter === 'to_deliver') {
        filtered = rows.filter((o) => o.status !== 'delivered' && o.status !== 'cancelled');
      } else if (filter === 'pickup') {
        // CHANGED: FIX C — filter to pickup orders only
        filtered = rows.filter(
          (o) => (o as any).fulfillment_mode === 'pickup' || o.delivery_type === 'pickup',
        );
      }

      if (append) {
        setOrders((prev) => [...prev, ...filtered]);
      } else {
        setOrders(filtered);

        const userIds = [...new Set(filtered.map((o) => o.user_id).filter(Boolean))];
        if (userIds.length > 0) {
          const { data: profiles } = await supabase
            .from('profiles')
            .select('id, address, city, state, pincode')
            .in('id', userIds);

          const addrMap: Record<string, string> = {};
          (profiles || []).forEach((p: any) => {
            const fullAddr = [p.address, p.city, p.state, p.pincode].filter(Boolean).join(', ');
            if (fullAddr.trim()) addrMap[p.id] = fullAddr;
          });
          setProfileAddresses(addrMap);
        }
      }

      if (rows.length < PAGE_SIZE) {
        setHasMore(false);
        nextCursor.current = null;
      } else {
        const last = rows[rows.length - 1];
        nextCursor.current = { created_at: last.created_at, id: last.id };
        setHasMore(true);
      }
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to fetch orders');
    } finally {
      setLoading(false);
      setIsLoadingMore(false);
    }
  }, [filter, selectedArea]);

  const uid = user?.id;
  useRealtimeOrders({
    table: 'orders',
    event: 'UPDATE',
    filter: uid ? `assigned_to=eq.${uid}` : undefined,
    enabled: !!uid,
    onUpdate: () => {
      nextCursor.current = null;
      setHasMore(true);
      void fetchOrders(null, false);
    },
  });

  // CHANGED: FIX D — Fetch area summary
  const fetchAreaSummary = useCallback(async () => {
    setLoadingAreas(true);
    try {
      const { data, error } = await supabase.rpc('get_delivery_summary', {});
      if (error) throw error;
      setAreaSummary((data || []) as AreaSummary[]);
    } catch (err: any) {
      console.error('Area summary error:', err.message);
    } finally {
      setLoadingAreas(false);
    }
  }, []);

  useEffect(() => {
    nextCursor.current = null;
    setHasMore(true);
    if (filter === 'by_area' && !selectedArea) {
      fetchAreaSummary();
    } else {
      fetchOrders(null, false);
    }
  }, [filter, selectedArea]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    nextCursor.current = null;
    setHasMore(true);
    await Promise.all([fetchOrders(null, false), loadDutyStatus()]);
    setRefreshing(false);
  }, [fetchOrders, loadDutyStatus]);

  const onEndReached = useCallback(() => {
    if (!hasMore || isLoadingMore || loading) return;
    fetchOrders(nextCursor.current, true);
  }, [hasMore, isLoadingMore, loading, fetchOrders]);

  const updateStatus = async (order: Order, newStatus: OrderStatus) => {
    const label = newStatus.charAt(0).toUpperCase() + newStatus.slice(1);

    Alert.alert('Update Delivery Status', `Mark #${order.order_number} as ${label}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Confirm',
        onPress: async () => {
          const { error } = await supabase
            .from('orders')
            .update({ status: newStatus })
            .eq('id', order.id);

          if (error) {
            if (error.message?.includes('invalid_transition') || error.code === 'P0001') {
              Alert.alert('Invalid Transition', 'This status change is not allowed. The order may have been updated by someone else.');
            } else {
              Alert.alert('Error', error.message);
            }
            return;
          }

          nextCursor.current = null;
          setHasMore(true);
          fetchOrders(null, false);
        },
      },
    ]);
  };

  const renderActions = (item: Order) => {
    const isPickup =
      (item as any).fulfillment_mode === 'pickup' || item.delivery_type === 'pickup';
    const action = driverActionForStatus(item.status, item.fulfillment_mode);

    const navigate = async () => {
      const coords = await resolveOrderCoords(supabase, item);
      if (!coords) {
        Alert.alert('No GPS', 'No coordinates on this order.');
        return;
      }
      Linking.openURL(googleMapsDirUrl(coords.lat, coords.lng)).catch(() =>
        Alert.alert('Error', 'Could not open maps'),
      );
    };

    return (
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        {action === 'accept' && (
          <>
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: colors.success, flex: 1 }]}
              onPress={async () => {
                const { error } = await supabase.rpc('delivery_accept_order', {
                  p_order_id: item.id,
                });
                if (error) {
                  Alert.alert('Error', error.message);
                  return;
                }
                fetchOrders(null, false);
              }}
            >
              <Text style={styles.actionBtnText}>Accept</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: colors.error, flex: 1 }]}
              onPress={() => {
                Alert.alert('Decline?', `Order #${item.order_number}`, [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Decline',
                    style: 'destructive',
                    onPress: async () => {
                      const { error } = await supabase.rpc('delivery_reject_order', {
                        p_order_id: item.id,
                        p_reason: null,
                      });
                      if (!error) fetchOrders(null, false);
                    },
                  },
                ]);
              }}
            >
              <Text style={styles.actionBtnText}>Decline</Text>
            </TouchableOpacity>
          </>
        )}

        {action === 'mark_picked_up' && (
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: colors.primary, flex: 1 }]}
            onPress={() => updateStatus(item, 'picked_up')}
          >
            <Text style={styles.actionBtnText}>Mark picked up</Text>
          </TouchableOpacity>
        )}

        {action === 'mark_dispatched' && (
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: colors.success, flex: 1 }]}
            onPress={() => updateStatus(item, 'dispatched')}
          >
            <Text style={styles.actionBtnText}>
              {isPickup ? 'Ready for Pickup' : 'Mark dispatched'}
            </Text>
          </TouchableOpacity>
        )}

        {action === 'mark_delivered' && (
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: colors.success, flex: 1 }]}
            onPress={() => setOtpModalOrder(item)}
          >
            <Text style={styles.actionBtnText}>
              {isPickup ? 'Mark collected' : 'Mark delivered'}
            </Text>
          </TouchableOpacity>
        )}

        {(item.status === 'picked_up' || item.status === 'dispatched') && !isPickup && (
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: colors.primary, flex: 1 }]}
            onPress={() => void navigate()}
          >
            <Text style={styles.actionBtnText}>Navigate</Text>
          </TouchableOpacity>
        )}
      </View>
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
    <SafeAreaView style={styles.container}>
      <Stack.Screen options={{ title: t('delivery.title') }} />

      <View style={styles.dutyCard}>
        <View style={styles.dutyTextCol}>
          <Text style={styles.dutyTitle}>
            {isOnDuty ? 'You are ON duty' : 'You are OFF duty'}
          </Text>
          <Text style={styles.dutySubtext}>
            {isOnDuty
              ? 'Admins can assign new orders to you'
              : 'Turn on when you are available for deliveries'}
          </Text>
        </View>
        {dutyLoading ? (
          <ActivityIndicator size="small" color={colors.primary} />
        ) : (
          <Switch
            value={isOnDuty}
            onValueChange={(v) => void toggleOnDuty(v)}
            disabled={dutyToggling}
            trackColor={{ false: colors.switchTrackOff, true: colors.primaryMuted }}
            thumbColor={isOnDuty ? colors.switchThumbOn : colors.switchThumbOff}
          />
        )}
      </View>

      <View style={styles.filterRow}>
        {statusFilters.map((f) => (
          <TouchableOpacity
            key={f.key}
            onPress={() => { setFilter(f.key); setSelectedArea(null); }}
            style={[styles.filterPill, filter === f.key && styles.filterPillActive]}
          >
            <Text style={[styles.filterText, filter === f.key && styles.filterTextActive]}>
              {f.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* CHANGED: FIX D — Show area header when filtering by area */}
      {filter === 'by_area' && selectedArea && (
        <TouchableOpacity
          style={styles.areaBackRow}
          onPress={() => setSelectedArea(null)}
        >
          <Ionicons name="arrow-back" size={18} color={colors.primary} />
          <Text style={styles.areaBackText}>Back to areas</Text>
          <View style={styles.areaFilterBadge}>
            <Ionicons name="location" size={12} color={colors.onPrimary} />
            <Text style={styles.areaFilterBadgeText}>{selectedArea}</Text>
          </View>
        </TouchableOpacity>
      )}

      {/* CHANGED: FIX D — Area view when By Area is selected and no area chosen */}
      {filter === 'by_area' && !selectedArea ? (
        loadingAreas ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={colors.primary} />
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchAreaSummary().then(() => setRefreshing(false)); }} />}
          >
            {areaSummary.length === 0 ? (
              <View style={styles.emptyWrap}>
                <Ionicons name="map-outline" size={52} color={colors.switchThumbOff} />
                <Text style={styles.emptyText}>No delivery orders for today</Text>
              </View>
            ) : (
              areaSummary.map((area) => (
                <TouchableOpacity
                  key={area.area}
                  style={styles.areaCard}
                  onPress={() => setSelectedArea(area.area)}
                >
                  <View style={styles.areaHeader}>
                    <Ionicons name="location" size={18} color={colors.primary} />
                    <Text style={styles.areaName}>{area.area}</Text>
                    <View style={styles.areaCountBadge}>
                      <Text style={styles.areaCountText}>{area.total_orders}</Text>
                    </View>
                  </View>
                  <View style={styles.areaStats}>
                    <Text style={styles.areaStat}>
                      Pending: <Text style={{ fontWeight: '700', color: colors.warning }}>{area.pending_count}</Text>
                    </Text>
                    <Text style={styles.areaStat}>
                      Ready: <Text style={{ fontWeight: '700', color: colors.success }}>{area.approved_count}</Text>
                    </Text>
                  </View>
                  <View style={styles.areaChips}>
                    {area.retailer_names.slice(0, 4).map((name, i) => (
                      <View key={i} style={styles.retailerChip}>
                        <Text style={styles.retailerChipText} numberOfLines={1}>{name}</Text>
                      </View>
                    ))}
                    {area.retailer_names.length > 4 && (
                      <View style={styles.retailerChip}>
                        <Text style={styles.retailerChipText}>+{area.retailer_names.length - 4}</Text>
                      </View>
                    )}
                  </View>
                </TouchableOpacity>
              ))
            )}
          </ScrollView>
        )
      ) : loading && !refreshing ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <FlatList
          data={orders}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          onEndReached={onEndReached}
          onEndReachedThreshold={0.3}
          ListFooterComponent={renderFooter}
          renderItem={({ item }) => {
            const isPickup = (item as any).fulfillment_mode === 'pickup' || item.delivery_type === 'pickup';

            return (
              <TouchableOpacity
                style={styles.card}
                activeOpacity={0.8}
                onPress={() => router.push(`/order/${item.id}`)}
              >
                <View style={styles.cardHeader}>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <Text style={styles.orderNo}>#{item.order_number}</Text>
                      <View style={styles.assignedToYouBadge}>
                        <Ionicons name="person" size={10} color={colors.onPrimary} />
                        <Text style={styles.assignedToYouText}>Assigned to you</Text>
                      </View>
                      {/* CHANGED: FIX C — PICKUP badge */}
                      {isPickup && (
                        <View style={styles.pickupBadge}>
                          <Ionicons name="storefront" size={10} color={colors.onPrimary} />
                          <Text style={styles.pickupBadgeText}>PICKUP</Text>
                        </View>
                      )}
                    </View>
                    <Text style={styles.dateText}>
                      {format(new Date(item.created_at), 'dd MMM yyyy, hh:mm a')}
                    </Text>
                  </View>
                  <View style={[styles.badge, { backgroundColor: statusColor[item.status] || colors.textMuted }]}>
                    <Text style={styles.badgeText}>{item.status}</Text>
                  </View>
                </View>

                <Text style={styles.metaText}>{item.user_name || 'Unknown Retailer'} · {item.user_phone || '—'}</Text>
                {!isPickup && (profileAddresses[item.user_id] || item.delivery_address) ? (
                  <Text style={styles.addressText} numberOfLines={2}>
                    {profileAddresses[item.user_id] || item.delivery_address}
                  </Text>
                ) : null}
                <Text style={styles.totalText}>₹{(item.grand_total || 0).toFixed(2)}</Text>

                {renderActions(item)}
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Ionicons name="receipt-outline" size={52} color={colors.switchThumbOff} />
              <Text style={styles.emptyText}>No orders found</Text>
            </View>
          }
        />
      )}
      <DeliveryOtpModal
        visible={!!otpModalOrder}
        order={otpModalOrder}
        isPickup={
          !!otpModalOrder &&
          ((otpModalOrder as any).fulfillment_mode === 'pickup' ||
            otpModalOrder.delivery_type === 'pickup')
        }
        onClose={() => setOtpModalOrder(null)}
        onSuccess={() => {
          setOtpModalOrder(null);
          nextCursor.current = null;
          setHasMore(true);
          fetchOrders(null, false);
        }}
        showToast={showToast}
      />
      {toast ? (
        <Animated.View style={[styles.toast, { opacity: toastOpacity }]}>
          <Ionicons name="checkmark-circle" size={18} color={colors.onPrimary} />
          <Text style={styles.toastText}>{toast}</Text>
        </Animated.View>
      ) : null}
    </SafeAreaView>
  );
}

/* ================= STYLES ================= */

function createStyles(c: AppColors, isDark: boolean) {
  return {
  container: { flex: 1, backgroundColor: c.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  dutyCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 4,
    padding: 14,
    backgroundColor: c.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.cardBorder,
  },
  dutyTextCol: { flex: 1, marginRight: 12 },
  dutyTitle: { fontSize: 15, fontWeight: '700', color: c.text },
  dutySubtext: { fontSize: 12, color: c.textSecondary, marginTop: 4, lineHeight: 16 },
  filterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  filterPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.switchTrackOff,
  },
  filterPillActive: {
    backgroundColor: c.primary,
    borderColor: c.primary,
  },
  filterText: { color: c.textSecondary, fontSize: 13 },
  filterTextActive: { color: c.onPrimary, fontWeight: '600' },
  card: {
    backgroundColor: c.surface,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  orderNo: { fontSize: 15, fontWeight: '700', color: c.text },
  dateText: { fontSize: 12, color: c.textSecondary, marginTop: 2 },
  badge: {
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  badgeText: { color: c.onPrimary, fontSize: 12, fontWeight: '600', textTransform: 'capitalize' },
  metaText: { marginTop: 10, color: c.textSecondary, fontSize: 13 },
  addressText: { marginTop: 4, color: c.textMuted, fontSize: 12 },
  totalText: { marginTop: 6, color: c.text, fontWeight: '700', fontSize: 15 },
  actionBtn: {
    marginTop: 12,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  actionBtnText: { color: c.surface, fontWeight: '700' },
  footerLoader: { paddingVertical: 16, alignItems: 'center' },
  allLoadedText: { fontSize: 13, color: c.textMuted },
  emptyWrap: { alignItems: 'center', marginTop: 100 },
  emptyText: { marginTop: 10, color: c.textMuted },

  /* CHANGED: FIX C — Pickup badge */
  pickupBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: c.primary,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  pickupBadgeText: {
    color: c.surface,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  assignedToYouBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: c.primary,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  assignedToYouText: {
    color: c.surface,
    fontSize: 9,
    fontWeight: '700',
  },

  /* CHANGED: FIX D — Area grouping styles */
  areaCard: {
    backgroundColor: c.surface,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  areaHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  areaName: {
    fontSize: 16,
    fontWeight: '700',
    color: c.text,
    flex: 1,
  },
  areaCountBadge: {
    backgroundColor: c.primary,
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  areaCountText: {
    color: c.surface,
    fontSize: 13,
    fontWeight: '700',
  },
  areaStats: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 8,
    marginLeft: 26,
  },
  areaStat: {
    fontSize: 13,
    color: c.textSecondary,
  },
  areaChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 10,
    marginLeft: 26,
  },
  retailerChip: {
    backgroundColor: c.primaryMuted,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },
  retailerChipText: {
    fontSize: 11,
    color: c.primary,
    fontWeight: '500',
    maxWidth: 100,
  },
  areaBackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: c.surface,
    borderBottomWidth: 1,
    borderBottomColor: c.borderLight,
  },
  areaBackText: {
    fontSize: 13,
    color: c.primary,
    fontWeight: '500',
    flex: 1,
  },
  areaFilterBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: c.primary,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
  },
  areaFilterBadgeText: {
    color: c.surface,
    fontSize: 11,
    fontWeight: '600',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: c.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 20,
    paddingBottom: 32,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  modalTitle: { fontSize: 18, fontWeight: '700', color: c.text },
  modalSubtext: { fontSize: 14, color: c.textSecondary, marginBottom: 12 },
  sendStatusText: { fontSize: 13, color: c.success, marginBottom: 8 },
  sendWarningText: { fontSize: 13, color: c.warning, marginBottom: 8, lineHeight: 18 },
  otpRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 10,
    marginVertical: 16,
  },
  otpBox: {
    width: 52,
    height: 56,
    borderWidth: 2,
    borderColor: c.primary,
    borderRadius: 10,
    textAlign: 'center',
    fontSize: 22,
    fontWeight: '700',
    color: c.text,
  },
  otpBoxDisabled: {
    borderColor: c.switchThumbOff,
    backgroundColor: c.background,
    color: c.textMuted,
  },
  verifyErrorText: { fontSize: 13, color: c.error, textAlign: 'center', marginBottom: 8 },
  confirmOtpBtn: {
    backgroundColor: c.success,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  confirmOtpBtnDisabled: { opacity: 0.5 },
  resendLink: { alignItems: 'center', marginTop: 16, paddingVertical: 8 },
  resendLinkText: { color: c.primary, fontSize: 14, fontWeight: '600' },
  toast: {
    position: 'absolute',
    bottom: 32,
    left: 24,
    right: 24,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: c.success,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 10,
    elevation: 4,
  },
  toastText: { color: c.surface, fontWeight: '600', fontSize: 14, flex: 1 },
};
}
