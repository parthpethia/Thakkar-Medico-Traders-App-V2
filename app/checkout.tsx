// PA: CRIT-5 — Synchronous double-tap guard on Place Order
import React, { useEffect, useMemo, useState, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
  Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { v4 as uuidv4 } from 'uuid';
import Slider from '@react-native-community/slider';

import { useCartStore } from '../src/store/cartStore';
import { useAuthStore } from '../src/store/authStore';
import { invalidateHomeCache } from '../src/store/homeStore';
import { useSettingsStore, selectMinOrderValue } from '../src/store/settingsStore';
import { supabase } from '../src/services/supabase';
import { computeOrderTotals } from '../src/utils/orderTotals';
import { withRetry } from '../src/utils/retryable';
import { trackRpc } from '../src/utils/performanceMonitor';
import { useTranslation } from 'react-i18next';
import { DeliverToCard } from '../src/components/delivery/DeliverToCard';
import { DeliveryAddressFlow } from '../src/components/delivery/DeliveryAddressFlow';
import {
  fetchShopLocations,
  toOrderDeliveryPayload,
} from '../src/services/shopLocationService';
import type { RetailerShopLocation } from '../src/types/shopLocation';
import { formatDeliveryWindow } from '../src/constants/shopLocation';
import { useAppTheme } from '../src/hooks/useAppTheme';
import { useThemedStyles } from '../src/theme/useThemedStyles';
import type { AppColors } from '../src/theme/colors';

type PaymentMode = 'cod' | 'credit' | 'upi';
type FulfillmentMode = 'delivery' | 'pickup';

const PAYMENT_MODE_LABELS: Record<PaymentMode, { label: string; icon: keyof typeof Ionicons.glyphMap }> = {
  cod:    { label: 'Cash on Delivery', icon: 'cash-outline' },
  credit: { label: 'Credit', icon: 'wallet-outline' },
  upi:    { label: 'UPI', icon: 'phone-portrait-outline' },
};

export default function Checkout() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const router = useRouter();
  const { t } = useTranslation();
  const { items, clearCart, loading } = useCartStore();
  const { user } = useAuthStore();
  const settings = useSettingsStore((s) => s.settings);
  const minOrderValue = useSettingsStore(selectMinOrderValue);

  const [notes, setNotes] = useState('');
  const [selectedShop, setSelectedShop] = useState<RetailerShopLocation | null>(null);
  const [addressFlowOpen, setAddressFlowOpen] = useState(false);
  const [addressFlowStage, setAddressFlowStage] = useState<'select' | 'address_book'>('select');
  const [deliveryAddressError, setDeliveryAddressError] = useState('');
  const [placingOrder, setPlacingOrder] = useState(false);
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('cod');
  const [enabledModes, setEnabledModes] = useState<PaymentMode[]>(['cod']);

  // CHANGED: FIX C — Fulfillment mode
  const [fulfillmentMode, setFulfillmentMode] = useState<FulfillmentMode>('delivery');
  const [pickupEnabled, setPickupEnabled] = useState(false);
  const [pickupAddress, setPickupAddress] = useState('');
  const [pickupHours, setPickupHours] = useState('');

  // CHANGED: FIX B — Loyalty redemption
  const [redeemToggle, setRedeemToggle] = useState(false);
  const [redeemPoints, setRedeemPoints] = useState(0);
  const [loyaltyBalance, setLoyaltyBalance] = useState(0);
  const [redemptionRate, setRedemptionRate] = useState(0.5);
  const [maxRedemptionPct, setMaxRedemptionPct] = useState(20);

  const [idempotencyKey] = useState(() => uuidv4());
  const submittingRef = useRef(false);

  const gstEnabled = settings?.features?.gst_enabled ?? true;

  useEffect(() => {
    (async () => {
      try {
        const { data } = await supabase
          .from('settings')
          .select('payment_modes_enabled, pickup_enabled, pickup_address, pickup_hours, loyalty_redemption_rate, max_redemption_percent')
          .limit(1)
          .single();

        if (data?.payment_modes_enabled && Array.isArray(data.payment_modes_enabled)) {
          setEnabledModes(data.payment_modes_enabled as PaymentMode[]);
        }
        // CHANGED: FIX C — pickup settings
        if (data?.pickup_enabled) {
          setPickupEnabled(true);
          setPickupAddress(data.pickup_address || '');
          setPickupHours(data.pickup_hours || '');
        }
        // CHANGED: FIX B — loyalty settings
        if (data?.loyalty_redemption_rate != null) {
          setRedemptionRate(data.loyalty_redemption_rate);
        }
        if (data?.max_redemption_percent != null) {
          setMaxRedemptionPct(data.max_redemption_percent);
        }
      } catch {}
    })();
  }, []);

  // CHANGED: FIX B — Fetch current loyalty balance
  useEffect(() => {
    if (user) {
      setLoyaltyBalance(user.loyalty_points ?? 0);
    }
  }, [user]);

  useEffect(() => {
    if (!user?.id) return;
    (async () => {
      try {
        const list = await fetchShopLocations(user.id);
        const def = list.find((l) => l.is_default) || list[0];
        if (def) setSelectedShop(def);
        if (list.length === 0 && fulfillmentMode === 'delivery') {
          setAddressFlowOpen(true);
          setAddressFlowStage('select');
        }
      } catch {
        /* table may not exist until migration v25 is applied */
      }
    })();
  }, [user?.id]);

  /* ================= TOTALS ================= */

  const { subtotal, gst, grandTotal: rawGrandTotal } = useMemo(
    () => computeOrderTotals(items.map((i) => ({
      selling_price: i.selling_price,
      quantity: i.quantity,
      gst_percent: i.gst_percent,
    })), gstEnabled),
    [items, gstEnabled],
  );

  // CHANGED: FIX B — Compute max redeemable points & discount
  const maxRedeemablePoints = useMemo(() => {
    if (loyaltyBalance <= 0 || redemptionRate <= 0) return 0;
    const maxDiscount = rawGrandTotal * maxRedemptionPct / 100;
    const maxPointsByDiscount = Math.floor(maxDiscount / redemptionRate);
    return Math.min(loyaltyBalance, maxPointsByDiscount);
  }, [loyaltyBalance, rawGrandTotal, redemptionRate, maxRedemptionPct]);

  const loyaltyDiscount = useMemo(() => {
    if (!redeemToggle || redeemPoints <= 0) return 0;
    return Math.round(redeemPoints * redemptionRate * 100) / 100;
  }, [redeemToggle, redeemPoints, redemptionRate]);

  const grandTotal = rawGrandTotal - loyaltyDiscount;

  /* ================= ACTION ================= */

  const placeOrder = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;

    if (!items.length) {
      Alert.alert('Cart empty', 'Add items before checkout');
      submittingRef.current = false;
      return;
    }

    if (!user) {
      Alert.alert('Not logged in', 'Please log in to place an order');
      submittingRef.current = false;
      return;
    }

    if (!user.approved) {
      Alert.alert('Account Pending Approval', 'Your account has not been approved yet. Please contact the admin.');
      submittingRef.current = false;
      return;
    }

    const cartSubtotal = subtotal;
    if (cartSubtotal < minOrderValue) {
      Alert.alert(
        'Minimum order not met',
        `Your order total is ₹${cartSubtotal.toFixed(0)}. Minimum order value is ₹${minOrderValue}. Please add more items.`,
      );
      submittingRef.current = false;
      return;
    }

    if (fulfillmentMode === 'delivery' && !selectedShop) {
      setDeliveryAddressError('Please select a delivery location to continue');
      setAddressFlowOpen(true);
      submittingRef.current = false;
      return;
    }
    setDeliveryAddressError('');

    setPlacingOrder(true);

    try {
      const p_items = items.map((i) => ({
        product_id: i.product_id,
        qty: i.quantity,
        packaging_level_id: i.packaging_level_id ?? null,
        units_per_level: i.units_per_level ?? 1,
      }));

      const { data, error } = await withRetry(
        () => trackRpc('place_order', () =>
          supabase.rpc('place_order', {
            p_retailer_id: user.id,
            p_items: p_items,
            p_address:
              fulfillmentMode === 'pickup' || !selectedShop
                ? ''
                : toOrderDeliveryPayload(selectedShop).full_address,
            p_idempotency_key: idempotencyKey,
            p_payment_mode: paymentMode,
            p_redeem_points: redeemToggle ? redeemPoints : 0,
            p_fulfillment_mode: fulfillmentMode,
            p_delivery:
              fulfillmentMode === 'delivery' && selectedShop
                ? toOrderDeliveryPayload(selectedShop)
                : null,
            p_notes: notes,
          })
        ),
        { retries: 2, delayMs: 500 },
      );

      if (error) {
        const msg = error.message || '';
        if (msg.includes('insufficient_stock')) {
          Alert.alert('Stock Unavailable', 'One or more items are out of stock or have insufficient quantity. Please update your cart.');
        } else if (msg.includes('not_approved')) {
          Alert.alert('Account Pending', 'Your retailer account is not yet approved.');
        } else if (msg.includes('not_authorized')) {
          Alert.alert('Not Authorized', 'You are not authorized to place this order.');
        } else if (msg.includes('credit_limit_exceeded')) {
          Alert.alert('Credit Limit Exceeded', 'Order exceeds your credit limit. Please contact your sales rep.');
        } else if (msg.includes('invalid_payment_mode')) {
          Alert.alert('Invalid Payment Mode', 'Selected payment mode is not supported.');
        } else if (msg.includes('insufficient_points')) {                // CHANGED: FIX B
          Alert.alert('Insufficient Points', 'You do not have enough loyalty points.');
        } else if (msg.includes('redemption_limit_exceeded')) {          // CHANGED: FIX B
          Alert.alert('Redemption Limit', 'Points discount exceeds the maximum allowed percentage of order value.');
        } else if (msg.includes('pickup_not_enabled')) {
          Alert.alert('Pickup Unavailable', 'Pickup mode is not currently enabled.');
        } else if (msg.includes('delivery_address_required')) {
          setDeliveryAddressError('Please select a delivery location to continue');
          setAddressFlowOpen(true);
        } else {
          Alert.alert('Error', msg || 'Failed to place order');
        }
        return;
      }

      const result = data as { order_id: string; order_number: string; already_exists: boolean };

      invalidateHomeCache(user.id);

      if (result.already_exists) {
        Alert.alert('Order Already Placed', `Order #${result.order_number} was already submitted.`);
      }

      await clearCart();

      if (paymentMode === 'upi' && !result.already_exists) {
        router.replace({
          pathname: '/checkout/upi-payment',
          params: { orderId: result.order_id, orderNumber: result.order_number, amount: grandTotal.toString() },
        } as any);
        return;
      }

      const deliveryWindow = selectedShop
        ? formatDeliveryWindow(
            selectedShop.best_delivery_time_start,
            selectedShop.best_delivery_time_end,
          )
        : '';
      const successMsg = deliveryWindow
        ? `Order #${result.order_number} placed.\nPreferred delivery window: ${deliveryWindow}`
        : `Order #${result.order_number} placed successfully`;
      Alert.alert('Success', successMsg, [
        { text: 'OK', onPress: () => router.replace('/(tabs)') },
      ]);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to place order');
    } finally {
      setPlacingOrder(false);
      submittingRef.current = false;
    }
  };

  /* ================= UI ================= */

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <Stack.Screen options={{ title: 'Checkout' }} />

      <ScrollView contentContainerStyle={styles.content}>
        {/* Cart Summary */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('checkout.orderSummary')}</Text>

          {items.map((item) => (
            <View key={item.id} style={styles.row}>
              <Text style={styles.rowText} numberOfLines={1}>
                {item.name} x {item.quantity}
                {item.packaging_level_name ? ` ${item.packaging_level_name}(s)` : ''}
              </Text>
              <Text style={styles.rowText}>
                ₹{(item.selling_price * item.quantity).toFixed(2)}
              </Text>
            </View>
          ))}

          <View style={styles.divider} />

          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Subtotal</Text>
            <Text style={styles.totalValue}>₹{subtotal.toFixed(2)}</Text>
          </View>
          {gstEnabled && (
            <View style={[styles.totalRow, { marginTop: 4 }]}>
              <Text style={styles.totalLabel}>GST</Text>
              <Text style={styles.totalValue}>₹{gst.toFixed(2)}</Text>
            </View>
          )}
          {/* CHANGED: FIX B — Loyalty discount in summary */}
          {loyaltyDiscount > 0 && (
            <View style={[styles.totalRow, { marginTop: 4 }]}>
              <Text style={[styles.totalLabel, { color: colors.success }]}>Loyalty Discount</Text>
              <Text style={[styles.totalValue, { color: colors.success }]}>-₹{loyaltyDiscount.toFixed(2)}</Text>
            </View>
          )}
          <View style={[styles.totalRow, { marginTop: 8 }]}>
            <Text style={[styles.totalLabel, { fontWeight: '700', fontSize: 16 }]}>Total</Text>
            <Text style={[styles.totalValue, { fontWeight: '700', fontSize: 16, color: colors.primary }]}>₹{grandTotal.toFixed(2)}</Text>
          </View>
        </View>

        {/* CHANGED: FIX C — Fulfillment Mode Selector */}
        {pickupEnabled && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Fulfillment</Text>
            <View style={styles.fulfillmentRow}>
              <TouchableOpacity
                style={[styles.fulfillmentBtn, fulfillmentMode === 'delivery' && styles.fulfillmentBtnActive]}
                onPress={() => setFulfillmentMode('delivery')}
              >
                <Ionicons name="car-outline" size={18} color={fulfillmentMode === 'delivery' ? colors.primary : colors.textMuted} />
                <Text style={[styles.fulfillmentText, fulfillmentMode === 'delivery' && styles.fulfillmentTextActive]}>
                  Delivery
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.fulfillmentBtn, fulfillmentMode === 'pickup' && styles.fulfillmentBtnActive]}
                onPress={() => setFulfillmentMode('pickup')}
              >
                <Ionicons name="storefront-outline" size={18} color={fulfillmentMode === 'pickup' ? colors.primary : colors.textMuted} />
                <Text style={[styles.fulfillmentText, fulfillmentMode === 'pickup' && styles.fulfillmentTextActive]}>
                  Pickup
                </Text>
              </TouchableOpacity>
            </View>

            {fulfillmentMode === 'pickup' && (
              <View style={styles.pickupInfo}>
                <View style={styles.pickupRow}>
                  <Ionicons name="location-outline" size={16} color={colors.primary} />
                  <Text style={styles.pickupText}>{pickupAddress || 'Contact admin for address'}</Text>
                </View>
                {pickupHours ? (
                  <View style={styles.pickupRow}>
                    <Ionicons name="time-outline" size={16} color={colors.primary} />
                    <Text style={styles.pickupText}>{pickupHours}</Text>
                  </View>
                ) : null}
              </View>
            )}
          </View>
        )}

        {fulfillmentMode === 'delivery' && (
          <DeliverToCard
            location={selectedShop}
            error={deliveryAddressError}
            onChange={() => {
              setAddressFlowStage('address_book');
              setAddressFlowOpen(true);
            }}
          />
        )}

        {/* Notes */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Notes (optional)</Text>
          <TextInput
            style={styles.input}
            placeholder="Any instructions?"
            placeholderTextColor={colors.textMuted}
            value={notes}
            onChangeText={setNotes}
          />
        </View>

        {/* Payment Mode Selector */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Payment Mode</Text>
          {enabledModes.map((mode) => {
            const info = PAYMENT_MODE_LABELS[mode];
            const isSelected = paymentMode === mode;
            return (
              <TouchableOpacity
                key={mode}
                style={[styles.paymentOption, isSelected && styles.paymentOptionActive]}
                onPress={() => setPaymentMode(mode)}
              >
                <View style={styles.paymentOptionLeft}>
                  <Ionicons name={info.icon} size={20} color={isSelected ? colors.primary : colors.textMuted} />
                  <Text style={[styles.paymentOptionLabel, isSelected && styles.paymentOptionLabelActive]}>
                    {info.label}
                  </Text>
                </View>
                <View style={[styles.radioOuter, isSelected && styles.radioOuterActive]}>
                  {isSelected && <View style={styles.radioInner} />}
                </View>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* CHANGED: FIX B — Loyalty Points Redemption */}
        {loyaltyBalance > 0 && maxRedeemablePoints > 0 && (
          <View style={styles.section}>
            <View style={styles.loyaltyHeader}>
              <View style={styles.loyaltyLeft}>
                <Ionicons name="star" size={20} color={colors.warning} />
                <Text style={styles.sectionTitle}>Use Loyalty Points</Text>
              </View>
              <Switch
                value={redeemToggle}
                onValueChange={(v) => {
                  setRedeemToggle(v);
                  if (!v) setRedeemPoints(0);
                  else setRedeemPoints(Math.min(maxRedeemablePoints, loyaltyBalance));
                }}
                trackColor={{ false: colors.switchTrackOff, true: colors.switchTrackOn }}
                thumbColor={redeemToggle ? colors.switchThumbOn : colors.switchThumbOff}
              />
            </View>

            {redeemToggle && (
              <View style={styles.loyaltySlider}>
                <Text style={styles.loyaltyBalance}>
                  Available: {loyaltyBalance} pts | Max redeemable: {maxRedeemablePoints} pts
                </Text>
                <Slider
                  style={{ width: '100%', height: 40 }}
                  minimumValue={0}
                  maximumValue={maxRedeemablePoints}
                  step={1}
                  value={redeemPoints}
                  onValueChange={setRedeemPoints}
                  minimumTrackTintColor={colors.primary}
                  maximumTrackTintColor={colors.switchTrackOff}
                  thumbTintColor={colors.primary}
                />
                <View style={styles.loyaltyPreview}>
                  <Text style={styles.loyaltyPointsText}>{redeemPoints} points</Text>
                  <Text style={styles.loyaltyDiscountText}>-₹{(redeemPoints * redemptionRate).toFixed(2)} discount</Text>
                </View>
              </View>
            )}
          </View>
        )}
      </ScrollView>

      {/* Footer */}
      <View style={styles.footer}>
        <TouchableOpacity
          style={[styles.placeBtn, (placingOrder || loading) && styles.disabled]}
          onPress={placeOrder}
          disabled={placingOrder || loading}
        >
          {placingOrder ? (
            <ActivityIndicator color={colors.onPrimary} />
          ) : (
            <Text style={styles.placeText}>{t('checkout.placeOrder')}</Text>
          )}
        </TouchableOpacity>
      </View>

      {user && (
        <DeliveryAddressFlow
          visible={addressFlowOpen}
          onClose={() => setAddressFlowOpen(false)}
          onSelect={(loc) => {
            setSelectedShop(loc);
            setDeliveryAddressError('');
          }}
          retailerId={user.id}
          user={user}
          initialStage={addressFlowStage}
        />
      )}
    </SafeAreaView>
  );
}

/* ================= STYLES ================= */

function createStyles(c: AppColors, isDark: boolean) {
  return {
  container: { flex: 1, backgroundColor: c.background },
  content: { padding: 16, paddingBottom: 40 },
  section: { backgroundColor: c.surface, padding: 16, borderRadius: 12, marginBottom: 16 },
  sectionTitle: { fontSize: 16, fontWeight: '700', marginBottom: 12, color: c.text },
  row: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  rowText: { fontSize: 13, color: c.text },
  divider: { height: 1, backgroundColor: c.border, marginVertical: 12 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between' },
  totalLabel: { fontSize: 15, fontWeight: '600', color: c.text },
  totalValue: { fontSize: 15, fontWeight: '700', color: c.text },
  input: { backgroundColor: c.inputBackground, borderRadius: 8, padding: 12, minHeight: 48, textAlignVertical: 'top', color: c.text },
  footer: { padding: 16, backgroundColor: c.surface, borderTopWidth: 1, borderTopColor: c.border },
  placeBtn: { backgroundColor: c.primary, height: 56, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  placeText: { color: c.onPrimary, fontSize: 18, fontWeight: '600' },
  disabled: { opacity: 0.6 },

  /* Payment mode selector */
  paymentOption: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14, borderRadius: 10, borderWidth: 1.5, borderColor: c.border, marginBottom: 8, backgroundColor: c.surfaceSecondary },
  paymentOptionActive: { borderColor: c.primary, backgroundColor: c.primaryMuted },
  paymentOptionLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  paymentOptionLabel: { fontSize: 15, color: c.textSecondary, fontWeight: '500' },
  paymentOptionLabelActive: { color: c.primary, fontWeight: '600' },
  radioOuter: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: c.switchThumbOff, alignItems: 'center', justifyContent: 'center' },
  radioOuterActive: { borderColor: c.primary },
  radioInner: { width: 12, height: 12, borderRadius: 6, backgroundColor: c.primary },

  /* Fulfillment mode */
  fulfillmentRow: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  fulfillmentBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, borderRadius: 10, borderWidth: 1.5, borderColor: c.border, backgroundColor: c.surfaceSecondary },
  fulfillmentBtnActive: { borderColor: c.primary, backgroundColor: c.primaryMuted },
  fulfillmentText: { fontSize: 15, color: c.textMuted, fontWeight: '500' },
  fulfillmentTextActive: { color: c.primary, fontWeight: '600' },
  pickupInfo: { backgroundColor: c.primaryMuted, borderRadius: 10, padding: 12, gap: 8 },
  pickupRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pickupText: { fontSize: 13, color: c.textSecondary, flex: 1 },

  /* Loyalty */
  loyaltyHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 0 },
  loyaltyLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  loyaltySlider: { marginTop: 8 },
  loyaltyBalance: { fontSize: 12, color: c.textMuted, marginBottom: 4 },
  loyaltyPreview: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 },
  loyaltyPointsText: { fontSize: 14, fontWeight: '600', color: c.text },
  loyaltyDiscountText: { fontSize: 14, fontWeight: '700', color: c.success },
  } as const;
}
