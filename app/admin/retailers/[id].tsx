import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  Modal,
  FlatList,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../../src/services/supabase';
import { useAppTheme } from '../../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../../src/theme/useThemedStyles';
import type { AppColors } from '../../../src/theme/colors';
import { format } from 'date-fns';
import { AdminShopLocationsPanel } from '../../../src/components/delivery/AdminShopLocationsPanel';

type RetailerProfile = {
  id: string;
  name: string;
  phone: string;
  email: string;
  business_name: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
  area: string | null;
  approved: boolean;
  credit_limit: number;
  credit_used: number;
  loyalty_points: number;
};

type CreditAdjustment = {
  id: string;
  amount: number;
  reason: string | null;
  created_at: string;
};

type CreditOrder = {
  id: string;
  order_number: string;
  grand_total: number;
  created_at: string;
};

export default function RetailerDetail() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [retailer, setRetailer] = useState<RetailerProfile | null>(null);
  const [adjustments, setAdjustments] = useState<CreditAdjustment[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [adjustModalVisible, setAdjustModalVisible] = useState(false);
  const [adjustAmount, setAdjustAmount] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const [adjusting, setAdjusting] = useState(false);

  // CHANGED: FIX D — Area/Zone editing
  const [areaValue, setAreaValue] = useState('');
  const [savingArea, setSavingArea] = useState(false);

  const [paymentModalVisible, setPaymentModalVisible] = useState(false);
  const [creditOrders, setCreditOrders] = useState<CreditOrder[]>([]);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [markingPayment, setMarkingPayment] = useState<string | null>(null);

  const monthOptions = (() => {
    const opts: { key: string; label: string }[] = [];
    const now = new Date();
    for (let i = 0; i < 6; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const label = format(d, 'MMM yyyy');
      opts.push({ key, label });
    }
    return opts;
  })();
  const [selectedMonth, setSelectedMonth] = useState(monthOptions[0]?.key ?? '');

  const fetchRetailer = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, name, phone, email, business_name, address, city, state, pincode, area, approved, credit_limit, credit_used, loyalty_points')
        .eq('id', id)
        .single();

      if (error) throw error;
      const profile = data as RetailerProfile;
      setRetailer(profile);
      setAreaValue(profile.area || '');
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to load retailer');
    } finally {
      setLoading(false);
    }
  }, [id]);

  const fetchAdjustments = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('credit_adjustments')
        .select('id, amount, reason, created_at')
        .eq('retailer_id', id)
        .order('created_at', { ascending: false })
        .limit(10);

      if (!error && data) {
        setAdjustments(data as CreditAdjustment[]);
      }
    } catch {}
  }, [id]);

  useEffect(() => {
    fetchRetailer();
    fetchAdjustments();
  }, [id]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([fetchRetailer(), fetchAdjustments()]);
    setRefreshing(false);
  }, [fetchRetailer, fetchAdjustments]);

  const handleAdjust = async () => {
    const amt = parseFloat(adjustAmount);
    if (isNaN(amt) || amt === 0) {
      Alert.alert('Invalid Amount', 'Enter a non-zero amount');
      return;
    }

    setAdjusting(true);
    try {
      const { data, error } = await supabase.rpc('adjust_credit_limit', {
        p_retailer_id: id,
        p_amount: amt,
        p_reason: adjustReason.trim() || null,
      });

      if (error) throw error;

      Alert.alert('Success', `New credit limit: ₹${data}`);
      setAdjustModalVisible(false);
      setAdjustAmount('');
      setAdjustReason('');
      fetchRetailer();
      fetchAdjustments();
    } catch (err: any) {
      const msg = err.message || '';
      if (msg.includes('limit_below_used')) {
        Alert.alert('Cannot Reduce', 'New limit would be below current credit usage.');
      } else {
        Alert.alert('Error', msg);
      }
    } finally {
      setAdjusting(false);
    }
  };

  const openPaymentModal = async () => {
    setPaymentModalVisible(true);
    setLoadingOrders(true);
    try {
      const { data, error } = await supabase
        .from('orders')
        .select('id, order_number, grand_total, created_at')
        .eq('user_id', id)
        .eq('payment_mode', 'credit')
        .eq('status', 'delivered')
        .order('created_at', { ascending: false });

      if (!error && data) {
        setCreditOrders(data as CreditOrder[]);
      }
    } catch {} finally {
      setLoadingOrders(false);
    }
  };

  const markPaymentReceived = async (order: CreditOrder) => {
    Alert.alert(
      'Confirm Payment',
      `Mark payment received for #${order.order_number} (₹${order.grand_total.toFixed(2)})?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm',
          onPress: async () => {
            setMarkingPayment(order.id);
            try {
              const { error } = await supabase.rpc('reset_credit_used', {
                p_order_id: order.id,
              });
              if (error) throw error;

              Alert.alert('Success', 'Payment recorded');
              setCreditOrders((prev) => prev.filter((o) => o.id !== order.id));
              fetchRetailer();
            } catch (err: any) {
              Alert.alert('Error', err.message || 'Failed to record payment');
            } finally {
              setMarkingPayment(null);
            }
          },
        },
      ],
    );
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

  if (!retailer) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
        <Stack.Screen options={{ title: 'Not Found' }} />
        <View style={styles.center}>
          <Text style={{ color: colors.textMuted }}>Retailer not found</Text>
        </View>
      </SafeAreaView>
    );
  }

  const creditAvailable = retailer.credit_limit - retailer.credit_used;
  const creditPct = retailer.credit_limit > 0
    ? Math.min((retailer.credit_used / retailer.credit_limit) * 100, 100)
    : 0;
  const barColor = creditPct > 80 ? colors.error : creditPct > 60 ? colors.warning : colors.primary;

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <Stack.Screen options={{ title: retailer.name || retailer.business_name || 'Retailer' }} />

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {/* Profile Card */}
        <View style={styles.section}>
          <View style={styles.profileHeader}>
            <Ionicons name="person-circle" size={56} color={colors.primary} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={styles.profileName}>{retailer.name || 'Unnamed'}</Text>
              <Text style={styles.profileSub}>{retailer.business_name || '—'}</Text>
              <Text style={styles.profileSub}>{retailer.phone || retailer.email}</Text>
            </View>
            <View
              style={[
                styles.badge,
                { backgroundColor: retailer.approved ? colors.successMuted : colors.warningBg },
              ]}
            >
              <Text
                style={{
                  color: retailer.approved ? colors.success : colors.warning,
                  fontSize: 12,
                  fontWeight: '600',
                }}
              >
                {retailer.approved ? 'Approved' : 'Pending'}
              </Text>
            </View>
          </View>

          {retailer.address && (
            <View style={styles.addressRow}>
              <Ionicons name="location-outline" size={16} color={colors.textMuted} />
              <Text style={styles.addressText}>
                {[retailer.address, retailer.city, retailer.state, retailer.pincode]
                  .filter(Boolean)
                  .join(', ')}
              </Text>
            </View>
          )}

          {/* CHANGED: FIX D — Area / Zone field */}
          <View style={styles.areaRow}>
            <Ionicons name="map-outline" size={16} color={colors.primary} />
            <TextInput
              style={styles.areaInput}
              placeholder="Area / Zone (e.g. North City)"
              placeholderTextColor={colors.textMuted}
              value={areaValue}
              onChangeText={setAreaValue}
              onBlur={async () => {
                if (areaValue.trim() === (retailer.area || '').trim()) return;
                setSavingArea(true);
                try {
                  const { error } = await supabase
                    .from('profiles')
                    .update({ area: areaValue.trim() || null })
                    .eq('id', id);
                  if (error) throw error;
                } catch (err: any) {
                  Alert.alert('Error', err.message || 'Failed to save area');
                } finally {
                  setSavingArea(false);
                }
              }}
            />
            {savingArea && <ActivityIndicator size="small" color={colors.primary} />}
          </View>
        </View>

        <View style={styles.section}>
          <AdminShopLocationsPanel retailerId={id} />
        </View>

        {/* Credit Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Credit Account</Text>

          <View style={styles.creditStats}>
            <View style={styles.creditStat}>
              <Text style={styles.creditStatLabel}>Limit</Text>
              <Text style={styles.creditStatValue}>₹{retailer.credit_limit.toFixed(0)}</Text>
            </View>
            <View style={styles.creditStat}>
              <Text style={styles.creditStatLabel}>Used</Text>
              <Text style={[styles.creditStatValue, { color: colors.error }]}>
                ₹{retailer.credit_used.toFixed(0)}
              </Text>
            </View>
            <View style={styles.creditStat}>
              <Text style={styles.creditStatLabel}>Available</Text>
              <Text style={[styles.creditStatValue, { color: colors.success }]}>
                ₹{creditAvailable.toFixed(0)}
              </Text>
            </View>
          </View>

          <View style={styles.creditTrack}>
            <View
              style={[styles.creditFill, { width: `${creditPct}%` as any, backgroundColor: barColor }]}
            />
          </View>

          <View style={styles.actionRow}>
            <TouchableOpacity
              style={styles.actionBtn}
              onPress={() => setAdjustModalVisible(true)}
            >
              <Ionicons name="add-circle-outline" size={18} color={colors.onPrimary} />
              <Text style={styles.actionBtnText}>Adjust Limit</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.actionBtn, styles.actionBtnSuccess]}
              onPress={openPaymentModal}
            >
              <Ionicons name="checkmark-circle-outline" size={18} color={colors.onPrimary} />
              <Text style={styles.actionBtnText}>Mark Payment</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Loyalty Points */}
        <View style={styles.section}>
          <View style={styles.loyaltyRow}>
            <Ionicons name="star" size={22} color={colors.warning} />
            <Text style={styles.loyaltyText}>{retailer.loyalty_points} Loyalty Points</Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Monthly Statement</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
            {monthOptions.map((m) => (
              <TouchableOpacity
                key={m.key}
                style={[styles.monthChip, selectedMonth === m.key && styles.monthChipActive]}
                onPress={() => setSelectedMonth(m.key)}
              >
                <Text
                  style={[
                    styles.monthChipText,
                    selectedMonth === m.key && styles.monthChipTextActive,
                  ]}
                >
                  {m.label}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          <TouchableOpacity
            style={styles.statementBtn}
            onPress={() =>
              router.push({
                pathname: '/order/invoice',
                params: {
                  type: 'statement',
                  retailerId: id,
                  month: selectedMonth,
                },
              } as any)
            }
          >
            <Ionicons name="document-text-outline" size={18} color={colors.onPrimary} />
            <Text style={styles.statementBtnText}>View Statement</Text>
          </TouchableOpacity>
        </View>

        {/* Adjustment History */}
        {adjustments.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Credit Adjustment History</Text>
            {adjustments.map((adj) => (
              <View key={adj.id} style={styles.adjRow}>
                <View>
                  <Text style={styles.adjAmount}>
                    {adj.amount > 0 ? '+' : ''}₹{adj.amount.toFixed(0)}
                  </Text>
                  {adj.reason && <Text style={styles.adjReason}>{adj.reason}</Text>}
                </View>
                <Text style={styles.adjDate}>
                  {format(new Date(adj.created_at), 'dd MMM yyyy')}
                </Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      {/* Adjust Limit Modal */}
      <Modal visible={adjustModalVisible} transparent animationType="fade" onRequestClose={() => setAdjustModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Adjust Credit Limit</Text>
            <Text style={styles.modalSub}>
              Current limit: ₹{retailer.credit_limit.toFixed(0)} | Used: ₹{retailer.credit_used.toFixed(0)}
            </Text>

            <Text style={styles.fieldLabel}>Amount (+ to increase, - to decrease)</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="e.g. 5000 or -2000"
              placeholderTextColor={colors.textMuted}
              keyboardType="numeric"
              value={adjustAmount}
              onChangeText={setAdjustAmount}
            />

            <Text style={styles.fieldLabel}>Reason (optional)</Text>
            <TextInput
              style={[styles.modalInput, { minHeight: 60 }]}
              placeholder="Reason for adjustment..."
              placeholderTextColor={colors.textMuted}
              multiline
              value={adjustReason}
              onChangeText={setAdjustReason}
            />

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.modalCancel}
                onPress={() => {
                  setAdjustModalVisible(false);
                  setAdjustAmount('');
                  setAdjustReason('');
                }}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalSubmit, adjusting && { opacity: 0.6 }]}
                onPress={handleAdjust}
                disabled={adjusting}
              >
                {adjusting ? (
                  <ActivityIndicator size="small" color={colors.onPrimary} />
                ) : (
                  <Text style={styles.modalSubmitText}>Adjust</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Mark Payment Modal */}
      <Modal visible={paymentModalVisible} transparent animationType="fade" onRequestClose={() => setPaymentModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { maxHeight: '70%' }]}>
            <Text style={styles.modalTitle}>Outstanding Credit Orders</Text>
            <Text style={styles.modalSub}>Select an order to mark payment received</Text>

            {loadingOrders ? (
              <ActivityIndicator size="large" color={colors.primary} style={{ marginVertical: 20 }} />
            ) : creditOrders.length === 0 ? (
              <Text style={styles.emptyOrders}>No outstanding credit orders</Text>
            ) : (
              <FlatList
                data={creditOrders}
                keyExtractor={(item) => item.id}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={styles.orderRow}
                    onPress={() => markPaymentReceived(item)}
                    disabled={markingPayment === item.id}
                  >
                    <View>
                      <Text style={styles.orderNum}>#{item.order_number}</Text>
                      <Text style={styles.orderDate}>
                        {format(new Date(item.created_at), 'dd MMM yyyy')}
                      </Text>
                    </View>
                    {markingPayment === item.id ? (
                      <ActivityIndicator size="small" color={colors.primary} />
                    ) : (
                      <Text style={styles.orderTotal}>₹{item.grand_total.toFixed(2)}</Text>
                    )}
                  </TouchableOpacity>
                )}
                style={{ maxHeight: 300 }}
              />
            )}

            <TouchableOpacity
              style={styles.modalCloseBtn}
              onPress={() => setPaymentModalVisible(false)}
            >
              <Text style={styles.modalCloseText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function createStyles(c: AppColors, _isDark: boolean) {
  return {
    container: { flex: 1, backgroundColor: c.background },
    center: { flex: 1, justifyContent: 'center' as const, alignItems: 'center' as const },

    section: {
      backgroundColor: c.surface,
      borderRadius: 14,
      padding: 16,
      marginBottom: 12,
    },
    sectionTitle: {
      fontSize: 16,
      fontWeight: '700' as const,
      color: c.text,
      marginBottom: 12,
    },

    profileHeader: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
    },
    profileName: { fontSize: 18, fontWeight: '700' as const, color: c.text },
    profileSub: { fontSize: 13, color: c.textMuted, marginTop: 1 },
    badge: {
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 10,
    },

    addressRow: {
      flexDirection: 'row' as const,
      alignItems: 'flex-start' as const,
      gap: 6,
      marginTop: 12,
      paddingTop: 12,
      borderTopWidth: 1,
      borderTopColor: c.borderLight,
    },
    addressText: { fontSize: 13, color: c.textSecondary, flex: 1 },

    areaRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 8,
      marginTop: 12,
      paddingTop: 12,
      borderTopWidth: 1,
      borderTopColor: c.borderLight,
    },
    areaInput: {
      flex: 1,
      fontSize: 13,
      color: c.text,
      backgroundColor: c.inputBackground,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
    },

    creditStats: {
      flexDirection: 'row' as const,
      justifyContent: 'space-between' as const,
      marginBottom: 10,
    },
    creditStat: { alignItems: 'center' as const, flex: 1 },
    creditStatLabel: { fontSize: 12, color: c.textMuted },
    creditStatValue: { fontSize: 18, fontWeight: '700' as const, color: c.text, marginTop: 2 },

    creditTrack: {
      height: 8,
      backgroundColor: c.border,
      borderRadius: 4,
      overflow: 'hidden' as const,
      marginBottom: 14,
    },
    creditFill: { height: '100%' as const, borderRadius: 4 },

    actionRow: {
      flexDirection: 'row' as const,
      gap: 10,
    },
    actionBtn: {
      flex: 1,
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      gap: 6,
      backgroundColor: c.primary,
      paddingVertical: 12,
      borderRadius: 10,
    },
    actionBtnSuccess: {
      backgroundColor: c.success,
    },
    actionBtnText: { color: c.onPrimary, fontWeight: '600' as const, fontSize: 14 },

    loyaltyRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 8,
    },
    loyaltyText: { fontSize: 16, fontWeight: '700' as const, color: c.text },

    adjRow: {
      flexDirection: 'row' as const,
      justifyContent: 'space-between' as const,
      alignItems: 'center' as const,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    adjAmount: { fontSize: 15, fontWeight: '700' as const, color: c.text },
    adjReason: { fontSize: 12, color: c.textMuted, marginTop: 2 },
    adjDate: { fontSize: 12, color: c.textMuted },

    modalOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'center' as const,
      alignItems: 'center' as const,
      padding: 24,
    },
    modalContent: {
      backgroundColor: c.surface,
      borderRadius: 16,
      padding: 24,
      width: '100%' as const,
      maxWidth: 400,
    },
    modalTitle: { fontSize: 18, fontWeight: '700' as const, color: c.text, marginBottom: 4 },
    modalSub: { fontSize: 13, color: c.textMuted, marginBottom: 16 },
    fieldLabel: { fontSize: 13, fontWeight: '600' as const, color: c.textSecondary, marginBottom: 6 },
    modalInput: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 10,
      padding: 12,
      fontSize: 15,
      color: c.text,
      marginBottom: 12,
    },
    modalActions: { flexDirection: 'row' as const, gap: 10 },
    modalCancel: {
      flex: 1,
      paddingVertical: 12,
      borderRadius: 10,
      backgroundColor: c.background,
      alignItems: 'center' as const,
    },
    modalCancelText: { color: c.textSecondary, fontSize: 14, fontWeight: '600' as const },
    modalSubmit: {
      flex: 1,
      paddingVertical: 12,
      borderRadius: 10,
      backgroundColor: c.primary,
      alignItems: 'center' as const,
    },
    modalSubmitText: { color: c.onPrimary, fontSize: 14, fontWeight: '600' as const },

    emptyOrders: { fontSize: 14, color: c.textMuted, textAlign: 'center' as const, marginVertical: 20 },
    orderRow: {
      flexDirection: 'row' as const,
      justifyContent: 'space-between' as const,
      alignItems: 'center' as const,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: c.borderLight,
    },
    orderNum: { fontSize: 14, fontWeight: '600' as const, color: c.text },
    orderDate: { fontSize: 12, color: c.textMuted, marginTop: 2 },
    orderTotal: { fontSize: 16, fontWeight: '700' as const, color: c.primary },

    modalCloseBtn: {
      marginTop: 16,
      paddingVertical: 12,
      borderRadius: 10,
      backgroundColor: c.background,
      alignItems: 'center' as const,
    },
    modalCloseText: { color: c.textSecondary, fontSize: 14, fontWeight: '600' as const },
    monthChip: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 16,
      backgroundColor: c.inputBackground,
      marginRight: 8,
      borderWidth: 1,
      borderColor: c.border,
    },
    monthChipActive: { backgroundColor: c.primary, borderColor: c.primary },
    monthChipText: { fontSize: 13, color: c.textSecondary, fontWeight: '500' as const },
    monthChipTextActive: { color: c.onPrimary, fontWeight: '600' as const },
    statementBtn: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      gap: 8,
      backgroundColor: c.primary,
      paddingVertical: 12,
      borderRadius: 10,
    },
    statementBtnText: { color: c.onPrimary, fontWeight: '600' as const, fontSize: 14 },
  };
}
