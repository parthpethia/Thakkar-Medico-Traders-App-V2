import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  Alert,
  TextInput,
  Dimensions,
  Linking,
  Animated,
  StyleSheet,
  Platform,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { format } from 'date-fns';
import { supabase } from '../../src/services/supabase';
import { Order, OrderStatus } from '../../src/types';
import { useAuthStore } from '../../src/store/authStore';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import type { AppColors } from '../../src/theme/colors';
import { uploadDeliveryPhoto } from '../../src/utils/deliveryPhoto';
import { googleMapsDirUrl, resolveOrderCoords } from '../../src/utils/orderDeliveryCoords';
import { DeliveryFailedModal } from '../../src/components/delivery/DeliveryFailedModal';
import { ReportReturnModal } from '../../src/components/delivery/ReportReturnModal';
import { SwipeButton } from '../../src/components/delivery/SwipeButton';

/* ================= TYPES ================= */

type RawOrderItem = {
  product_id?: string;
  product_name?: string;
  name?: string;
  quantity?: number;
  qty?: number;
  selling_price?: number;
  unit_price?: number;
  price?: number;
  line_total?: number;
  gst_percent?: number;
};

type OrderItem = {
  product_id: string;
  product_name?: string;
  name?: string;
  quantity: number;
  selling_price: number;
  gst_percent?: number;
};

function normalizeOrderItems(
  rawItems: unknown,
  productById: Map<string, { name: string; selling_price: number }>,
): OrderItem[] {
  if (!Array.isArray(rawItems)) return [];

  return rawItems.map((raw) => {
    const item = raw as RawOrderItem;
    const pId = item.product_id || '';
    const product = pId ? productById.get(pId) : undefined;
    const quantity = Number(item.qty ?? item.quantity ?? 0);
    const sellingPrice = Number(
      item.unit_price ?? item.selling_price ?? item.price ?? product?.selling_price ?? 0,
    );
    const name = item.product_name ?? item.name ?? product?.name ?? 'Unknown';

    return {
      product_id: pId,
      product_name: name,
      name,
      quantity,
      selling_price: sellingPrice,
      gst_percent: item.gst_percent,
    };
  });
}

/* ================= HELPERS ================= */


const statusSteps: { key: OrderStatus; label: string }[] = [
  { key: 'assigned', label: 'Assigned' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'picked_up', label: 'Picked Up' },
  { key: 'dispatched', label: 'Dispatched' },
  { key: 'delivered', label: 'Delivered' },
];



/* ================= MAIN SCREEN ================= */

