/**
 * Active Delivery Screen — Delivery Person Primary Workflow
 *
 * Automatic on mount:
 * 1. Calls get_active_order_for_rider(rider_id) -> loads single active order.
 * 2. Starts GPS broadcasting via riderLocationService.startOrderTracking(orderId, riderId).
 * 3. Shows persistent top status bar: "📍 Sharing your location · Order #[X]".
 *
 * Layout:
 * - A. Top ~42%: RiderMiniMap Leaflet WebView (rider blue dot, red shop pin, OSRM route, tap opens navigation).
 * - B. Bottom ~58%: Scrollable Delivery Card with status chips, ETA (60s refresh), shop info, SLA warning, receiver contact, order summary.
 * - 3 Action Buttons:
 *   1. Navigate (Google Maps deep link priority).
 *   2. Mark as Delivered (ProofOfDeliverySheet).
 *   3. Could Not Deliver (FailedDeliverySheet).
 */
import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Linking,
  ActivityIndicator,
  Alert,
  Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';

import { supabase } from '../../src/services/supabase';
import { useAuthStore } from '../../src/store/authStore';
import {
  startOrderTracking,
  stopOrderTracking,
  getTrackingBatteryLevel,
} from '../../src/services/riderLocationService';
import {
  fetchRoute,
  calculateDistance,
  formatETA,
  type RouteResult,
} from '../../src/services/routesApiService';
import { checkGeofence } from '../../src/services/geofenceService';
import { RiderMiniMap, type RiderMiniMapRef } from '../../src/components/delivery/RiderMiniMap';
import { ProofOfDeliverySheet } from '../../src/components/delivery/ProofOfDeliverySheet';
import { FailedDeliverySheet } from '../../src/components/delivery/FailedDeliverySheet';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

interface ActiveOrderBundle {
  order: {
    id: string;
    order_number: string;
    user_id: string;
    user_name: string;
    user_phone: string;
    status: string;
    delivery_status: string;
    payment_mode: string;
    grand_total: number;
    subtotal: number;
    gst: number;
    notes?: string;
    delivery_address?: string;
    dispatched_at?: string;
    created_at: string;
    delivery_snapshot?: Record<string, unknown>;
  };
  delivery_snapshot: {
    shop_name?: string;
    full_address?: string;
    landmark?: string;
    receiver_name?: string;
    receiver_phone?: string;
    best_delivery_window?: string;
    preferred_window?: string;
    lat?: number;
    lng?: number;
  };
  items_summary: {
    count: number;
    total: number;
    items?: any[];
  };
  rider_name?: string;
  rider_phone?: string;
}

/**
 * Check if the calculated arrival timestamp will exceed the preferred delivery window end time.
 */
function checkSlaBreach(etaSeconds: number | null, windowStr?: string): boolean {
  if (!etaSeconds || !windowStr || windowStr.trim() === '') return false;

  try {
    const arrivalTimeMs = Date.now() + etaSeconds * 1000;
    const clean = windowStr.replace(/–/g, '-');
    const parts = clean.split('-');
    if (parts.length < 2) return false;

    const endPart = parts[1].trim();
    const match = endPart.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i);
    if (!match) return false;

    let hour = parseInt(match[1], 10);
    const minute = match[2] ? parseInt(match[2], 10) : 0;
    const meridian = (match[3] || '').toUpperCase();

    if (meridian === 'PM' && hour < 12) hour += 12;
    if (meridian === 'AM' && hour === 12) hour = 0;

    const windowEndDate = new Date();
    windowEndDate.setHours(hour, minute, 0, 0);

    return arrivalTimeMs > windowEndDate.getTime();
  } catch {
    return false;
  }
}

/**
 * Geocodes an address string using OpenStreetMap Nominatim as fallback when no lat/lng exists.
 */
