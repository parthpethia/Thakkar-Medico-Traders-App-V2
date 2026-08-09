import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  StyleSheet,
  Switch,
  FlatList,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../../src/services/supabase';
import { useAppTheme } from '../../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../../src/theme/useThemedStyles';
import type { AppColors } from '../../../src/theme/colors';

// Simple UUID generator to avoid bundle resolution issues
const generateUuid = () => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

type Retailer = {
  id: string;
  name: string;
  business_name: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
  loyalty_points: number;
  credit_limit: number;
  credit_used: number;
};

type Product = {
  id: string;
  name: string;
  sku: string;
  selling_price: number;
  mrp: number;
  stock_quantity: number;
  pack_size: string;
  gst_percent: number;
};

type CartItem = {
  product: Product;
  quantity: number;
};

export default function PosBilling() {
  const { colors, isDark } = useAppTheme();
  const styles = useThemedStyles(createStyles);
  const router = useRouter();

  // Settings
  const [gstEnabled, setGstEnabled] = useState(true);
  const [redemptionRate, setRedemptionRate] = useState(0.5);
  const [maxRedemptionPct, setMaxRedemptionPct] = useState(20);

  // Loading states
  const [loadingRetailers, setLoadingRetailers] = useState(true);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // Data lists
  const [retailers, setRetailers] = useState<Retailer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);

  // Selection states
  const [retailerSearch, setRetailerSearch] = useState('');
  const [selectedRetailer, setSelectedRetailer] = useState<Retailer | null>(null);
  const [productSearch, setProductSearch] = useState('');
  const [cart, setCart] = useState<CartItem[]>([]);

  // Input states
  const [paymentMode, setPaymentMode] = useState<'cod' | 'credit' | 'upi'>('cod');
  const [fulfillmentMode, setFulfillmentMode] = useState<'pickup' | 'delivery'>('pickup');
  const [redeemToggle, setRedeemToggle] = useState(false);
  const [redeemPoints, setRedeemPoints] = useState(0);
  const [notes, setNotes] = useState('');

  // Dropdown list toggles
  const [showRetailerDropdown, setShowRetailerDropdown] = useState(false);

  // Load initial settings and details
  useEffect(() => {
    fetchSettings();
    fetchRetailers();
    fetchProducts();
  }, []);

  const fetchSettings = async () => {
    try {
      const { data } = await supabase
        .from('settings')
        .select('gst_enabled, loyalty_redemption_rate, max_redemption_percent')
        .limit(1)
        .single();
      if (data) {
        setGstEnabled(data.gst_enabled ?? true);
        setRedemptionRate(data.loyalty_redemption_rate ?? 0.5);
        setMaxRedemptionPct(data.max_redemption_percent ?? 20);
      }
    } catch {}
  };

  const fetchRetailers = async () => {
    try {
      setLoadingRetailers(true);
      const { data, error } = await supabase
        .from('profiles')
        .select('id, name, business_name, phone, address, city, state, pincode, loyalty_points, credit_limit, credit_used')
        .eq('role', 'retailer')
        .eq('approved', true)
        .order('business_name');

      if (error) throw error;
      setRetailers((data || []) as Retailer[]);
    } catch (err: any) {
      Alert.alert('Error', 'Failed to load retailers: ' + err.message);
    } finally {
      setLoadingRetailers(false);
    }
  };

  const fetchProducts = async () => {
    try {
      setLoadingProducts(true);
      const { data, error } = await supabase
        .from('products')
        .select('id, name, sku, selling_price, mrp, stock_quantity, pack_size, gst_percent')
        .eq('is_active', true)
        .order('name');

      if (error) throw error;
      setProducts((data || []) as Product[]);
    } catch (err: any) {
      Alert.alert('Error', 'Failed to load products: ' + err.message);
    } finally {
      setLoadingProducts(false);
    }
  };

  // Filter retailers based on search text
  const filteredRetailers = useMemo(() => {
    if (!retailerSearch.trim()) return [];
    const query = retailerSearch.toLowerCase();
    return retailers.filter(
      (r) =>
        r.business_name?.toLowerCase().includes(query) ||
        r.name?.toLowerCase().includes(query) ||
        r.phone?.includes(query)
    );
  }, [retailerSearch, retailers]);

  // Filter products based on search text
  const filteredProducts = useMemo(() => {
    if (!productSearch.trim()) return [];
    const query = productSearch.toLowerCase();
    return products.filter(
      (p) => p.name?.toLowerCase().includes(query) || p.sku?.toLowerCase().includes(query)
    );
  }, [productSearch, products]);

  // POS Cart item operations
  const addToCart = (product: Product) => {
    setCart((prev) => {
      const idx = prev.findIndex((item) => item.product.id === product.id);
      if (idx > -1) {
        const item = prev[idx];
        if (item.quantity >= product.stock_quantity) {
          Alert.alert('Out of stock', `Cannot add more. Only ${product.stock_quantity} available in stock.`);
          return prev;
        }
        const next = [...prev];
        next[idx] = { ...item, quantity: item.quantity + 1 };
        return next;
      } else {
        if (product.stock_quantity <= 0) {
          Alert.alert('Out of stock', 'This product is out of stock.');
          return prev;
        }
        return [...prev, { product, quantity: 1 }];
      }
    });
    setProductSearch(''); // Reset search bar
  };

  const updateCartQty = (productId: string, change: number) => {
    setCart((prev) => {
      const idx = prev.findIndex((item) => item.product.id === productId);
      if (idx === -1) return prev;

      const item = prev[idx];
      const newQty = item.quantity + change;

      if (newQty <= 0) {
        return prev.filter((it) => it.product.id !== productId);
      }

      if (newQty > item.product.stock_quantity) {
        Alert.alert('Out of stock', `Only ${item.product.stock_quantity} units available.`);
        return prev;
      }

      const next = [...prev];
      next[idx] = { ...item, quantity: newQty };
      return next;
    });
  };

  // Calculations
  const totals = useMemo(() => {
    let subtotal = 0;
    let gst = 0;

    cart.forEach((item) => {
      const baseTotal = item.product.selling_price * item.quantity;
      subtotal += baseTotal;

      if (gstEnabled) {
        gst += (baseTotal * item.product.gst_percent) / 100;
      }
    });

    const rawGrandTotal = subtotal + gst;

    // Loyalty point redemption calculations
    const balance = selectedRetailer?.loyalty_points || 0;
    const maxDiscount = (rawGrandTotal * maxRedemptionPct) / 100;
    const maxPointsByDiscount = Math.floor(maxDiscount / redemptionRate);
    const maxRedeemablePoints = Math.min(balance, maxPointsByDiscount);

    const discountAmount = redeemToggle ? Math.min(redeemPoints, maxRedeemablePoints) * redemptionRate : 0;
    const grandTotal = rawGrandTotal - discountAmount;

    return {
      subtotal,
      gst,
      rawGrandTotal,
      maxRedeemablePoints,
      discountAmount,
      grandTotal,
    };
  }, [cart, gstEnabled, selectedRetailer, redeemToggle, redeemPoints, redemptionRate, maxRedemptionPct]);

  // Place order
  const handlePlaceOrder = async () => {
    if (submitting) return;

    if (!selectedRetailer) {
      Alert.alert('Missing Field', 'Please select a retailer.');
      return;
    }

    if (cart.length === 0) {
      Alert.alert('Empty Cart', 'Please add at least one product.');
      return;
    }

    // Credit limit check
    if (paymentMode === 'credit') {
      const remainingCredit = selectedRetailer.credit_limit - selectedRetailer.credit_used;
      if (totals.grandTotal > remainingCredit) {
        Alert.alert(
          'Credit Limit Exceeded',
          `Order total (₹${totals.grandTotal.toFixed(2)}) exceeds remaining credit limit (₹${remainingCredit.toFixed(2)}).`
        );
        return;
      }
    }

    setSubmitting(true);
    try {
      // 1. Construct addresses/payloads
      const retailerAddress = [
      selectedRetailer.address,
      selectedRetailer.city,
      selectedRetailer.state,
      selectedRetailer.pincode,
    ]
      .filter(Boolean)
      .join(', ');

    if (fulfillmentMode === 'delivery' && !retailerAddress.trim()) {
      Alert.alert(
        'Address Missing',
        'This retailer does not have a delivery address registered in their profile. Please select Counter Pickup or update their profile first.'
      );
      setSubmitting(false);
      return;
    }

    const formattedItems = cart.map((item) => ({
      product_id: item.product.id,
      qty: item.quantity,
      packaging_level_id: null,
      units_per_level: 1,
    }));

    // Generate idempotency key
    const idempotencyKey = generateUuid();

    // 2. Call place_order Supabase RPC
    const { data, error } = await supabase.rpc('place_order', {
      p_retailer_id: selectedRetailer.id,
      p_items: formattedItems,
      p_address: fulfillmentMode === 'pickup' ? '' : retailerAddress,
      p_idempotency_key: idempotencyKey,
      p_payment_mode: paymentMode,
      p_redeem_points: redeemToggle ? Math.min(redeemPoints, totals.maxRedeemablePoints) : 0,
      p_fulfillment_mode: fulfillmentMode,
      p_delivery: null,
      p_notes: notes || 'Counter POS Order',
    });

    if (error) throw error;

    const result = data as { order_id: string; order_number: string };

    // 3. Keep POS order status as 'approved' when created by admin
    if (result.order_id) {
      await supabase
        .from('orders')
        .update({ status: 'approved' })
        .eq('id', result.order_id);
    }

    Alert.alert('POS Order Generated', `Order #${result.order_number} created successfully.`, [
      {
        text: 'OK & View Invoice',
        onPress: () => {
          router.replace({
            pathname: '/order/invoice',
            params: { orderId: result.order_id },
          } as any);
        },
      },
    ]);
    } catch (err: any) {
      Alert.alert('Error placing order', err.message || 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <Stack.Screen options={{ title: 'POS Billing Counter' }} />

      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        {/* Step 1: Select Retailer */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>1. Select Retailer</Text>
          {selectedRetailer ? (
            <View style={styles.selectedRetailerCard}>
              <View style={{ flex: 1 }}>
                <Text style={styles.retailerName}>{selectedRetailer.business_name}</Text>
                <Text style={styles.retailerSub}>{selectedRetailer.name} · {selectedRetailer.phone}</Text>
                <View style={styles.retailerStatsRow}>
                  <Text style={styles.statText}>Points: <Text style={styles.boldText}>{selectedRetailer.loyalty_points}</Text></Text>
                  <Text style={styles.statText}>
                    Credit Left: <Text style={styles.boldText}>₹{(selectedRetailer.credit_limit - selectedRetailer.credit_used).toFixed(2)}</Text>
                  </Text>
                </View>
              </View>
              <TouchableOpacity
                onPress={() => {
                  setSelectedRetailer(null);
                  setRedeemToggle(false);
                  setRedeemPoints(0);
                }}
              >
                <Ionicons name="close-circle" size={24} color={colors.error} />
              </TouchableOpacity>
            </View>
          ) : (
            <View>
              <View style={styles.searchInputRow}>
                <Ionicons name="search-outline" size={20} color={colors.textMuted} style={styles.searchIcon} />
                <TextInput
                  style={styles.textInput}
                  placeholder="Search by business name, contact name, phone..."
                  placeholderTextColor={colors.textMuted}
                  value={retailerSearch}
                  onChangeText={(val) => {
                    setRetailerSearch(val);
                    setShowRetailerDropdown(true);
                  }}
                  onFocus={() => setShowRetailerDropdown(true)}
                />
              </View>

              {showRetailerDropdown && filteredRetailers.length > 0 && (
                <View style={styles.dropdownContainer}>
                  {filteredRetailers.map((item) => (
                    <TouchableOpacity
                      key={item.id}
                      style={styles.dropdownItem}
                      onPress={() => {
                        setSelectedRetailer(item);
                        setRetailerSearch('');
                        setShowRetailerDropdown(false);
                      }}
                    >
                      <Text style={styles.dropdownItemName}>{item.business_name}</Text>
                      <Text style={styles.dropdownItemSub}>
                        {item.name} · {item.phone} · Pt Bal: {item.loyalty_points}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
              {retailerSearch.trim().length > 0 && filteredRetailers.length === 0 && (
                <Text style={styles.emptySearchText}>No matching retailers found</Text>
              )}
            </View>
          )}
        </View>

        {/* Step 2: Search & Add Products */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>2. Add Products</Text>
          <View style={styles.searchInputRow}>
            <Ionicons name="medical-outline" size={20} color={colors.textMuted} style={styles.searchIcon} />
            <TextInput
              style={styles.textInput}
              placeholder="Search product by name or SKU..."
              placeholderTextColor={colors.textMuted}
              value={productSearch}
              onChangeText={setProductSearch}
            />
            {productSearch.length > 0 && (
              <TouchableOpacity onPress={() => setProductSearch('')}>
                <Ionicons name="close" size={20} color={colors.textMuted} />
              </TouchableOpacity>
            )}
          </View>

          {productSearch.trim().length > 0 && (
            <View style={styles.dropdownContainer}>
              {filteredProducts.slice(0, 10).map((item) => (
                <TouchableOpacity key={item.id} style={styles.dropdownProductItem} onPress={() => addToCart(item)}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.productItemName}>{item.name}</Text>
                    <Text style={styles.productItemSub}>
                      SKU: {item.sku} · Pack: {item.pack_size} · Price: ₹{item.selling_price.toFixed(2)}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={[styles.stockText, item.stock_quantity <= 0 && styles.outOfStockText]}>
                      Stock: {item.stock_quantity}
                    </Text>
                    <Text style={styles.addProductBadge}>+ Add</Text>
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>

        {/* Step 3: Billing Cart Items List */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>3. Billing Items ({cart.length})</Text>
          {cart.length === 0 ? (
            <View style={styles.emptyCartContainer}>
              <Ionicons name="cart-outline" size={48} color={colors.textMuted} />
              <Text style={styles.emptyCartText}>No items added to the bill yet.</Text>
            </View>
          ) : (
            <View>
              {cart.map((item) => (
                <View key={item.product.id} style={styles.cartItemRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cartItemName}>{item.product.name}</Text>
                    <Text style={styles.cartItemPrice}>
                      ₹{item.product.selling_price.toFixed(2)} / unit · Pack: {item.product.pack_size}
                    </Text>
                  </View>

                  <View style={styles.qtyContainer}>
                    <TouchableOpacity style={styles.qtyBtn} onPress={() => updateCartQty(item.product.id, -1)}>
                      <Ionicons name="remove" size={16} color={colors.text} />
                    </TouchableOpacity>
                    <Text style={styles.qtyVal}>{item.quantity}</Text>
                    <TouchableOpacity style={styles.qtyBtn} onPress={() => updateCartQty(item.product.id, 1)}>
                      <Ionicons name="add" size={16} color={colors.text} />
                    </TouchableOpacity>
                  </View>

                  <Text style={styles.cartItemTotal}>
                    ₹{(item.product.selling_price * item.quantity).toFixed(2)}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </View>

        {/* Step 4: Billing Settings (Payment, Fulfillment, Loyalty) */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>4. Bill Options</Text>

          {/* Fulfillment selection */}
          <Text style={styles.fieldLabel}>Fulfillment Type</Text>
          <View style={styles.modeSelectorRow}>
            <TouchableOpacity
              style={[styles.modeButton, fulfillmentMode === 'pickup' && styles.modeButtonActive]}
              onPress={() => setFulfillmentMode('pickup')}
            >
              <Ionicons name="storefront-outline" size={18} color={fulfillmentMode === 'pickup' ? colors.primary : colors.textMuted} />
              <Text style={[styles.modeButtonText, fulfillmentMode === 'pickup' && styles.modeButtonTextActive]}>
                Counter Pickup
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modeButton, fulfillmentMode === 'delivery' && styles.modeButtonActive]}
              onPress={() => setFulfillmentMode('delivery')}
            >
              <Ionicons name="car-outline" size={18} color={fulfillmentMode === 'delivery' ? colors.primary : colors.textMuted} />
              <Text style={[styles.modeButtonText, fulfillmentMode === 'delivery' && styles.modeButtonTextActive]}>
                Home Delivery
              </Text>
            </TouchableOpacity>
          </View>

          {/* Payment selection */}
          <Text style={styles.fieldLabel}>Payment Mode</Text>
          <View style={styles.modeSelectorRow}>
            <TouchableOpacity
              style={[styles.modeButton, paymentMode === 'cod' && styles.modeButtonActive]}
              onPress={() => setPaymentMode('cod')}
            >
              <Ionicons name="cash-outline" size={18} color={paymentMode === 'cod' ? colors.primary : colors.textMuted} />
              <Text style={[styles.modeButtonText, paymentMode === 'cod' && styles.modeButtonTextActive]}>
                Cash (COD)
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modeButton, paymentMode === 'upi' && styles.modeButtonActive]}
              onPress={() => setPaymentMode('upi')}
            >
              <Ionicons name="phone-portrait-outline" size={18} color={paymentMode === 'upi' ? colors.primary : colors.textMuted} />
              <Text style={[styles.modeButtonText, paymentMode === 'upi' && styles.modeButtonTextActive]}>
                UPI / Card
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.modeButton,
                paymentMode === 'credit' && styles.modeButtonActive,
                !selectedRetailer && styles.disabledBtn,
              ]}
              onPress={() => selectedRetailer && setPaymentMode('credit')}
              disabled={!selectedRetailer}
            >
              <Ionicons name="wallet-outline" size={18} color={paymentMode === 'credit' ? colors.primary : colors.textMuted} />
              <Text style={[styles.modeButtonText, paymentMode === 'credit' && styles.modeButtonTextActive]}>
                Credit Book
              </Text>
            </TouchableOpacity>
          </View>

          {/* Loyalty switch */}
          {selectedRetailer && selectedRetailer.loyalty_points > 0 && totals.maxRedeemablePoints > 0 && (
            <View style={styles.loyaltyWrapper}>
              <View style={styles.switchContainer}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.loyaltyTitle}>Redeem Loyalty Points</Text>
                  <Text style={styles.loyaltySub}>
                    Balance: {selectedRetailer.loyalty_points} pts (Max redeemable: {totals.maxRedeemablePoints} pts)
                  </Text>
                </View>
                <Switch
                  value={redeemToggle}
                  onValueChange={(val) => {
                    setRedeemToggle(val);
                    if (val) setRedeemPoints(totals.maxRedeemablePoints);
                    else setRedeemPoints(0);
                  }}
                  trackColor={{ false: colors.switchTrackOff, true: colors.switchTrackOn }}
                  thumbColor={redeemToggle ? colors.switchThumbOn : colors.switchThumbOff}
                />
              </View>

              {redeemToggle && (
                <View style={styles.pointsInputRow}>
                  <Text style={styles.pointsInputLabel}>Redeem Points:</Text>
                  <TextInput
                    style={styles.pointsInput}
                    keyboardType="number-pad"
                    value={redeemPoints.toString()}
                    onChangeText={(val) => {
                      const num = parseInt(val) || 0;
                      setRedeemPoints(Math.min(num, totals.maxRedeemablePoints));
                    }}
                  />
                  <Text style={styles.pointsValueLabel}>
                    = -₹{(redeemPoints * redemptionRate).toFixed(2)}
                  </Text>
                </View>
              )}
            </View>
          )}

          {/* Billing Notes */}
          <Text style={[styles.fieldLabel, { marginTop: 12 }]}>Order Notes (Optional)</Text>
          <TextInput
            style={styles.notesInput}
            placeholder="E.g. Invoice print remarks, delivery timings..."
            placeholderTextColor={colors.textMuted}
            value={notes}
            onChangeText={setNotes}
          />
        </View>
      </ScrollView>

      {/* Cart Summary & Sticky Place Order Footer */}
      <View style={styles.stickyFooter}>
        <View style={styles.summaryContainer}>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Subtotal</Text>
            <Text style={styles.summaryValue}>₹{totals.subtotal.toFixed(2)}</Text>
          </View>
          {gstEnabled && (
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>GST Total</Text>
              <Text style={styles.summaryValue}>₹{totals.gst.toFixed(2)}</Text>
            </View>
          )}
          {totals.discountAmount > 0 && (
            <View style={styles.summaryRow}>
              <Text style={[styles.summaryLabel, { color: colors.success }]}>Loyalty Discount</Text>
              <Text style={[styles.summaryValue, { color: colors.success }]}>-₹{totals.discountAmount.toFixed(2)}</Text>
            </View>
          )}
          <View style={styles.divider} />
          <View style={styles.summaryRow}>
            <Text style={styles.grandLabel}>Grand Total</Text>
            <Text style={styles.grandValue}>₹{totals.grandTotal.toFixed(2)}</Text>
          </View>
        </View>

        <TouchableOpacity
          style={[styles.checkoutBtn, (submitting || cart.length === 0) && styles.disabledBtn]}
          onPress={handlePlaceOrder}
          disabled={submitting || cart.length === 0}
        >
          {submitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <View style={styles.checkoutBtnInner}>
              <Ionicons name="print-outline" size={20} color="#fff" />
              <Text style={styles.checkoutBtnText}>Place Order & Print Invoice</Text>
            </View>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

function createStyles(c: AppColors, isDark: boolean) {
  return {
    container: {
      flex: 1,
      backgroundColor: isDark ? c.background : '#F5F5F5',
    },
    scrollContent: {
      padding: 12,
      paddingBottom: 220,
    },
    section: {
      backgroundColor: c.surface,
      borderRadius: 12,
      padding: 16,
      marginBottom: 12,
      borderWidth: 1,
      borderColor: c.border,
    },
    sectionTitle: {
      fontSize: 15,
      fontWeight: '700' as const,
      color: c.text,
      marginBottom: 12,
    },
    searchInputRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      backgroundColor: c.inputBackground,
      borderRadius: 8,
      paddingHorizontal: 12,
      borderWidth: 1,
      borderColor: c.border,
      height: 48,
    },
    searchIcon: {
      marginRight: 8,
    },
    textInput: {
      flex: 1,
      color: c.text,
      fontSize: 14,
    },
    dropdownContainer: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 8,
      marginTop: 4,
      maxHeight: 200,
      overflow: 'hidden' as const,
      elevation: 4,
    },
    dropdownItem: {
      padding: 12,
      borderBottomWidth: 1,
      borderBottomColor: c.borderLight,
    },
    dropdownItemName: {
      fontSize: 14,
      fontWeight: '700' as const,
      color: c.text,
    },
    dropdownItemSub: {
      fontSize: 12,
      color: c.textSecondary,
      marginTop: 2,
    },
    dropdownProductItem: {
      flexDirection: 'row' as const,
      padding: 12,
      borderBottomWidth: 1,
      borderBottomColor: c.borderLight,
      alignItems: 'center' as const,
    },
    productItemName: {
      fontSize: 14,
      fontWeight: '600' as const,
      color: c.text,
    },
    productItemSub: {
      fontSize: 12,
      color: c.textMuted,
      marginTop: 2,
    },
    stockText: {
      fontSize: 11,
      color: c.success,
      fontWeight: '600' as const,
    },
    outOfStockText: {
      color: c.error,
    },
    addProductBadge: {
      color: c.primary,
      fontWeight: '700' as const,
      fontSize: 12,
      marginTop: 4,
      backgroundColor: c.primaryMuted,
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 4,
    },
    selectedRetailerCard: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      backgroundColor: c.primaryMuted,
      borderRadius: 8,
      padding: 12,
      borderWidth: 1,
      borderColor: c.primary,
    },
    retailerName: {
      fontSize: 15,
      fontWeight: '700' as const,
      color: c.primary,
    },
    retailerSub: {
      fontSize: 13,
      color: c.textSecondary,
      marginTop: 2,
    },
    retailerStatsRow: {
      flexDirection: 'row' as const,
      gap: 12,
      marginTop: 6,
    },
    statText: {
      fontSize: 12,
      color: c.textSecondary,
    },
    boldText: {
      fontWeight: '700' as const,
      color: c.text,
    },
    emptySearchText: {
      fontSize: 12,
      color: c.textMuted,
      marginTop: 6,
      textAlign: 'center' as const,
    },
    emptyCartContainer: {
      alignItems: 'center' as const,
      paddingVertical: 20,
    },
    emptyCartText: {
      fontSize: 13,
      color: c.textMuted,
      marginTop: 8,
    },
    cartItemRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: c.borderLight,
    },
    cartItemName: {
      fontSize: 14,
      fontWeight: '600' as const,
      color: c.text,
    },
    cartItemPrice: {
      fontSize: 11,
      color: c.textMuted,
      marginTop: 2,
    },
    qtyContainer: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 6,
      marginHorizontal: 12,
    },
    qtyBtn: {
      padding: 6,
      backgroundColor: c.inputBackground,
    },
    qtyVal: {
      paddingHorizontal: 10,
      fontSize: 13,
      fontWeight: '700' as const,
      color: c.text,
    },
    cartItemTotal: {
      fontSize: 14,
      fontWeight: '700' as const,
      color: c.text,
      width: 70,
      textAlign: 'right' as const,
    },
    fieldLabel: {
      fontSize: 13,
      fontWeight: '600' as const,
      color: c.textSecondary,
      marginBottom: 6,
      marginTop: 10,
    },
    modeSelectorRow: {
      flexDirection: 'row' as const,
      gap: 8,
      marginBottom: 8,
    },
    modeButton: {
      flex: 1,
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      gap: 6,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 8,
      paddingVertical: 10,
      backgroundColor: c.surface,
    },
    modeButtonActive: {
      borderColor: c.primary,
      backgroundColor: c.primaryMuted,
    },
    modeButtonText: {
      fontSize: 12,
      fontWeight: '600' as const,
      color: c.textSecondary,
    },
    modeButtonTextActive: {
      color: c.primary,
      fontWeight: '700' as const,
    },
    disabledBtn: {
      opacity: 0.5,
    },
    loyaltyWrapper: {
      backgroundColor: c.inputBackground,
      borderRadius: 8,
      padding: 10,
      marginTop: 10,
      borderWidth: 1,
      borderColor: c.border,
    },
    switchContainer: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
    },
    loyaltyTitle: {
      fontSize: 13,
      fontWeight: '700' as const,
      color: c.text,
    },
    loyaltySub: {
      fontSize: 11,
      color: c.textMuted,
      marginTop: 2,
    },
    pointsInputRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      marginTop: 10,
      borderTopWidth: 1,
      borderTopColor: c.borderLight,
      paddingTop: 8,
    },
    pointsInputLabel: {
      fontSize: 12,
      color: c.textSecondary,
    },
    pointsInput: {
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      borderRadius: 6,
      width: 80,
      height: 32,
      paddingHorizontal: 8,
      marginHorizontal: 8,
      color: c.text,
      fontSize: 13,
      fontWeight: '700' as const,
      textAlign: 'center' as const,
    },
    pointsValueLabel: {
      fontSize: 13,
      fontWeight: '700' as const,
      color: c.success,
    },
    notesInput: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 8,
      backgroundColor: c.inputBackground,
      padding: 10,
      height: 48,
      color: c.text,
      fontSize: 13,
    },
    stickyFooter: {
      position: 'absolute' as const,
      bottom: 0,
      left: 0,
      right: 0,
      backgroundColor: c.surface,
      borderTopWidth: 1,
      borderTopColor: c.border,
      padding: 12,
      elevation: 10,
    },
    summaryContainer: {
      marginBottom: 10,
    },
    summaryRow: {
      flexDirection: 'row' as const,
      justifyContent: 'space-between' as const,
      marginBottom: 4,
    },
    summaryLabel: {
      fontSize: 12,
      color: c.textMuted,
    },
    summaryValue: {
      fontSize: 12,
      color: c.textSecondary,
      fontWeight: '600' as const,
    },
    grandLabel: {
      fontSize: 14,
      fontWeight: '700' as const,
      color: c.text,
    },
    grandValue: {
      fontSize: 17,
      fontWeight: '800' as const,
      color: c.primary,
    },
    divider: {
      height: 1,
      backgroundColor: c.borderLight,
      marginVertical: 6,
    },
    checkoutBtn: {
      backgroundColor: c.success,
      borderRadius: 8,
      height: 48,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    checkoutBtnInner: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 6,
    },
    checkoutBtnText: {
      color: '#fff',
      fontSize: 15,
      fontWeight: '700' as const,
    },
  };
}