export default function DeliveryConsole() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuthStore();

  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);

  // Verification Checklist State
  const [checklist, setChecklist] = useState<Record<string, boolean>>({});



  // Proof of Delivery Photo states
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoUploaded, setPhotoUploaded] = useState(false);

  // Modals
  const [failedModalVisible, setFailedModalVisible] = useState(false);
  const [returnModalVisible, setReturnModalVisible] = useState(false);

  // Navigation loading
  const [navigating, setNavigating] = useState(false);

  const fetchOrder = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .eq('id', id)
        .single();

      if (error) throw error;
      if (!data) {
        setOrder(null);
        return;
      }

      const rawItems = Array.isArray(data.items) ? (data.items as RawOrderItem[]) : [];
      const productIds = [
        ...new Set(rawItems.map((i) => i.product_id).filter((pid): pid is string => !!pid)),
      ];

      const productById = new Map<string, { name: string; selling_price: number }>();
      if (productIds.length > 0) {
        const { data: products, error: productsError } = await supabase
          .from('products')
          .select('id, name, selling_price')
          .in('id', productIds);

        if (productsError) throw productsError;
        for (const p of products ?? []) {
          productById.set(p.id, {
            name: p.name,
            selling_price: Number(p.selling_price ?? 0),
          });
        }
      }

      const normalized = normalizeOrderItems(rawItems, productById);
      setOrder({
        ...(data as Order),
        items: normalized,
      });

      // Initialize checklist if empty
      setChecklist((prev) => {
        const next = { ...prev };
        normalized.forEach((item) => {
          if (next[item.product_id] === undefined) {
            next[item.product_id] = false;
          }
        });
        return next;
      });
    } catch (err) {
      console.error('Error fetching order details:', err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchOrder();
  }, [fetchOrder]);

  // Checklist Helpers
  const isAllChecked = useMemo(() => {
    if (!order || order.items.length === 0) return false;
    return order.items.every((item) => checklist[item.product_id]);
  }, [order, checklist]);

  const toggleChecklistItem = (productId: string) => {
    setChecklist((prev) => ({
      ...prev,
      [productId]: !prev[productId],
    }));
  };

  const checkAllItems = () => {
    if (!order) return;
    const next: Record<string, boolean> = {};
    order.items.forEach((item) => {
      next[item.product_id] = true;
    });
    setChecklist(next);
  };

  // Status transitions
  const updateStatus = async (newStatus: OrderStatus) => {
    if (!order) return;
    setUpdating(true);
    try {
      const { error } = await supabase
        .from('orders')
        .update({ status: newStatus })
        .eq('id', order.id);

      if (error) {
        if (error.message?.includes('invalid_transition') || error.code === 'P0001') {
          Alert.alert('Invalid Transition', 'This status update is not allowed.');
        } else {
          Alert.alert('Error', error.message);
        }
        return;
      }
      await fetchOrder();
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to update order status');
    } finally {
      setUpdating(false);
    }
  };

  const handleAcceptOrder = async () => {
    if (!order) return;
    setUpdating(true);
    try {
      const { error } = await supabase.rpc('delivery_accept_order', {
        p_order_id: order.id,
      });
      if (error) throw error;
      await fetchOrder();
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to accept assignment');
    } finally {
      setUpdating(false);
    }
  };

  const handleDeclineOrder = () => {
    if (!order) return;
    Alert.alert('Decline Assignment?', `Decline order #${order.order_number}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Decline',
        style: 'destructive',
        onPress: async () => {
          setUpdating(true);
          try {
            const { error } = await supabase.rpc('delivery_reject_order', {
              p_order_id: order.id,
              p_reason: null,
            });
            if (error) throw error;
            router.back();
          } catch (err: any) {
            Alert.alert('Error', err.message || 'Failed to reject assignment');
            setUpdating(false);
          }
        },
      },
    ]);
  };

  // Contacts
  const makePhoneCall = () => {
    if (!order?.user_phone) return;
    Linking.openURL(`tel:${order.user_phone.replace(/[^+\d]/g, '')}`).catch(() =>
      Alert.alert('Error', 'Could not open phone dialer')
    );
  };

  const openWhatsApp = () => {
    if (!order?.user_phone) return;
    const cleanPhone = order.user_phone.replace(/[^+\d]/g, '');
    const message = `Hello, this is your Thakkar Medico delivery partner. I am on my way to deliver your order #${order.order_number}.`;
    const url = `whatsapp://send?phone=${cleanPhone}&text=${encodeURIComponent(message)}`;
    Linking.openURL(url).catch(() =>
      Alert.alert('Error', 'Make sure WhatsApp is installed on your device')
    );
  };

  // Maps navigation
  const handleNavigate = async () => {
    if (!order || navigating) return;
    setNavigating(true);
    try {
      const coords = await resolveOrderCoords(supabase, order);
      if (!coords) {
        Alert.alert(
          'No delivery address',
          'This order has no address or location attached. Please check the order details.',
        );
        return;
      }
      const url = googleMapsDirUrl(coords.lat, coords.lng, coords.address || order?.delivery_address);
      if (!url) {
        Alert.alert(
          'Cannot navigate',
          'Could not resolve coordinates or address for this order. The address may be incomplete.',
        );
        return;
      }
      if (coords.source === 'address_fallback' && coords.lat === 0 && coords.lng === 0) {
        console.log('[Nav] Using text address fallback for navigation');
      }
      await Linking.openURL(url);
    } catch (err: any) {
      console.warn('[Nav] Navigation failed:', err);
      Alert.alert('Error', 'Could not open maps application');
    } finally {
      setNavigating(false);
    }
  };

  // Delivery confirmation handling
  const handleSwipeToDeliver = async () => {
    if (!order || updating) return;
    setUpdating(true);
    try {
      const { error } = await supabase
        .from('orders')
        .update({ status: 'delivered' })
        .eq('id', order.id);

      if (error) {
        Alert.alert('Error', error.message || 'Failed to complete delivery');
        return;
      }

      await fetchOrder();
      Alert.alert('Success', isPickup ? 'Collection completed successfully!' : 'Delivery completed successfully!');
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to complete delivery');
    } finally {
      setUpdating(false);
    }
  };

  // Proof Photo
  const handleTakePhoto = async () => {
    if (!order) return;
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Denied', 'Camera permission is required to capture photos.');
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.6,
      allowsEditing: false,
    });

    if (result.canceled || !result.assets?.[0]?.uri) return;

    const uri = result.assets[0].uri;
    setPhotoUri(uri);
    setUploadingPhoto(true);

    const uploadedUrl = await uploadDeliveryPhoto(order.id, uri);
    setUploadingPhoto(false);

    if (uploadedUrl) {
      setPhotoUploaded(true);
    } else {
      Alert.alert('Upload Failed', 'Photo upload failed. You can still complete delivery.');
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <Stack.Screen options={{ title: 'Loading...' }} />
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  if (!order) {
    return (
      <SafeAreaView style={styles.container}>
        <Stack.Screen options={{ title: 'Not Found' }} />
        <View style={styles.center}>
          <Ionicons name="alert-circle" size={64} color={colors.textMuted} />
          <Text style={styles.errorText}>Order not found</Text>
        </View>
      </SafeAreaView>
    );
  }

  const isPickup = (order as any).fulfillment_mode === 'pickup' || order.delivery_type === 'pickup';
  const currentIndex = statusSteps.findIndex((s) => s.key === order.status);
  const itemsCount = order.items.reduce((sum, item) => sum + (item.quantity || 0), 0);

  return (
    <SafeAreaView style={styles.container}>
      <Stack.Screen options={{ title: `Order #${order.order_number}` }} />

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* ================= STEPPER PROGRESS TRACK ================= */}
        <View style={styles.progressCard}>
          <View style={styles.stepperTrack}>
            {statusSteps.map((step, idx) => {
              const isCompleted = idx <= currentIndex;
              const isCurrent = step.key === order.status;
              const isLast = idx === statusSteps.length - 1;

              return (
                <View key={step.key} style={styles.stepContainer}>
                  <View style={styles.circleRow}>
                    <View
                      style={[
                        styles.stepCircle,
                        isCompleted && styles.stepCircleCompleted,
                        isCurrent && styles.stepCircleCurrent,
                      ]}
                    >
                      {isCompleted && step.key !== order.status ? (
                        <Ionicons name="checkmark" size={12} color={colors.onPrimary} />
                      ) : (
                        <Text style={[styles.stepCircleText, isCompleted && { color: colors.onPrimary }]}>
                          {idx + 1}
                        </Text>
                      )}
                    </View>
                    {!isLast && (
                      <View
                        style={[
                          styles.stepLine,
                          idx < currentIndex && styles.stepLineCompleted,
                        ]}
                      />
                    )}
                  </View>
                  <Text
                    style={[
                      styles.stepLabel,
                      isCompleted && styles.stepLabelCompleted,
                      isCurrent && styles.stepLabelCurrent,
                    ]}
                  >
                    {step.label}
                  </Text>
                </View>
              );
            })}
          </View>
        </View>

        {/* ================= RETAILER DETAILS CARD ================= */}
        <View style={styles.sectionCard}>
          <View style={styles.retailerHeader}>
            <View style={{ flex: 1 }}>
              <Text style={styles.shopName}>{order.user_name || 'Retailer'}</Text>
              <Text style={styles.orderDate}>
                {format(new Date(order.created_at), 'dd MMM yyyy, hh:mm a')}
              </Text>
            </View>
            <View style={styles.contactRow}>
              <TouchableOpacity style={styles.contactBtn} onPress={makePhoneCall}>
                <Ionicons name="call" size={20} color={colors.primary} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.contactBtn} onPress={openWhatsApp}>
                <Ionicons name="logo-whatsapp" size={20} color={colors.success} />
              </TouchableOpacity>
            </View>
          </View>

          {/* Delivery Details */}
          {!isPickup && order.delivery_address ? (
            (() => {
              const snapshot = order.delivery_snapshot as {
                shop_name?: string;
                landmark?: string;
                entry_notes?: string;
                receiver_name?: string;
                receiver_phone?: string;
                best_delivery_window?: string;
              } | null;

              return (
                <View style={styles.addressContainer}>
                  <View style={styles.infoLine}>
                    <Ionicons name="location-sharp" size={16} color={colors.primary} />
                    <Text style={styles.addressText}>{order.delivery_address}</Text>
                  </View>
                  {snapshot?.landmark && (
                    <Text style={styles.metaLine}>
                      <Text style={{ fontWeight: '700' }}>Landmark:</Text> {snapshot.landmark}
                    </Text>
                  )}
                  {snapshot?.best_delivery_window && (
                    <View style={styles.deliveryWindowAlert}>
                      <Ionicons name="time" size={16} color={colors.primary} />
                      <Text style={styles.windowText}>
                        Preferred window: {snapshot.best_delivery_window}
                      </Text>
                    </View>
                  )}
                  {snapshot?.entry_notes && (
                    <Text style={styles.notesLine}>
                      <Text style={{ fontWeight: '700' }}>Notes:</Text> {snapshot.entry_notes}
                    </Text>
                  )}
                </View>
              );
            })()
          ) : (
            <View style={styles.pickupBadgeContainer}>
              <Ionicons name="storefront" size={16} color={colors.primary} />
              <Text style={styles.pickupText}>Self Pickup Order</Text>
            </View>
          )}

          {/* Navigation GPS Trigger */}
          {order.status !== 'delivered' && order.status !== 'cancelled' && order.status !== 'delivery_failed' && !isPickup && (
            <TouchableOpacity
              style={[styles.mapsBannerBtn, navigating && { opacity: 0.6 }]}
              onPress={handleNavigate}
              disabled={navigating}
            >
              {navigating ? (
                <ActivityIndicator size="small" color={colors.onPrimary} />
              ) : (
                <Ionicons name="navigate-circle" size={22} color={colors.onPrimary} />
              )}
              <Text style={styles.mapsBannerBtnText}>
                {navigating ? 'Finding location…' : 'Get Driving Directions'}
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {/* ================= ITEMS VERIFICATION CHECKLIST ================= */}
        {order.status !== 'delivered' && order.status !== 'cancelled' && order.status !== 'delivery_failed' && (
          <View style={styles.sectionCard}>
            <View style={styles.checklistHeader}>
              <View>
                <Text style={styles.sectionTitle}>Verify Items checklist</Text>
                <Text style={styles.sectionSubtitle}>
                  Check off packages to unlock delivery swipe slider
                </Text>
              </View>
              {!isAllChecked && (
                <TouchableOpacity onPress={checkAllItems}>
                  <Text style={styles.actionLink}>Verify All</Text>
                </TouchableOpacity>
              )}
            </View>

            {order.items.map((item) => {
              const isChecked = checklist[item.product_id] || false;
              return (
                <TouchableOpacity
                  key={item.product_id}
                  style={[styles.itemCheckRow, isChecked && styles.itemCheckRowActive]}
                  onPress={() => toggleChecklistItem(item.product_id)}
                >
                  <View style={styles.checkbox}>
                    {isChecked ? (
                      <Ionicons name="checkbox" size={22} color={colors.success} />
                    ) : (
                      <Ionicons name="square-outline" size={22} color={colors.textSecondary} />
                    )}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.itemName, isChecked && styles.itemNameChecked]}>
                      {item.product_name || item.name}
                    </Text>
                    <Text style={styles.itemQuantity}>Qty: {item.quantity} units</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        {/* ================= PAYMENT HIGHLIGHT BANNER ================= */}
        <View style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>Payment Details</Text>
          <View style={styles.paymentInfoRow}>
            <View>
              <Text style={styles.paymentMethodLabel}>Payment Mode</Text>
              <Text style={styles.paymentMethodVal}>
                {order.payment_mode === 'cod' ? 'Cash on Delivery (COD)' : order.payment_mode?.toUpperCase()}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={styles.paymentTotalLabel}>Grand Total</Text>
              <Text style={styles.paymentTotalVal}>₹{(order.grand_total || 0).toFixed(2)}</Text>
            </View>
          </View>

          {/* Cash highlight */}
          {order.payment_mode === 'cod' && order.status !== 'delivered' && (
            <View style={styles.cashAlert}>
              <Ionicons name="cash" size={22} color={colors.success} />
              <View style={{ flex: 1, marginLeft: 10 }}>
                <Text style={styles.cashAlertTitle}>Collect Cash Payment</Text>
                <Text style={styles.cashAlertText}>
                  Please collect <Text style={{ fontWeight: '800' }}>₹{(order.grand_total || 0).toFixed(2)}</Text> cash from customer before handing over packages.
                </Text>
              </View>
            </View>
          )}
        </View>



        {/* ================= ORDER CLOSED/DELIVERED BANNER ================= */}
        {order.status === 'delivered' && (
          <View style={styles.deliveredBanner}>
            <Ionicons name="checkmark-done-circle" size={40} color={colors.onPrimary} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={styles.deliveredTitle}>Delivery Complete</Text>
              <Text style={styles.deliveredSubtitle}>
                This order was successfully verified and delivered.
              </Text>
            </View>
          </View>
        )}

        {order.status === 'delivery_failed' && (
          <View style={[styles.deliveredBanner, { backgroundColor: colors.error }]}>
            <Ionicons name="close-circle" size={40} color={colors.onPrimary} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={styles.deliveredTitle}>Delivery Failed</Text>
              <Text style={styles.deliveredSubtitle}>
                Reason: {order.delivery_failure_reason || 'Undelivered'}
              </Text>
            </View>
          </View>
        )}

        {/* ================= STATIC ITEM LIST RECAP ================= */}
        <View style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>Order Items Details ({itemsCount})</Text>
          {order.items.map((item, index) => {
            const unitPrice = item.selling_price || 0;
            const qty = item.quantity || 0;
            const lineTotal = unitPrice * qty;

            return (
              <View
                key={index}
                style={[
                  styles.itemDetailRow,
                  index < order.items.length - 1 && styles.itemBorder,
                ]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.itemDetailName}>{item.product_name || item.name}</Text>
                  <Text style={styles.itemDetailMeta}>
                    ₹{unitPrice.toFixed(2)} x {qty}
                  </Text>
                </View>
                <Text style={styles.itemDetailTotal}>₹{lineTotal.toFixed(2)}</Text>
              </View>
            );
          })}
        </View>

        {/* ================= ACTIONS AND SLIDERS PANEL ================= */}
        {order.status !== 'delivered' && order.status !== 'cancelled' && order.status !== 'delivery_failed' && (
          <View style={styles.actionPanelContainer}>
            {order.status === 'dispatched' && (
              <View style={styles.photoSection}>
                {photoUri ? (
                  <View style={styles.photoPreviewRow}>
                    <Image source={{ uri: photoUri }} style={styles.photoThumbnail} />
                    <View style={styles.photoStatusCol}>
                      {uploadingPhoto ? (
                        <View style={styles.photoStatusRow}>
                          <ActivityIndicator size="small" color={colors.primary} />
                          <Text style={styles.photoStatusText}>Uploading proof...</Text>
                        </View>
                      ) : photoUploaded ? (
                        <View style={styles.photoStatusRow}>
                          <Ionicons name="checkmark-circle" size={18} color={colors.success} />
                          <Text style={[styles.photoStatusText, { color: colors.success }]}>
                            Photo proof saved
                          </Text>
                        </View>
                      ) : (
                        <Text style={[styles.photoStatusText, { color: colors.error }]}>
                          Upload failed
                        </Text>
                      )}
                      <TouchableOpacity onPress={handleTakePhoto} disabled={uploadingPhoto}>
                        <Text style={styles.retakeText}>Retake Photo</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : (
                  <TouchableOpacity style={styles.takePhotoBtn} onPress={handleTakePhoto}>
                    <Ionicons name="camera" size={20} color={colors.primary} />
                    <Text style={styles.takePhotoBtnText}>Take Delivery Photo Proof (Optional)</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {order.status === 'assigned' ? (
              <View style={styles.assignedActionsRow}>
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: colors.success, flex: 1 }]}
                  disabled={updating}
                  onPress={handleAcceptOrder}
                >
                  <Text style={styles.actionBtnText}>Accept Order</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: colors.error, flex: 1 }]}
                  disabled={updating}
                  onPress={handleDeclineOrder}
                >
                  <Text style={styles.actionBtnText}>Decline</Text>
                </TouchableOpacity>
              </View>
            ) : order.status === 'accepted' ? (
              <SwipeButton
                title="Swipe to Confirm Pickup"
                colors={colors}
                onSwipeSuccess={() => updateStatus('picked_up')}
                disabled={updating}
              />
            ) : order.status === 'picked_up' ? (
              <SwipeButton
                title="Swipe to Start Trip"
                colors={colors}
                onSwipeSuccess={() => updateStatus('dispatched')}
                disabled={updating}
              />
            ) : order.status === 'dispatched' ? (
              <SwipeButton
                title={isPickup ? 'Swipe to Collect' : 'Swipe to Deliver'}
                colors={colors}
                onSwipeSuccess={handleSwipeToDeliver}
                disabled={updating || !isAllChecked || uploadingPhoto}
              />
            ) : null}

            {/* Unable to deliver options */}
            {order.status === 'dispatched' && (
              <TouchableOpacity
                style={styles.unableBtn}
                onPress={() => setFailedModalVisible(true)}
              >
                <Ionicons name="alert-circle" size={16} color={colors.error} />
                <Text style={styles.unableBtnText}>Unable to Deliver / Can't Complete</Text>
              </TouchableOpacity>
            )}

            {/* Items Adjustment exceptions */}
            {['assigned', 'accepted'].includes(order.status) && (
              <TouchableOpacity
                style={styles.editBtn}
                onPress={() => router.push(`/delivery/edit-order?orderId=${order.id}`)}
              >
                <Ionicons name="create" size={16} color={colors.primary} />
                <Text style={styles.editBtnText}>Edit Order Items</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </ScrollView>

      {/* ================= MODALS ================= */}
      <DeliveryFailedModal
        visible={failedModalVisible}
        order={order}
        onClose={() => setFailedModalVisible(false)}
        onSuccess={() => {
          setFailedModalVisible(false);
          void fetchOrder();
        }}
        showToast={(msg) => Alert.alert('Status Update', msg)}
      />

      <ReportReturnModal
        visible={returnModalVisible}
        order={order}
        onClose={() => setReturnModalVisible(false)}
        onSuccess={() => {
          setReturnModalVisible(false);
          void fetchOrder();
        }}
        showToast={(msg) => Alert.alert('Return Alert', msg)}
      />
    </SafeAreaView>
  );
}

/* ================= STYLES ================= */

function createStyles(c: AppColors, isDark: boolean) {
  return {
    container: {
      flex: 1,
      backgroundColor: isDark ? '#121218' : '#F4F5F8',
    },
    center: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    errorText: {
      fontSize: 16,
      color: c.textMuted,
      marginTop: 12,
    },
    scrollContent: {
      paddingBottom: 48,
    },
    /* Progress track */
    progressCard: {
      backgroundColor: '#131921', // Amazon Dark Navy
      paddingVertical: 18,
      paddingHorizontal: 12,
      borderBottomWidth: 1,
      borderColor: '#232F3E',
    },
    stepperTrack: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
    },
    stepContainer: {
      alignItems: 'center',
      flex: 1,
    },
    circleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      width: '100%',
    },
    stepCircle: {
      width: 24,
      height: 24,
      borderRadius: 12,
      borderWidth: 2,
      borderColor: '#FF9900', // Amazon Gold
      backgroundColor: '#131921',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 2,
    },
    stepCircleCompleted: {
      backgroundColor: '#FF9900',
      borderColor: '#FF9900',
    },
    stepCircleCurrent: {
      backgroundColor: '#131921',
      borderColor: '#FF9900',
      transform: [{ scale: 1.15 }],
    },
    stepCircleText: {
      fontSize: 10,
      fontWeight: '800',
      color: '#FF9900',
    },
    stepLine: {
      flex: 1,
      height: 2,
      backgroundColor: '#232F3E',
      position: 'absolute',
      left: '50%',
      right: '-50%',
      top: 11,
      zIndex: 1,
    },
    stepLineCompleted: {
      backgroundColor: '#FF9900',
    },
    stepLabel: {
      fontSize: 8.5,
      color: '#888',
      fontWeight: '600',
      marginTop: 6,
      textAlign: 'center',
      textTransform: 'uppercase',
      letterSpacing: 0.2,
    },
    stepLabelCompleted: {
      color: '#FF9900',
    },
    stepLabelCurrent: {
      color: '#FFFFFF',
      fontWeight: '800',
    },

    /* Section Cards */
    sectionCard: {
      backgroundColor: c.surface,
      marginHorizontal: 16,
      marginTop: 14,
      borderRadius: 16,
      padding: 16,
      borderWidth: 1.5,
      borderColor: c.border,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: isDark ? 0.25 : 0.04,
      shadowRadius: 6,
      elevation: 2,
    },
    sectionTitle: {
      fontSize: 15,
      fontWeight: '800',
      color: c.text,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginBottom: 8,
    },
    sectionSubtitle: {
      fontSize: 12,
      color: c.textSecondary,
      marginTop: -4,
      marginBottom: 12,
      fontWeight: '500',
    },

    /* Retailer Details */
    retailerHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      borderBottomWidth: 1,
      borderColor: c.borderLight,
      paddingBottom: 12,
      marginBottom: 12,
    },
    shopName: {
      fontSize: 18,
      fontWeight: '800',
      color: c.text,
    },
    orderDate: {
      fontSize: 12,
      color: c.textSecondary,
      marginTop: 4,
    },
    contactRow: {
      flexDirection: 'row',
      gap: 10,
    },
    contactBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: c.primaryMuted,
      alignItems: 'center',
      justifyContent: 'center',
    },
    addressContainer: {
      gap: 8,
    },
    infoLine: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 8,
    },
    addressText: {
      fontSize: 14,
      color: c.text,
      lineHeight: 20,
      flex: 1,
      fontWeight: '600',
    },
    metaLine: {
      fontSize: 13,
      color: c.textSecondary,
      paddingLeft: 24,
    },
    notesLine: {
      fontSize: 12.5,
      color: c.textSecondary,
      fontStyle: 'italic',
      paddingLeft: 24,
      marginTop: 2,
    },
    deliveryWindowAlert: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: c.primaryMuted,
      padding: 10,
      borderRadius: 8,
      marginLeft: 24,
      marginTop: 4,
    },
    windowText: {
      fontSize: 12.5,
      color: c.text,
      fontWeight: '700',
    },
    pickupBadgeContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: c.primaryMuted,
      padding: 12,
      borderRadius: 10,
    },
    pickupText: {
      fontSize: 14,
      fontWeight: '700',
      color: c.primary,
    },
    mapsBannerBtn: {
      backgroundColor: c.primary,
      borderRadius: 12,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 12,
      gap: 8,
      marginTop: 14,
      shadowColor: c.primary,
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.2,
      shadowRadius: 4,
      elevation: 2,
    },
    mapsBannerBtnText: {
      color: c.onPrimary,
      fontSize: 14,
      fontWeight: '800',
    },

    /* Checklist */
    checklistHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      marginBottom: 10,
    },
    actionLink: {
      fontSize: 13,
      fontWeight: '700',
      color: c.primary,
    },
    itemCheckRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 12,
      paddingHorizontal: 10,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: c.border,
      marginBottom: 8,
      backgroundColor: c.background,
    },
    itemCheckRowActive: {
      borderColor: c.success,
      backgroundColor: c.successMuted,
    },
    checkbox: {
      justifyContent: 'center',
      alignItems: 'center',
    },
    itemName: {
      fontSize: 14,
      fontWeight: '600',
      color: c.text,
    },
    itemNameChecked: {
      color: c.success,
      textDecorationLine: 'line-through' as const,
    },
    itemQuantity: {
      fontSize: 12,
      color: c.textSecondary,
      marginTop: 2,
    },

    /* Payment Details */
    paymentInfoRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 12,
    },
    paymentMethodLabel: {
      fontSize: 12,
      color: c.textSecondary,
      fontWeight: '500',
    },
    paymentMethodVal: {
      fontSize: 14,
      fontWeight: '800',
      color: c.text,
      marginTop: 2,
    },
    paymentTotalLabel: {
      fontSize: 12,
      color: c.textSecondary,
      fontWeight: '500',
    },
    paymentTotalVal: {
      fontSize: 18,
      fontWeight: '900',
      color: c.primary,
      marginTop: 2,
    },
    cashAlert: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      backgroundColor: c.successMuted,
      borderWidth: 1.5,
      borderColor: c.success,
      padding: 12,
      borderRadius: 12,
      marginTop: 6,
    },
    cashAlertTitle: {
      fontSize: 14,
      fontWeight: '800',
      color: c.success,
      marginBottom: 2,
    },
    cashAlertText: {
      fontSize: 12.5,
      color: c.textSecondary,
      lineHeight: 18,
    },

    /* OTP Verification Panel */
    otpPanelCard: {
      borderColor: c.primary,
      borderWidth: 2,
      backgroundColor: isDark ? '#1C1C29' : '#F9F9FF',
    },
    otpHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginBottom: 8,
    },
    otpTitle: {
      fontSize: 16,
      fontWeight: '800',
      color: c.primary,
    },
    otpSubtitle: {
      fontSize: 13,
      color: c.textSecondary,
      lineHeight: 18,
      marginBottom: 14,
    },
    photoSection: {
      marginBottom: 14,
    },
    takePhotoBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingVertical: 12,
      paddingHorizontal: 14,
      borderWidth: 1.5,
      borderColor: c.primary,
      borderRadius: 12,
      borderStyle: 'dashed' as const,
    },
    takePhotoBtnText: {
      fontSize: 13,
      color: c.primary,
      fontWeight: '700',
    },
    photoPreviewRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    photoThumbnail: {
      width: 60,
      height: 60,
      borderRadius: 10,
      backgroundColor: c.background,
    },
    photoStatusCol: {
      flex: 1,
      gap: 4,
    },
    photoStatusRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    photoStatusText: {
      fontSize: 12,
      color: c.textSecondary,
    },
    retakeText: {
      fontSize: 12.5,
      color: c.primary,
      fontWeight: '700',
    },
    sendStatusText: {
      fontSize: 12.5,
      color: c.success,
      fontWeight: '600',
      marginBottom: 6,
    },
    sendWarningText: {
      fontSize: 12.5,
      color: c.warning,
      lineHeight: 18,
      marginBottom: 6,
    },
    otpRow: {
      flexDirection: 'row',
      justifyContent: 'center',
      gap: 12,
      marginVertical: 16,
    },
    otpBox: {
      width: 50,
      height: 54,
      borderWidth: 2,
      borderColor: c.primary,
      borderRadius: 10,
      textAlign: 'center' as const,
      fontSize: 20,
      fontWeight: '800',
      color: c.text,
      backgroundColor: c.surface,
    },
    otpBoxDisabled: {
      borderColor: c.textMuted,
      backgroundColor: c.borderLight,
      color: c.textMuted,
    },
    verifyErrorText: {
      fontSize: 13,
      color: c.error,
      textAlign: 'center' as const,
      fontWeight: '600',
      marginBottom: 10,
    },
    confirmOtpBtn: {
      backgroundColor: c.success,
      borderRadius: 12,
      paddingVertical: 14,
      alignItems: 'center',
    },
    confirmOtpBtnDisabled: {
      opacity: 0.5,
    },
    confirmOtpBtnText: {
      color: '#FFF',
      fontWeight: '800',
      fontSize: 14,
      textTransform: 'uppercase' as const,
    },
    resendLink: {
      alignItems: 'center',
      marginTop: 14,
      paddingVertical: 6,
    },
    resendLinkText: {
      color: c.primary,
      fontSize: 13,
      fontWeight: '700',
    },

    /* Delivered Close Banner */
    deliveredBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.success,
      marginHorizontal: 16,
      marginTop: 14,
      borderRadius: 16,
      padding: 16,
    },
    deliveredTitle: {
      color: '#FFF',
      fontSize: 16,
      fontWeight: '800',
    },
    deliveredSubtitle: {
      color: 'rgba(255, 255, 255, 0.85)',
      fontSize: 13,
      marginTop: 4,
      lineHeight: 18,
    },

    /* Item Details List */
    itemDetailRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 12,
    },
    itemBorder: {
      borderBottomWidth: 1,
      borderColor: c.borderLight,
    },
    itemDetailName: {
      fontSize: 14,
      fontWeight: '600',
      color: c.text,
    },
    itemDetailMeta: {
      fontSize: 12,
      color: c.textMuted,
      marginTop: 2,
    },
    itemDetailTotal: {
      fontSize: 14,
      fontWeight: '700',
      color: c.text,
    },

    /* Actions Panel */
    actionPanelContainer: {
      marginHorizontal: 16,
      marginTop: 20,
      gap: 12,
    },
    assignedActionsRow: {
      flexDirection: 'row',
      gap: 12,
    },
    actionBtn: {
      borderRadius: 12,
      paddingVertical: 14,
      alignItems: 'center',
      justifyContent: 'center',
    },
    actionBtnText: {
      color: '#FFF',
      fontWeight: '800',
      fontSize: 14,
      textTransform: 'uppercase' as const,
    },
    unableBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      borderWidth: 1.5,
      borderColor: c.error,
      borderRadius: 12,
      paddingVertical: 12,
      marginTop: 4,
    },
    unableBtnText: {
      color: c.error,
      fontSize: 13.5,
      fontWeight: '700',
    },
    editBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      borderWidth: 1.5,
      borderColor: c.border,
      borderRadius: 12,
      paddingVertical: 12,
    },
    editBtnText: {
      color: c.textSecondary,
      fontSize: 13.5,
      fontWeight: '700',
    },
  } as const;
}