async function geocodeAddressWithNominatim(address: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const cleanAddress = address.trim();
    if (!cleanAddress) return null;
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
      cleanAddress + ', Nagpur, Maharashtra, India',
    )}&format=json&limit=1`;
    const res = await fetch(url, { headers: { 'User-Agent': 'ThakkarMedicoDeliveryApp/1.0' } });
    if (!res.ok) return null;
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      const lat = parseFloat(data[0].lat);
      const lng = parseFloat(data[0].lon);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        return { lat, lng };
      }
    }
  } catch (err) {
    console.warn('[ActiveDelivery] Nominatim geocode fallback warning:', err);
  }
  return null;
}

export default function ActiveDeliveryScreen() {
  const { orderId: paramOrderId } = useLocalSearchParams<{ orderId?: string }>();
  const router = useRouter();
  const { user } = useAuthStore();
  const mapRef = useRef<RiderMiniMapRef>(null);

  // Screen State
  const [loading, setLoading] = useState(true);
  const [activeBundle, setActiveBundle] = useState<ActiveOrderBundle | null>(null);
  const [riderCoords, setRiderCoords] = useState<{ lat: number; lng: number; heading: number | null } | null>(null);
  const [destCoords, setDestCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [routeResult, setRouteResult] = useState<RouteResult | null>(null);
  const [batteryLevel, setBatteryLevel] = useState<number | null>(null);
  const [geofenceArrived, setGeofenceArrived] = useState(false);

  // Sheets & Full-screen overlays
  const [showProofSheet, setShowProofSheet] = useState(false);
  const [showFailedSheet, setShowFailedSheet] = useState(false);
  const [isDeliveredSuccess, setIsDeliveredSuccess] = useState(false);
  const [deliveredPhotoUrl, setDeliveredPhotoUrl] = useState<string | null>(null);
  const [deliveredTimeStr, setDeliveredTimeStr] = useState<string>('');
  const [isFailedState, setIsFailedState] = useState(false);
  const [failedReasonText, setFailedReasonText] = useState<string>('');

  // Location subscriber reference
  const locationWatchRef = useRef<Location.LocationSubscription | null>(null);

  // ─── 1. Fetch active order for this rider ─────────────────────────────────
  const loadActiveOrder = useCallback(async () => {
    if (!user) return;
    setLoading(true);

    try {
      let bundleData: any = null;

      // If orderId was passed explicitly, verify/fetch that order first
      if (paramOrderId) {
        const { data: directOrder } = await supabase
          .from('orders')
          .select('*')
          .eq('id', paramOrderId)
          .single();

        if (directOrder) {
          const snapshot = (directOrder.delivery_snapshot || {}) as any;
          const itemsArr = Array.isArray(directOrder.items) ? directOrder.items : [];
          bundleData = {
            order: directOrder,
            delivery_snapshot: snapshot,
            items_summary: {
              count: itemsArr.length || 1,
              total: directOrder.grand_total || directOrder.subtotal || 0,
              items: itemsArr,
            },
            rider_name: user.name || 'Delivery Partner',
            rider_phone: user.phone || '',
          };
        }
      }

      // If no explicit order or not found, call get_active_order_for_rider RPC
      if (!bundleData) {
        const { data: rpcData, error: rpcErr } = await supabase.rpc('get_active_order_for_rider', {
          p_rider_id: user.id,
        });

        if (rpcErr) {
          console.warn('[ActiveDelivery] get_active_order_for_rider RPC error:', rpcErr);
        } else if (rpcData) {
          bundleData = rpcData;
        }
      }

      if (!bundleData || !bundleData.order) {
        setActiveBundle(null);
        setLoading(false);
        return;
      }

      setActiveBundle(bundleData);

      // Check terminal statuses
      if (
        bundleData.order.status === 'delivered' ||
        bundleData.order.delivery_status === 'delivered'
      ) {
        setIsDeliveredSuccess(true);
        setDeliveredTimeStr(
          bundleData.order.delivered_at
            ? new Date(bundleData.order.delivered_at).toLocaleTimeString('en-IN', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: true,
              })
            : 'Delivered',
        );
      } else if (
        bundleData.order.status === 'delivery_failed' ||
        bundleData.order.delivery_status === 'failed'
      ) {
        setIsFailedState(true);
        setFailedReasonText(bundleData.order.failed_reason || 'Could not complete delivery');
      }

      // ─── Resolve Destination Coordinates ─────────────────────────────────
      const snap = bundleData.delivery_snapshot || {};
      let destLat = snap.lat ? Number(snap.lat) : 0;
      let destLng = snap.lng ? Number(snap.lng) : 0;

      // Fallback: If no coordinates stored in delivery_snapshot, call Nominatim
      if (!destLat || !destLng || (destLat === 0 && destLng === 0)) {
        const addr = snap.full_address || snap.address || bundleData.order.delivery_address || '';
        const geocoded = await geocodeAddressWithNominatim(addr);
        if (geocoded) {
          destLat = geocoded.lat;
          destLng = geocoded.lng;
        } else {
          // Default fallback coords within Nagpur city center
          destLat = 21.1458;
          destLng = 79.0882;
        }
      }

      setDestCoords({ lat: destLat, lng: destLng });

      // ─── Start High-Accuracy GPS Broadcasting ─────────────────────────────
      const startResult = await startOrderTracking(bundleData.order.id, user.id);
      if (!startResult.success) {
        console.warn('[ActiveDelivery] startOrderTracking warning:', startResult.error);
      }

      // Local initial position
      try {
        const currentPos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.High,
        });
        setRiderCoords({
          lat: currentPos.coords.latitude,
          lng: currentPos.coords.longitude,
          heading: currentPos.coords.heading ?? null,
        });
      } catch {
        // Use default store coords until watchPosition updates
        setRiderCoords({ lat: 21.1434, lng: 79.0849, heading: 0 });
      }

      setBatteryLevel(getTrackingBatteryLevel());
    } catch (err: unknown) {
      console.warn('[ActiveDelivery] Error loading active order:', err);
    } finally {
      setLoading(false);
    }
  }, [user, paramOrderId]);

  useEffect(() => {
    void loadActiveOrder();

    return () => {
      if (locationWatchRef.current) {
        locationWatchRef.current.remove();
        locationWatchRef.current = null;
      }
    };
  }, [loadActiveOrder]);

  // ─── 2. Watch rider local position for UI updates & mini-map lerping ───────
  useEffect(() => {
    let sub: Location.LocationSubscription | null = null;

    async function subscribeLocalPosition() {
      try {
        sub = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.High,
            timeInterval: 3000,
            distanceInterval: 5,
          },
          (loc) => {
            const { latitude, longitude, heading } = loc.coords;
            setRiderCoords({ lat: latitude, lng: longitude, heading: heading ?? null });
            setBatteryLevel(getTrackingBatteryLevel());

            mapRef.current?.updateRiderPosition(latitude, longitude, heading ?? null);

            // Geofence check against destination (500m)
            if (destCoords) {
              const arrived = checkGeofence(latitude, longitude, destCoords.lat, destCoords.lng);
              if (arrived && !geofenceArrived) {
                setGeofenceArrived(true);
              }
            }
          },
        );
        locationWatchRef.current = sub;
      } catch (err) {
        console.warn('[ActiveDelivery] Local position watcher error:', err);
      }
    }

    if (activeBundle && !isDeliveredSuccess && !isFailedState) {
      void subscribeLocalPosition();
    }

    return () => {
      if (sub) sub.remove();
    };
  }, [activeBundle, destCoords, geofenceArrived, isDeliveredSuccess, isFailedState]);

  // ─── 3. Fetch OSRM Route (Primary) and refresh every 60s ───────────────────
  const fetchAndDrawRoute = useCallback(async () => {
    if (!riderCoords || !destCoords || isDeliveredSuccess || isFailedState) return;

    try {
      const res = await fetchRoute(
        { lat: riderCoords.lat, lng: riderCoords.lng },
        { lat: destCoords.lat, lng: destCoords.lng },
      );

      if (res && res.polylineCoords.length > 0) {
        setRouteResult(res);
        mapRef.current?.updateRouteCoords(res.polylineCoords);
      }
    } catch (err) {
      console.warn('[ActiveDelivery] Route fetch error:', err);
    }
  }, [riderCoords, destCoords, isDeliveredSuccess, isFailedState]);

  // Route fetch on coordinates ready
  useEffect(() => {
    if (riderCoords && destCoords && !routeResult) {
      void fetchAndDrawRoute();
    }
  }, [riderCoords, destCoords, routeResult, fetchAndDrawRoute]);

  // 60-second periodic route & ETA refresh
  useEffect(() => {
    if (!riderCoords || !destCoords || isDeliveredSuccess || isFailedState) return;

    const interval = setInterval(() => {
      void fetchAndDrawRoute();
    }, 60000);

    return () => clearInterval(interval);
  }, [riderCoords, destCoords, isDeliveredSuccess, isFailedState, fetchAndDrawRoute]);

  // ─── 4. Navigate Action (Google Maps deep link priority) ───────────────────
  const handleOpenNavigation = async () => {
    if (!destCoords) {
      Alert.alert('Location Error', 'Destination coordinates are not available.');
      return;
    }

    const rLat = riderCoords ? riderCoords.lat : 21.1434;
    const rLng = riderCoords ? riderCoords.lng : 79.0849;
    const dLat = destCoords.lat;
    const dLng = destCoords.lng;

    // Deep link priority:
    // a. Google Maps app scheme
    // b. Web URL fallback
    const nativeGoogleMapsUrl = `comgooglemaps://?saddr=${rLat},${rLng}&daddr=${dLat},${dLng}&directionsmode=driving`;
    const webGoogleMapsUrl = `https://www.google.com/maps/dir/?api=1&origin=${rLat},${rLng}&destination=${dLat},${dLng}&travelmode=driving`;

    try {
      const canOpenNative = await Linking.canOpenURL(nativeGoogleMapsUrl);
      if (canOpenNative) {
        await Linking.openURL(nativeGoogleMapsUrl);
      } else {
        await Linking.openURL(webGoogleMapsUrl);
      }
    } catch {
      await Linking.openURL(webGoogleMapsUrl).catch(() => {
        Alert.alert('Navigation', `Destination: ${dLat}, ${dLng}`);
      });
    }
  };

  // ─── 5. Call Receiver Action ───────────────────────────────────────────────
  const handleCallReceiver = () => {
    const phone = activeBundle?.delivery_snapshot?.receiver_phone || activeBundle?.order?.user_phone;
    if (!phone) {
      Alert.alert('No Phone', 'Receiver phone number is not available.');
      return;
    }
    const cleanPhone = phone.replace(/[^+\d]/g, '');
    Linking.openURL(`tel:${cleanPhone}`).catch(() => {
      Alert.alert('Call Failed', `Could not dial phone: ${phone}`);
    });
  };

  // ─── 6. Delivery Completed Callback ────────────────────────────────────────
  const handleDeliveredSuccess = (photoUrl: string | null) => {
    setShowProofSheet(false);
    setIsDeliveredSuccess(true);
    setDeliveredPhotoUrl(photoUrl);
    setDeliveredTimeStr(
      new Date().toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      }),
    );
  };

  // ─── 7. Delivery Failed Callback ───────────────────────────────────────────
  const handleFailedComplete = (reason: string) => {
    setShowFailedSheet(false);
    setIsFailedState(true);
    setFailedReasonText(reason);
  };

  // ─── Render: Loading State ────────────────────────────────────────────────
  if (loading) {
    return (
      <SafeAreaView style={styles.centerContainer}>
        <Stack.Screen options={{ headerShown: false }} />
        <ActivityIndicator size="large" color="#1565C0" />
        <Text style={styles.loadingText}>Loading active delivery…</Text>
      </SafeAreaView>
    );
  }

  // ─── Render: Clean Empty State (No active delivery assigned) ───────────────
  if (!activeBundle) {
    return (
      <SafeAreaView style={styles.centerContainer}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.emptyIconCircle}>
          <Ionicons name="checkmark-done-circle-outline" size={54} color="#1565C0" />
        </View>
        <Text style={styles.emptyTitle}>No Active Delivery Assigned</Text>
        <Text style={styles.emptySubtitle}>
          You have no active orders in transit. Check the delivery dashboard for newly assigned orders.
        </Text>
        <TouchableOpacity style={styles.primaryBackBtn} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={18} color="#FFFFFF" />
          <Text style={styles.primaryBackBtnText}>Go back to Dashboard</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  const { order, delivery_snapshot, items_summary } = activeBundle;
  const shopName = delivery_snapshot.shop_name || order.user_name || 'Retailer Shop';
  const fullAddress = delivery_snapshot.full_address || order.delivery_address || 'Nagpur';
  const landmark = delivery_snapshot.landmark || '';
  const receiverName = delivery_snapshot.receiver_name || order.user_name || 'Retailer';
  const receiverPhone = delivery_snapshot.receiver_phone || order.user_phone || '';
  const preferredWindow = delivery_snapshot.best_delivery_window || delivery_snapshot.preferred_window || '';
  const isSlaBreached = checkSlaBreach(routeResult?.durationSeconds ?? null, preferredWindow);

  const etaInfo = routeResult ? formatETA(routeResult.durationSeconds) : null;
  const remainingDistanceKm = routeResult ? (routeResult.distanceMeters / 1000).toFixed(1) : '—';

  // ─── Render: Full-screen Delivered State ──────────────────────────────────
  if (isDeliveredSuccess) {
    return (
      <SafeAreaView style={styles.deliveredSuccessOverlay}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.deliveredSuccessCard}>
          <Text style={styles.deliveredCheckIcon}>✅</Text>
          <Text style={styles.deliveredSuccessTitle}>Delivery Complete!</Text>
          <Text style={styles.deliveredSuccessShop}>{shopName}</Text>
          <Text style={styles.deliveredSuccessTime}>Delivered at {deliveredTimeStr || 'Just now'}</Text>

          <Text style={styles.deliveredCheersText}>Great job! 🎉</Text>

          <TouchableOpacity style={styles.deliveredReturnBtn} onPress={() => router.back()}>
            <Text style={styles.deliveredReturnBtnText}>Back to Dashboard</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ─── Render: Full-screen Failed State ─────────────────────────────────────
  if (isFailedState) {
    return (
      <SafeAreaView style={styles.failedOverlay}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.failedCard}>
          <Text style={styles.failedIcon}>❌</Text>
          <Text style={styles.failedTitle}>Marked as Failed</Text>
          <Text style={styles.failedReasonHeading}>Reason:</Text>
          <Text style={styles.failedReasonBody}>{failedReasonText || 'Shop closed / unreachable'}</Text>
          <Text style={styles.failedAdminNote}>Admin has been notified.</Text>

          <TouchableOpacity style={styles.failedReturnBtn} onPress={() => router.back()}>
            <Text style={styles.failedReturnBtnText}>Back to Dashboard</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ─── Render: Active Delivery View ─────────────────────────────────────────
  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* ─── Persistent Top Status Bar ─────────────────────────────────────── */}
      <View style={styles.topBroadcastBar}>
        <View style={styles.broadcastLeft}>
          <View style={styles.liveBroadcastDot} />
          <Text style={styles.broadcastText} numberOfLines={1}>
            📍 Sharing your location · Order #{order.order_number}
          </Text>
        </View>
        {batteryLevel != null && (
          <View style={styles.batteryBadge}>
            <Ionicons
              name={batteryLevel < 15 ? 'battery-dead' : 'battery-charging'}
              size={14}
              color={batteryLevel < 15 ? '#EF4444' : '#10B981'}
            />
            <Text
              style={[
                styles.batteryText,
                batteryLevel < 15 && { color: '#EF4444', fontWeight: '800' },
              ]}
            >
              {batteryLevel}%
            </Text>
          </View>
        )}
      </View>

      {/* ─── A. Mini Map (Top Half ~42% Height) ─────────────────────────────── */}
      <View style={styles.mapSection}>
        <RiderMiniMap
          ref={mapRef}
          riderLat={riderCoords?.lat || 21.1434}
          riderLng={riderCoords?.lng || 79.0849}
          destLat={destCoords?.lat || 21.1458}
          destLng={destCoords?.lng || 79.0882}
          destShopName={shopName}
          destAddress={fullAddress}
          routeCoords={routeResult?.polylineCoords}
          onNavigatePress={handleOpenNavigation}
        />
      </View>

      {/* ─── B. Delivery Card (Bottom Half ~58% Scrollable) ──────────────────── */}
      <ScrollView style={styles.cardSection} contentContainerStyle={styles.cardContent} showsVerticalScrollIndicator={false}>
        {/* Status Chip Row */}
        <View style={styles.statusChipsRow}>
          <View style={[styles.statusChip, styles.statusChipActive]}>
            <Text style={styles.statusChipTextActive}>🔵 In Transit</Text>
          </View>
          <Ionicons name="arrow-forward" size={14} color="#94A3B8" />
          <View style={[styles.statusChip, geofenceArrived && styles.statusChipActive]}>
            <Text style={geofenceArrived ? styles.statusChipTextActive : styles.statusChipTextMuted}>
              🔔 Arriving Soon
            </Text>
          </View>
          <Ionicons name="arrow-forward" size={14} color="#94A3B8" />
          <View style={styles.statusChip}>
            <Text style={styles.statusChipTextMuted}>✅ Delivered</Text>
          </View>
        </View>

        {/* ETA Row */}
        <View style={styles.etaRowCard}>
          <Ionicons name="time" size={20} color="#1565C0" />
          <Text style={styles.etaRowText}>
            {etaInfo
              ? `~${etaInfo.arrivalTime}  ·  ${etaInfo.minutesRemaining} min  ·  ${remainingDistanceKm} km remaining`
              : 'Calculating fastest route…'}
          </Text>
        </View>

        {/* SLA Breach Alert */}
        {isSlaBreached && (
          <View style={styles.slaAlertBanner}>
            <Ionicons name="warning-outline" size={16} color="#D97706" />
            <Text style={styles.slaAlertText}>⚠️ Past preferred window ({preferredWindow})</Text>
          </View>
        )}

        {/* Shop Details Block */}
        <View style={styles.shopCard}>
          <View style={styles.shopHeaderRow}>
            <Ionicons name="storefront" size={20} color="#1565C0" />
            <Text style={styles.shopNameText}>{shopName}</Text>
          </View>
          <Text style={styles.shopAddressText}>📍 {fullAddress}</Text>
          {landmark ? <Text style={styles.landmarkText}>🏢 Landmark: {landmark}</Text> : null}
          {preferredWindow ? (
            <Text style={styles.windowText}>🕐 Preferred: {preferredWindow}</Text>
          ) : null}
        </View>

        {/* Receiver Block */}
        <View style={styles.receiverCard}>
          <View style={styles.receiverInfo}>
            <Ionicons name="person-circle-outline" size={24} color="#0F766E" />
            <View>
              <Text style={styles.receiverNameText}>{receiverName}</Text>
              <Text style={styles.receiverPhoneText}>{receiverPhone || 'No phone provided'}</Text>
            </View>
          </View>
          {receiverPhone ? (
            <TouchableOpacity style={styles.callReceiverBtn} onPress={handleCallReceiver} activeOpacity={0.8}>
              <Ionicons name="call" size={16} color="#FFFFFF" />
              <Text style={styles.callReceiverBtnText}>Call</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {/* Order Summary Row */}
        <View style={styles.orderSummaryCard}>
          <Text style={styles.orderSummaryText}>
            📦 {items_summary.count} {items_summary.count === 1 ? 'item' : 'items'} · ₹{items_summary.total.toFixed(2)} total · [{(order.payment_mode || 'Cash').toUpperCase()}]
          </Text>
        </View>

        {/* ─── 3 Primary Action Buttons ────────────────────────────────────── */}
        <View style={styles.actionButtonsContainer}>
          {/* 1. Navigate */}
          <TouchableOpacity style={styles.navActionBtn} onPress={handleOpenNavigation} activeOpacity={0.88}>
            <Ionicons name="navigate-circle" size={20} color="#FFFFFF" />
            <Text style={styles.navActionBtnText}>🗺️ Navigate</Text>
          </TouchableOpacity>

          {/* 2. Mark as Delivered */}
          <TouchableOpacity
            style={styles.deliverActionBtn}
            onPress={() => setShowProofSheet(true)}
            activeOpacity={0.88}
          >
            <Ionicons name="checkmark-circle" size={20} color="#FFFFFF" />
            <Text style={styles.deliverActionBtnText}>✅ Mark as Delivered</Text>
          </TouchableOpacity>

          {/* 3. Could Not Deliver */}
          <TouchableOpacity
            style={styles.failedActionBtn}
            onPress={() => setShowFailedSheet(true)}
            activeOpacity={0.88}
          >
            <Ionicons name="close-circle-outline" size={18} color="#D32F2F" />
            <Text style={styles.failedActionBtnText}>❌ Could Not Deliver</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      {/* ─── Proof of Delivery Sheet ────────────────────────────────────────── */}
      {showProofSheet && (
        <ProofOfDeliverySheet
          visible={showProofSheet}
          orderId={order.id}
          orderNumber={order.order_number}
          shopName={shopName}
          riderId={user?.id || ''}
          riderLat={riderCoords?.lat}
          riderLng={riderCoords?.lng}
          onClose={() => setShowProofSheet(false)}
          onSuccess={handleDeliveredSuccess}
        />
      )}

      {/* ─── Failed Delivery Sheet ──────────────────────────────────────────── */}
      {showFailedSheet && (
        <FailedDeliverySheet
          visible={showFailedSheet}
          orderId={order.id}
          orderNumber={order.order_number}
          shopName={shopName}
          onClose={() => setShowFailedSheet(false)}
          onFailed={handleFailedComplete}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  centerContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#F8FAFC',
  },
  loadingText: {
    marginTop: 14,
    fontSize: 14,
    color: '#64748B',
    fontWeight: '600',
  },
  emptyIconCircle: {
    width: 90,
    height: 90,
    borderRadius: 45,
    backgroundColor: '#E3F2FD',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#0F172A',
    marginBottom: 8,
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: 14,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 24,
    paddingHorizontal: 20,
  },
  primaryBackBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#1565C0',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 12,
  },
  primaryBackBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  topBroadcastBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#0F172A',
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  broadcastLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  liveBroadcastDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#10B981',
  },
  broadcastText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#F8FAFC',
    flex: 1,
  },
  batteryBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  batteryText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#F8FAFC',
  },
  mapSection: {
    height: SCREEN_HEIGHT * 0.42,
    width: '100%',
    backgroundColor: '#E8EEF5',
  },
  cardSection: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    marginTop: -12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 8,
  },
  cardContent: {
    padding: 16,
    paddingBottom: 32,
    gap: 12,
  },
  statusChipsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#F8FAFC',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },
  statusChip: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  statusChipActive: {
    backgroundColor: '#E3F2FD',
  },
  statusChipTextActive: {
    fontSize: 11,
    fontWeight: '800',
    color: '#1565C0',
  },
  statusChipTextMuted: {
    fontSize: 11,
    fontWeight: '600',
    color: '#94A3B8',
  },
  etaRowCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F0F7FF',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    gap: 10,
    borderWidth: 1,
    borderColor: '#D0E4FF',
  },
  etaRowText: {
    fontSize: 13,
    fontWeight: '800',
    color: '#1565C0',
    flex: 1,
  },
  slaAlertBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#FEF3C7',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#FDE68A',
  },
  slaAlertText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#B45309',
  },
  shopCard: {
    backgroundColor: '#FAFAFA',
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    gap: 4,
  },
  shopHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 2,
  },
  shopNameText: {
    fontSize: 15,
    fontWeight: '800',
    color: '#0F172A',
    flex: 1,
  },
  shopAddressText: {
    fontSize: 13,
    color: '#334155',
    lineHeight: 18,
  },
  landmarkText: {
    fontSize: 12,
    color: '#64748B',
  },
  windowText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#D97706',
    marginTop: 2,
  },
  receiverCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#F0FDFA',
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#CCFBF1',
  },
  receiverInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  receiverNameText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#134E4A',
  },
  receiverPhoneText: {
    fontSize: 12,
    color: '#0F766E',
    marginTop: 1,
  },
  callReceiverBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#0F766E',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
  },
  callReceiverBtnText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  orderSummaryCard: {
    backgroundColor: '#F8FAFC',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  orderSummaryText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#475569',
  },
  actionButtonsContainer: {
    gap: 10,
    marginTop: 4,
  },
  navActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1565C0',
    paddingVertical: 14,
    borderRadius: 12,
    gap: 8,
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 4,
  },
  navActionBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  deliverActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2E7D32',
    paddingVertical: 14,
    borderRadius: 12,
    gap: 8,
    shadowColor: '#2E7D32',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 4,
  },
  deliverActionBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  failedActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFEBEE',
    paddingVertical: 12,
    borderRadius: 12,
    gap: 8,
    borderWidth: 1,
    borderColor: '#FFCDD2',
  },
  failedActionBtnText: {
    color: '#D32F2F',
    fontSize: 13,
    fontWeight: '700',
  },

  // Delivered Overlay
  deliveredSuccessOverlay: {
    flex: 1,
    backgroundColor: 'rgba(27, 94, 32, 0.96)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  deliveredSuccessCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: 28,
    alignItems: 'center',
    width: '100%',
    maxWidth: 360,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.3,
    shadowRadius: 20,
    elevation: 20,
  },
  deliveredCheckIcon: {
    fontSize: 54,
    marginBottom: 8,
  },
  deliveredSuccessTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: '#2E7D32',
    marginBottom: 4,
  },
  deliveredSuccessShop: {
    fontSize: 16,
    fontWeight: '800',
    color: '#0F172A',
    textAlign: 'center',
    marginBottom: 4,
  },
  deliveredSuccessTime: {
    fontSize: 13,
    color: '#64748B',
    marginBottom: 16,
  },
  deliveredCheersText: {
    fontSize: 16,
    fontWeight: '800',
    color: '#1565C0',
    marginBottom: 24,
  },
  deliveredReturnBtn: {
    backgroundColor: '#2E7D32',
    paddingVertical: 13,
    paddingHorizontal: 28,
    borderRadius: 12,
    width: '100%',
    alignItems: 'center',
  },
  deliveredReturnBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
  },

  // Failed Overlay
  failedOverlay: {
    flex: 1,
    backgroundColor: 'rgba(185, 28, 28, 0.96)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  failedCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: 28,
    alignItems: 'center',
    width: '100%',
    maxWidth: 360,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.3,
    shadowRadius: 20,
    elevation: 20,
  },
  failedIcon: {
    fontSize: 54,
    marginBottom: 8,
  },
  failedTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: '#D32F2F',
    marginBottom: 12,
  },
  failedReasonHeading: {
    fontSize: 12,
    fontWeight: '800',
    color: '#64748B',
    textTransform: 'uppercase',
  },
  failedReasonBody: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0F172A',
    textAlign: 'center',
    marginTop: 2,
    marginBottom: 14,
  },
  failedAdminNote: {
    fontSize: 12,
    color: '#64748B',
    fontStyle: 'italic',
    marginBottom: 24,
  },
  failedReturnBtn: {
    backgroundColor: '#D32F2F',
    paddingVertical: 13,
    paddingHorizontal: 28,
    borderRadius: 12,
    width: '100%',
    alignItems: 'center',
  },
  failedReturnBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
  },
});
