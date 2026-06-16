import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
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
      <SafeAreaView style={styles.container}>
        <Stack.Screen options={{ title: 'Loading...' }} />
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#4C51C9" />
        </View>
      </SafeAreaView>
    );
  }

  if (!retailer) {
    return (
      <SafeAreaView style={styles.container}>
        <Stack.Screen options={{ title: 'Not Found' }} />
        <View style={styles.center}>
          <Text style={{ color: '#888' }}>Retailer not found</Text>
        </View>
      </SafeAreaView>
    );
  }

  const creditAvailable = retailer.credit_limit - retailer.credit_used;
  const creditPct = retailer.credit_limit > 0
    ? Math.min((retailer.credit_used / retailer.credit_limit) * 100, 100)
    : 0;
  const barColor = creditPct > 80 ? '#EF5350' : creditPct > 60 ? '#FFA726' : '#4C51C9';

  return (
    <SafeAreaView style={styles.container}>
      <Stack.Screen options={{ title: retailer.name || retailer.business_name || 'Retailer' }} />

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {/* Profile Card */}
        <View style={styles.section}>
          <View style={styles.profileHeader}>
            <Ionicons name="person-circle" size={56} color="#4C51C9" />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={styles.profileName}>{retailer.name || 'Unnamed'}</Text>
              <Text style={styles.profileSub}>{retailer.business_name || '—'}</Text>
              <Text style={styles.profileSub}>{retailer.phone || retailer.email}</Text>
            </View>
            <View
              style={[
                styles.badge,
                { backgroundColor: retailer.approved ? '#E8F5E9' : '#FFF3E0' },
              ]}
            >
              <Text
                style={{
                  color: retailer.approved ? '#43A047' : '#FFA726',
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
              <Ionicons name="location-outline" size={16} color="#888" />
              <Text style={styles.addressText}>
                {[retailer.address, retailer.city, retailer.state, retailer.pincode]
                  .filter(Boolean)
                  .join(', ')}
              </Text>
            </View>
          )}

          {/* CHANGED: FIX D — Area / Zone field */}
          <View style={styles.areaRow}>
            <Ionicons name="map-outline" size={16} color="#4C51C9" />
            <TextInput
              style={styles.areaInput}
              placeholder="Area / Zone (e.g. North City)"
              placeholderTextColor="#999"
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
            {savingArea && <ActivityIndicator size="small" color="#4C51C9" />}
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
              <Text style={[styles.creditStatValue, { color: '#EF5350' }]}>
                ₹{retailer.credit_used.toFixed(0)}
              </Text>
            </View>
            <View style={styles.creditStat}>
              <Text style={styles.creditStatLabel}>Available</Text>
              <Text style={[styles.creditStatValue, { color: '#43A047' }]}>
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
              <Ionicons name="add-circle-outline" size={18} color="#fff" />
              <Text style={styles.actionBtnText}>Adjust Limit</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: '#43A047' }]}
              onPress={openPaymentModal}
            >
              <Ionicons name="checkmark-circle-outline" size={18} color="#fff" />
              <Text style={styles.actionBtnText}>Mark Payment</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Loyalty Points */}
        <View style={styles.section}>
          <View style={styles.loyaltyRow}>
            <Ionicons name="star" size={22} color="#FFA726" />
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
            <Ionicons name="document-text-outline" size={18} color="#fff" />
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
              placeholderTextColor="#999"
              keyboardType="numeric"
              value={adjustAmount}
              onChangeText={setAdjustAmount}
            />

            <Text style={styles.fieldLabel}>Reason (optional)</Text>
            <TextInput
              style={[styles.modalInput, { minHeight: 60 }]}
              placeholder="Reason for adjustment..."
              placeholderTextColor="#999"
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
                  <ActivityIndicator size="small" color="#fff" />
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
              <ActivityIndicator size="large" color="#4C51C9" style={{ marginVertical: 20 }} />
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
                      <ActivityIndicator size="small" color="#4C51C9" />
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  section: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#333',
    marginBottom: 12,
  },

  profileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  profileName: { fontSize: 18, fontWeight: '700', color: '#333' },
  profileSub: { fontSize: 13, color: '#888', marginTop: 1 },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
  },

  addressRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
  },
  addressText: { fontSize: 13, color: '#666', flex: 1 },

  areaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
  },
  areaInput: {
    flex: 1,
    fontSize: 13,
    color: '#333',
    backgroundColor: '#f8f8f8',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },

  creditStats: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  creditStat: { alignItems: 'center', flex: 1 },
  creditStatLabel: { fontSize: 12, color: '#888' },
  creditStatValue: { fontSize: 18, fontWeight: '700', color: '#333', marginTop: 2 },

  creditTrack: {
    height: 8,
    backgroundColor: '#E8E8E8',
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 14,
  },
  creditFill: { height: '100%', borderRadius: 4 },

  actionRow: {
    flexDirection: 'row',
    gap: 10,
  },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#4C51C9',
    paddingVertical: 12,
    borderRadius: 10,
  },
  actionBtnText: { color: '#fff', fontWeight: '600', fontSize: 14 },

  loyaltyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  loyaltyText: { fontSize: 16, fontWeight: '700', color: '#333' },

  adjRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f5f5f5',
  },
  adjAmount: { fontSize: 15, fontWeight: '700', color: '#333' },
  adjReason: { fontSize: 12, color: '#888', marginTop: 2 },
  adjDate: { fontSize: 12, color: '#aaa' },

  /* Modals */
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
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#333', marginBottom: 4 },
  modalSub: { fontSize: 13, color: '#888', marginBottom: 16 },
  fieldLabel: { fontSize: 13, fontWeight: '600', color: '#555', marginBottom: 6 },
  modalInput: {
    borderWidth: 1,
    borderColor: '#e0e0e0',
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    color: '#333',
    marginBottom: 12,
  },
  modalActions: { flexDirection: 'row', gap: 10 },
  modalCancel: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#f5f5f5',
    alignItems: 'center',
  },
  modalCancelText: { color: '#666', fontSize: 14, fontWeight: '600' },
  modalSubmit: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#4C51C9',
    alignItems: 'center',
  },
  modalSubmitText: { color: '#fff', fontSize: 14, fontWeight: '600' },

  emptyOrders: { fontSize: 14, color: '#999', textAlign: 'center', marginVertical: 20 },
  orderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  orderNum: { fontSize: 14, fontWeight: '600', color: '#333' },
  orderDate: { fontSize: 12, color: '#aaa', marginTop: 2 },
  orderTotal: { fontSize: 16, fontWeight: '700', color: '#4C51C9' },

  modalCloseBtn: {
    marginTop: 16,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#f5f5f5',
    alignItems: 'center',
  },
  modalCloseText: { color: '#666', fontSize: 14, fontWeight: '600' },
  monthChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: '#f5f5f5',
    marginRight: 8,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  monthChipActive: { backgroundColor: '#4C51C9', borderColor: '#4C51C9' },
  monthChipText: { fontSize: 13, color: '#666', fontWeight: '500' },
  monthChipTextActive: { color: '#fff', fontWeight: '600' },
  statementBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#4C51C9',
    paddingVertical: 12,
    borderRadius: 10,
  },
  statementBtnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
});
