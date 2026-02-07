import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../src/store/authStore';
import { useCartStore } from '../src/store/cartStore';
import { useSettingsStore } from '../src/store/settingsStore';
import { DeliveryType, PaymentMode } from '../src/types';
import api from '../src/services/api';

export default function Checkout() {
  const router = useRouter();
  const { user, checkAuth } = useAuthStore();
  const { items, getTotal, clearCart } = useCartStore();
  const { settings } = useSettingsStore();
  
  const [deliveryType, setDeliveryType] = useState<DeliveryType>('delivery');
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('cod');
  const [deliveryAddress, setDeliveryAddress] = useState(user?.address || '');
  const [notes, setNotes] = useState('');
  const [redeemPoints, setRedeemPoints] = useState(0);
  const [loading, setLoading] = useState(false);

  const { subtotal, itemCount } = getTotal();
  const business = settings?.business;
  const features = settings?.features;
  
  // Calculate GST
  const gstAmount = items.reduce((sum, item) => {
    const itemSubtotal = item.selling_price * item.quantity;
    return sum + (itemSubtotal * item.gst_percent) / 100;
  }, 0);
  
  // Delivery charge
  const freeDeliveryAbove = business?.free_delivery_above || 2000;
  const deliveryCharge = deliveryType === 'delivery' && subtotal < freeDeliveryAbove 
    ? (business?.delivery_charge || 50) 
    : 0;
  
  // Points discount
  const pointValue = business?.point_value_in_rupees || 0.5;
  const maxRedemptionPercent = business?.max_points_redemption_percent || 50;
  const maxPointsValue = (subtotal * maxRedemptionPercent) / 100;
  const maxRedeemablePoints = Math.floor(maxPointsValue / pointValue);
  const actualRedeemPoints = Math.min(redeemPoints, user?.loyalty_points || 0, maxRedeemablePoints);
  const pointsDiscount = actualRedeemPoints * pointValue;
  
  // Credit available
  const availableCredit = (user?.credit_limit || 0) - (user?.credit_used || 0);
  
  // Grand total
  const grandTotal = subtotal + gstAmount + deliveryCharge - pointsDiscount;

  const handlePlaceOrder = async () => {
    if (items.length === 0) {
      Alert.alert('Empty Cart', 'Please add items to your cart');
      return;
    }
    
    if (deliveryType === 'delivery' && !deliveryAddress.trim()) {
      Alert.alert('Address Required', 'Please enter a delivery address');
      return;
    }
    
    if (paymentMode === 'credit' && grandTotal > availableCredit) {
      Alert.alert('Insufficient Credit', `Your available credit is \u20b9${availableCredit.toFixed(0)}`);
      return;
    }
    
    setLoading(true);
    
    try {
      const orderData = {
        items: items.map(item => ({
          product_id: item.product_id,
          quantity: item.quantity,
        })),
        delivery_type: deliveryType,
        payment_mode: paymentMode,
        delivery_address: deliveryType === 'delivery' ? deliveryAddress : null,
        notes: notes || null,
        redeem_points: actualRedeemPoints,
      };
      
      const response = await api.post('/orders', orderData);
      
      await checkAuth(); // Refresh user data (points, credit)
      
      Alert.alert(
        'Order Placed!',
        `Your order #${response.data.order_number} has been placed successfully.`,
        [
          {
            text: 'View Order',
            onPress: () => router.replace(`/order/${response.data.id}`),
          },
        ]
      );
    } catch (error: any) {
      Alert.alert('Error', error.response?.data?.detail || 'Failed to place order');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Checkout' }} />
      
      <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
        {/* Delivery Type */}
        {features?.delivery_enabled && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Delivery Type</Text>
            
            <TouchableOpacity
              style={[
                styles.optionCard,
                deliveryType === 'delivery' && styles.optionCardActive,
              ]}
              onPress={() => setDeliveryType('delivery')}
            >
              <Ionicons 
                name="car" 
                size={24} 
                color={deliveryType === 'delivery' ? '#1E88E5' : '#666'} 
              />
              <View style={styles.optionContent}>
                <Text style={[
                  styles.optionTitle,
                  deliveryType === 'delivery' && styles.optionTitleActive
                ]}>Home Delivery</Text>
                <Text style={styles.optionSubtitle}>
                  {subtotal >= freeDeliveryAbove 
                    ? 'Free Delivery' 
                    : `Delivery charge: \u20b9${business?.delivery_charge || 50}`}
                </Text>
              </View>
              <View style={[
                styles.radio,
                deliveryType === 'delivery' && styles.radioActive
              ]} />
            </TouchableOpacity>
            
            <TouchableOpacity
              style={[
                styles.optionCard,
                deliveryType === 'pickup' && styles.optionCardActive,
              ]}
              onPress={() => setDeliveryType('pickup')}
            >
              <Ionicons 
                name="storefront" 
                size={24} 
                color={deliveryType === 'pickup' ? '#1E88E5' : '#666'} 
              />
              <View style={styles.optionContent}>
                <Text style={[
                  styles.optionTitle,
                  deliveryType === 'pickup' && styles.optionTitleActive
                ]}>Store Pickup</Text>
                <Text style={styles.optionSubtitle}>Pick up from store</Text>
              </View>
              <View style={[
                styles.radio,
                deliveryType === 'pickup' && styles.radioActive
              ]} />
            </TouchableOpacity>
          </View>
        )}

        {/* Delivery Address */}
        {deliveryType === 'delivery' && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Delivery Address</Text>
            <TextInput
              style={styles.addressInput}
              placeholder="Enter your delivery address"
              value={deliveryAddress}
              onChangeText={setDeliveryAddress}
              multiline
              numberOfLines={3}
            />
          </View>
        )}

        {/* Payment Mode */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Payment Method</Text>
          
          <TouchableOpacity
            style={[
              styles.optionCard,
              paymentMode === 'cod' && styles.optionCardActive,
            ]}
            onPress={() => setPaymentMode('cod')}
          >
            <Ionicons 
              name="cash" 
              size={24} 
              color={paymentMode === 'cod' ? '#1E88E5' : '#666'} 
            />
            <View style={styles.optionContent}>
              <Text style={[
                styles.optionTitle,
                paymentMode === 'cod' && styles.optionTitleActive
              ]}>Cash on Delivery</Text>
            </View>
            <View style={[
              styles.radio,
              paymentMode === 'cod' && styles.radioActive
            ]} />
          </TouchableOpacity>
          
          <TouchableOpacity
            style={[
              styles.optionCard,
              paymentMode === 'upi' && styles.optionCardActive,
            ]}
            onPress={() => setPaymentMode('upi')}
          >
            <Ionicons 
              name="phone-portrait" 
              size={24} 
              color={paymentMode === 'upi' ? '#1E88E5' : '#666'} 
            />
            <View style={styles.optionContent}>
              <Text style={[
                styles.optionTitle,
                paymentMode === 'upi' && styles.optionTitleActive
              ]}>UPI Payment</Text>
            </View>
            <View style={[
              styles.radio,
              paymentMode === 'upi' && styles.radioActive
            ]} />
          </TouchableOpacity>
          
          {features?.credit_enabled && availableCredit > 0 && (
            <TouchableOpacity
              style={[
                styles.optionCard,
                paymentMode === 'credit' && styles.optionCardActive,
                grandTotal > availableCredit && styles.optionCardDisabled,
              ]}
              onPress={() => {
                if (grandTotal <= availableCredit) {
                  setPaymentMode('credit');
                } else {
                  Alert.alert('Insufficient Credit', `Your available credit is \u20b9${availableCredit.toFixed(0)}`);
                }
              }}
            >
              <Ionicons 
                name="wallet" 
                size={24} 
                color={paymentMode === 'credit' ? '#1E88E5' : '#666'} 
              />
              <View style={styles.optionContent}>
                <Text style={[
                  styles.optionTitle,
                  paymentMode === 'credit' && styles.optionTitleActive
                ]}>Pay Later (Credit)</Text>
                <Text style={styles.optionSubtitle}>
                  Available: \u20b9{availableCredit.toFixed(0)}
                </Text>
              </View>
              <View style={[
                styles.radio,
                paymentMode === 'credit' && styles.radioActive
              ]} />
            </TouchableOpacity>
          )}
        </View>

        {/* Redeem Points */}
        {features?.loyalty_enabled && (user?.loyalty_points || 0) > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Loyalty Points</Text>
            <View style={styles.pointsCard}>
              <View style={styles.pointsInfo}>
                <Ionicons name="star" size={24} color="#FFA726" />
                <View>
                  <Text style={styles.pointsLabel}>Available Points</Text>
                  <Text style={styles.pointsValue}>{user?.loyalty_points || 0}</Text>
                </View>
              </View>
              
              <View style={styles.redeemRow}>
                <Text style={styles.redeemLabel}>Redeem Points:</Text>
                <View style={styles.redeemInput}>
                  <TouchableOpacity
                    style={styles.redeemBtn}
                    onPress={() => setRedeemPoints(Math.max(0, redeemPoints - 10))}
                  >
                    <Ionicons name="remove" size={18} color="#1E88E5" />
                  </TouchableOpacity>
                  <TextInput
                    style={styles.redeemTextInput}
                    value={String(redeemPoints)}
                    onChangeText={(text) => {
                      const num = parseInt(text) || 0;
                      setRedeemPoints(Math.min(num, user?.loyalty_points || 0, maxRedeemablePoints));
                    }}
                    keyboardType="number-pad"
                  />
                  <TouchableOpacity
                    style={styles.redeemBtn}
                    onPress={() => setRedeemPoints(Math.min(redeemPoints + 10, user?.loyalty_points || 0, maxRedeemablePoints))}
                  >
                    <Ionicons name="add" size={18} color="#1E88E5" />
                  </TouchableOpacity>
                </View>
              </View>
              
              {actualRedeemPoints > 0 && (
                <Text style={styles.pointsSavings}>
                  You'll save \u20b9{pointsDiscount.toFixed(2)}
                </Text>
              )}
            </View>
          </View>
        )}

        {/* Notes */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Order Notes (Optional)</Text>
          <TextInput
            style={styles.notesInput}
            placeholder="Any special instructions?"
            value={notes}
            onChangeText={setNotes}
            multiline
            numberOfLines={2}
          />
        </View>

        {/* Order Summary */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Order Summary</Text>
          
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Subtotal ({itemCount} items)</Text>
            <Text style={styles.summaryValue}>\u20b9{subtotal.toFixed(2)}</Text>
          </View>
          
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>GST</Text>
            <Text style={styles.summaryValue}>\u20b9{gstAmount.toFixed(2)}</Text>
          </View>
          
          {deliveryCharge > 0 && (
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Delivery Charge</Text>
              <Text style={styles.summaryValue}>\u20b9{deliveryCharge.toFixed(2)}</Text>
            </View>
          )}
          
          {pointsDiscount > 0 && (
            <View style={styles.summaryRow}>
              <Text style={[styles.summaryLabel, { color: '#43A047' }]}>Points Discount</Text>
              <Text style={[styles.summaryValue, { color: '#43A047' }]}>-\u20b9{pointsDiscount.toFixed(2)}</Text>
            </View>
          )}
          
          <View style={styles.divider} />
          
          <View style={styles.summaryRow}>
            <Text style={styles.totalLabel}>Grand Total</Text>
            <Text style={styles.totalValue}>\u20b9{grandTotal.toFixed(2)}</Text>
          </View>
        </View>

        <View style={styles.bottomPadding} />
      </ScrollView>

      {/* Place Order Button */}
      <View style={styles.footer}>
        <TouchableOpacity
          style={[styles.placeOrderButton, loading && styles.buttonDisabled]}
          onPress={handlePlaceOrder}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <>
              <Text style={styles.placeOrderText}>Place Order</Text>
              <Text style={styles.placeOrderTotal}>\u20b9{grandTotal.toFixed(2)}</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  scrollView: {
    flex: 1,
  },
  section: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginTop: 16,
    padding: 16,
    borderRadius: 12,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#333',
    marginBottom: 12,
  },
  optionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 12,
    marginBottom: 8,
  },
  optionCardActive: {
    borderColor: '#1E88E5',
    backgroundColor: '#e3f2fd',
  },
  optionCardDisabled: {
    opacity: 0.5,
  },
  optionContent: {
    flex: 1,
    marginLeft: 12,
  },
  optionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
  },
  optionTitleActive: {
    color: '#1E88E5',
  },
  optionSubtitle: {
    fontSize: 12,
    color: '#888',
    marginTop: 2,
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: '#ddd',
  },
  radioActive: {
    borderColor: '#1E88E5',
    backgroundColor: '#1E88E5',
  },
  addressInput: {
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    minHeight: 80,
    textAlignVertical: 'top',
  },
  pointsCard: {
    backgroundColor: '#FFF8E1',
    borderRadius: 8,
    padding: 16,
  },
  pointsInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
  },
  pointsLabel: {
    fontSize: 12,
    color: '#888',
  },
  pointsValue: {
    fontSize: 20,
    fontWeight: '700',
    color: '#FFA726',
  },
  redeemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  redeemLabel: {
    fontSize: 14,
    color: '#666',
  },
  redeemInput: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 8,
  },
  redeemBtn: {
    padding: 10,
  },
  redeemTextInput: {
    minWidth: 50,
    textAlign: 'center',
    fontSize: 16,
    fontWeight: '600',
  },
  pointsSavings: {
    fontSize: 13,
    color: '#43A047',
    fontWeight: '600',
    marginTop: 12,
    textAlign: 'center',
  },
  notesInput: {
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    minHeight: 60,
    textAlignVertical: 'top',
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  summaryLabel: {
    fontSize: 14,
    color: '#666',
  },
  summaryValue: {
    fontSize: 14,
    color: '#333',
  },
  divider: {
    height: 1,
    backgroundColor: '#eee',
    marginVertical: 12,
  },
  totalLabel: {
    fontSize: 16,
    fontWeight: '700',
    color: '#333',
  },
  totalValue: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1E88E5',
  },
  bottomPadding: {
    height: 20,
  },
  footer: {
    padding: 16,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#eee',
  },
  placeOrderButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1E88E5',
    height: 56,
    borderRadius: 12,
    paddingHorizontal: 24,
  },
  buttonDisabled: {
    opacity: 0.7,
    justifyContent: 'center',
  },
  placeOrderText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  placeOrderTotal: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
});
