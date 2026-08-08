/**
 * Admin Per-Order Live Delivery Tracker
 *
 * Full-screen admin live tracking dashboard:
 * - On mount calls get_order_tracking_bundle(orderId) RPC
 * - Realtime Postgres Changes on delivery_tracking and delivery_location_history
 * - Reconnect banner with exponential backoff
 * - Native Share sheet (https://thakkar-medico-traders.vercel.app/track/[orderId])
 * - Live ETA card with SLA window warning, battery warnings, and caller actions
 * - Delivered overlay with completion duration & photo hook
 * - Failed delivery overlay with reassign modal action
 */
import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  ActivityIndicator,
  StyleSheet,
  TouchableOpacity,
  Share,
  Alert,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { differenceInMinutes, formatDistanceStrict } from 'date-fns';

import { supabase } from '../../../src/services/supabase';
import { useRealtimeOrders } from '../../../src/hooks/useRealtimeOrders';
import { resolveOrderCoords } from '../../../src/utils/orderDeliveryCoords';
import {
  fetchRoute,
  calculateDistance,
  type LatLng,
  type RouteResult,
  THAKKAR_MEDICO,
} from '../../../src/services/routesApiService';
import { checkGeofence, triggerGeofenceArrival } from '../../../src/services/geofenceService';
import {
  LiveTrackingMap,
  type LiveTrackingMapRef,
  type MapRiderData,
  type MapRouteData,
} from '../../../src/components/tracking/LiveTrackingMap';
import { ETACard, type ETACardTimeline } from '../../../src/components/tracking/ETACard';
import { AssignDeliveryModal } from '../../../src/components/delivery/AssignDeliveryModal';
import type { OrderTrackingBundle } from '../../../src/types';

interface DeliverySnapshot {
  shop_name?: string;
  landmark?: string;
  receiver_name?: string;
  receiver_phone?: string;
  best_delivery_window?: string;
  lat?: number;
  lng?: number;
  full_address?: string;
  entry_notes?: string;
  branch_label?: string;
}

export default function TrackDeliveryScreen() {
  const { orderId } = useLocalSearchParams<{ orderId: string }>();
  const router = useRouter();
  const mapRef = useRef<LiveTrackingMapRef>(null);

  // Core state
  const [order, setOrder] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Destination coords resolved from order
  const [destination, setDestination] = useState<{
    lat: number;
    lng: number;
    shopName: string;
    landmark: string;
    receiverName: string;
    receiverPhone: string;
    geofenceArrived?: boolean;
  } | null>(null);

  // Rider location & breadcrumb history
  const [riderLocation, setRiderLocation] = useState<{
    lat: number;
    lng: number;
    heading: number | null;
    speed: number | null;
    accuracy: number | null;
    batteryLevel: number | null;
    isOffRoute?: boolean;
    geofenceArrived?: boolean;
    updatedAt: string;
  } | null>(null);

  const [historyPoints, setHistoryPoints] = useState<{ lat: number; lng: number }[]>([]);
  const [riderProfile, setRiderProfile] = useState<{ id: string; name: string; phone: string | null } | null>(null);
  const [timeline, setTimeline] = useState<ETACardTimeline | null>(null);
  const [deliveryProof, setDeliveryProof] = useState<any>(null);

  // Route & ETA calculation state
  const [routeResult, setRouteResult] = useState<RouteResult | null>(null);
  const [referenceRouteCoords, setReferenceRouteCoords] = useState<[number, number][]>([]);
  const lastRouteFetchPos = useRef<LatLng | null>(null);
  const lastRouteFetchTime = useRef(0);
  const routeFetchInProgress = useRef(false);

  // Delivery status overlays & modal
  const [isDelivered, setIsDelivered] = useState(false);
  const [isDeliveryFailed, setIsDeliveryFailed] = useState(false);
  const [failedReason, setFailedReason] = useState<string | null>(null);
  const [showReassignModal, setShowReassignModal] = useState(false);

  // Realtime connection health
  const [connectionLost, setConnectionLost] = useState(false);
  const reconnectAttempts = useRef(0);

  // ─── 1. Load full tracking bundle via RPC (with direct fallback) ─────────────
  const loadTrackingBundle = useCallback(async () => {
    if (!orderId) return;

    try {
      setLoading(true);
      setError(null);

      // Call get_order_tracking_bundle RPC
      const { data: bundleData, error: rpcError } = await supabase.rpc(
        'get_order_tracking_bundle',
        { p_order_id: orderId },
      );

      let bundle: OrderTrackingBundle | null = bundleData as any;

      // Fallback to direct queries if RPC is not ready
      if (rpcError || !bundle || (bundle as any).error) {
        const { data: orderRow, error: orderErr } = await supabase
          .from('orders')
          .select('*')
          .eq('id', orderId)
          .single();

        if (orderErr || !orderRow) throw orderErr || new Error('Order not found');

        const { data: trackRow } = await supabase
          .from('delivery_tracking')
          .select('*')
          .eq('order_id', orderId)
          .maybeSingle();

        const { data: historyRows } = await supabase
          .from('delivery_location_history')
          .select('lat, lng, heading, speed, recorded_at')
          .eq('order_id', orderId)
          .order('recorded_at', { ascending: true })
          .limit(50);

        let riderRow = null;
        if (orderRow.assigned_to) {
          const { data: pData } = await supabase
            .from('profiles')
            .select('id, name, business_name, phone')
            .eq('id', orderRow.assigned_to)
            .maybeSingle();
          if (pData) {
            riderRow = {
              id: pData.id,
              name: pData.name || pData.business_name || 'Delivery Partner',
              phone: pData.phone,
            };
          }
        }

        bundle = {
          order: orderRow,
          tracking: trackRow || null,
          history: historyRows || [],
          rider: riderRow,
          timeline: {
            placed_at: orderRow.created_at,
            confirmed_at: orderRow.assigned_at || orderRow.created_at,
            dispatched_at: orderRow.dispatched_at,
            delivered_at: orderRow.delivered_at,
            failed_at: orderRow.delivery_status === 'failed' ? orderRow.delivered_at : null,
          },
        };
      }

      const orderData = bundle.order;
      setOrder(orderData);
      setRiderProfile(bundle.rider);
      setTimeline(bundle.timeline);
      setDeliveryProof(bundle.proof || null);

      // Check terminal statuses
      if (orderData.status === 'delivered' || orderData.delivery_status === 'delivered') {
        setIsDelivered(true);
      } else if (orderData.status === 'delivery_failed' || orderData.delivery_status === 'failed') {
        setIsDeliveryFailed(true);
        setFailedReason(orderData.failed_reason || orderData.delivery_failure_reason || 'Unknown reason');
      }

      // Resolve destination coordinates
      const coords = await resolveOrderCoords(supabase, orderData);
      const snapshot = (orderData.delivery_snapshot || {}) as DeliverySnapshot;

      if (coords && (coords.lat !== 0 || coords.lng !== 0)) {
        setDestination({
          lat: coords.lat,
          lng: coords.lng,
          shopName: snapshot.shop_name || orderData.user_name || 'Retailer Shop',
          landmark: snapshot.landmark || '',
          receiverName: snapshot.receiver_name || orderData.user_name || 'Retailer',
          receiverPhone: snapshot.receiver_phone || orderData.user_phone || '',
          geofenceArrived: bundle.tracking?.geofence_arrived || orderData.delivery_status === 'arriving_soon',
        });
      } else {
        setError('Could not resolve destination coordinates.');
      }

      // Populate history breadcrumbs
      if (bundle.history && bundle.history.length > 0) {
        setHistoryPoints(bundle.history.map((h) => ({ lat: h.lat, lng: h.lng })));
      }

      // Populate tracking position
      if (bundle.tracking) {
        setRiderLocation({
          lat: bundle.tracking.lat,
          lng: bundle.tracking.lng,
          heading: bundle.tracking.heading ?? null,
          speed: bundle.tracking.speed ?? null,
          accuracy: bundle.tracking.accuracy ?? null,
          batteryLevel: bundle.tracking.battery_level ?? null,
          isOffRoute: bundle.tracking.is_off_route,
          geofenceArrived: bundle.tracking.geofence_arrived,
          updatedAt: bundle.tracking.updated_at,
        });
      }

      setConnectionLost(false);
      reconnectAttempts.current = 0;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load tracking data';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    void loadTrackingBundle();
  }, [loadTrackingBundle]);

  // ─── 2. Realtime subscription on delivery_tracking ─────────────────────────
  useRealtimeOrders({
    table: 'delivery_tracking',
    event: 'UPDATE',
    filter: `order_id=eq.${orderId}`,
    enabled: !!orderId && !isDelivered,
    onUpdate: (payload) => {
      const row = payload.new as any;
      setRiderLocation({
        lat: row.lat,
        lng: row.lng,
        heading: row.heading ?? null,
        speed: row.speed ?? null,
        accuracy: row.accuracy ?? null,
        batteryLevel: row.battery_level ?? null,
        isOffRoute: row.is_off_route,
        geofenceArrived: row.geofence_arrived,
        updatedAt: row.updated_at,
      });

      // Append live breadcrumb
      if (row.lat && row.lng) {
        setHistoryPoints((prev) => [...prev, { lat: row.lat, lng: row.lng }]);
        mapRef.current?.appendHistory({ lat: row.lat, lng: row.lng });
      }

      // Client-side geofence trigger check
      if (destination && !row.geofence_arrived) {
        const isArrived = checkGeofence(row.lat, row.lng, destination.lat, destination.lng);
        if (isArrived) {
          mapRef.current?.setGeofenceArrived(true);
          void triggerGeofenceArrival(orderId as string, row.rider_id);
        }
      }
    },
  });

  // Realtime subscription on delivery_location_history for live breadcrumbs
  useRealtimeOrders({
    table: 'delivery_location_history',
    event: 'INSERT',
    filter: `order_id=eq.${orderId}`,
    enabled: !!orderId && !isDelivered,
    onInsert: (payload) => {
      const row = payload.new as any;
      if (row.lat && row.lng) {
        mapRef.current?.appendHistory({ lat: row.lat, lng: row.lng });
      }
    },
  });

  // Realtime subscription on orders for delivered / failed terminal states
  useRealtimeOrders({
    table: 'orders',
    event: 'UPDATE',
    filter: `id=eq.${orderId}`,
    enabled: !!orderId && !isDelivered,
    onUpdate: (payload) => {
      const row = payload.new as any;
      if (row.status === 'delivered' || row.delivery_status === 'delivered') {
        setIsDelivered(true);
        setTimeline((prev) => ({
          ...prev,
          placed_at: prev?.placed_at || row.created_at,
          confirmed_at: prev?.confirmed_at || row.created_at,
          dispatched_at: prev?.dispatched_at || row.dispatched_at,
          delivered_at: row.delivered_at || new Date().toISOString(),
          failed_at: null,
        }));
      } else if (row.status === 'delivery_failed' || row.delivery_status === 'failed') {
        setIsDeliveryFailed(true);
        setFailedReason(row.failed_reason || row.delivery_failure_reason || 'Delivery failed');
      }
    },
  });

  // ─── 3. Auto-reconnect with exponential backoff on connection drops ────────
  useEffect(() => {
    if (isDelivered || isDeliveryFailed) return;

    const channel = supabase.channel(`tracking_health_${orderId}`);
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        setConnectionLost(false);
        reconnectAttempts.current = 0;
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        setConnectionLost(true);
        const delay = Math.min(30000, 1000 * Math.pow(2, reconnectAttempts.current));
        reconnectAttempts.current += 1;
        setTimeout(() => {
          void loadTrackingBundle();
        }, delay);
      }
    });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [orderId, isDelivered, isDeliveryFailed, loadTrackingBundle]);

  // ─── 4. Push rider marker update into Leaflet Map ──────────────────────────
  useEffect(() => {
    if (!riderLocation || !order || !destination) return;

    const riderData: MapRiderData = {
      lat: riderLocation.lat,
      lng: riderLocation.lng,
      heading: riderLocation.heading,
      speed: riderLocation.speed,
      accuracy: riderLocation.accuracy,
      batteryLevel: riderLocation.batteryLevel,
      riderName: riderProfile?.name || order.user_name || 'Delivery Partner',
      riderPhone: riderProfile?.phone || '',
      lastUpdated: riderLocation.updatedAt,
      isOffRoute: riderLocation.isOffRoute,
      geofenceArrived: riderLocation.geofenceArrived,
    };

    mapRef.current?.updateRider(riderData);
  }, [riderLocation, order, destination, riderProfile]);

  // ─── 5. Route fetching (OSRM Primary with 60s / 200m refresh) ───────────────
  const fetchAndUpdateRoute = useCallback(async () => {
    if (!riderLocation || !destination || routeFetchInProgress.current || isDelivered) return;

    const riderPos: LatLng = {
      lat: riderLocation.lat,
      lng: riderLocation.lng,
    };
    const destPos: LatLng = {
      lat: destination.lat,
      lng: destination.lng,
    };
    const storePos: LatLng = {
      lat: THAKKAR_MEDICO.lat,
      lng: THAKKAR_MEDICO.lng,
    };

    const now = Date.now();
    const timeSinceLastFetch = now - lastRouteFetchTime.current;
    const movedDistance = lastRouteFetchPos.current
      ? calculateDistance(lastRouteFetchPos.current, riderPos)
      : Infinity;

    // Skip if recently fetched and rider hasn't moved >200m
    if (lastRouteFetchTime.current > 0 && timeSinceLastFetch < 60000 && movedDistance < 200) {
      return;
    }

    routeFetchInProgress.current = true;

    try {
      // 1. Fetch active route: rider → destination
      const activeResult = await fetchRoute(riderPos, destPos);

      // 2. Fetch reference route: Thakkar Medico store → destination (once)
      let refCoords = referenceRouteCoords;
      if (refCoords.length === 0) {
        const refResult = await fetchRoute(storePos, destPos);
        if (refResult && refResult.polylineCoords.length > 0) {
          refCoords = refResult.polylineCoords;
          setReferenceRouteCoords(refCoords);
        }
      }

      if (activeResult) {
        setRouteResult(activeResult);
        lastRouteFetchPos.current = riderPos;
        lastRouteFetchTime.current = now;

        const routeData: MapRouteData = {
          activeRoute: activeResult.polylineCoords,
          referenceRoute: refCoords,
          durationSeconds: activeResult.durationSeconds,
          distanceMeters: activeResult.distanceMeters,
          source: activeResult.source,
        };

        mapRef.current?.updateRoute(routeData);
      }
    } catch (err) {
      console.warn('[TrackDelivery] Route fetch error:', err);
    } finally {
      routeFetchInProgress.current = false;
    }
  }, [riderLocation, destination, referenceRouteCoords, isDelivered]);

  // Route fetch on rider position update
  useEffect(() => {
    if (riderLocation && destination && !isDelivered) {
      void fetchAndUpdateRoute();
    }
  }, [riderLocation, destination, isDelivered, fetchAndUpdateRoute]);

  // Periodic 60s route refresh
  useEffect(() => {
    if (!riderLocation || !destination || isDelivered) return;

    const interval = setInterval(() => {
      void fetchAndUpdateRoute();
    }, 60000);

    return () => clearInterval(interval);
  }, [riderLocation, destination, isDelivered, fetchAndUpdateRoute]);

  // ─── 6. Native Share Sheet Action ──────────────────────────────────────────
  const handleShare = async () => {
    if (!orderId) return;
    const shareUrl = `https://thakkar-medico-traders.vercel.app/track/${orderId}`;
    const orderNum = order?.order_number || '';

    try {
      await Share.share({
        title: `Track Order #${orderNum}`,
        message: `Track live delivery for Thakkar Medico Order #${orderNum}:\n${shareUrl}`,
        url: shareUrl,
      });
    } catch {
      Alert.alert('Share', `Tracking URL: ${shareUrl}`);
    }
  };

  // ─── 7. Off-Route & Geofence callbacks from Leaflet ─────────────────────────
  const handleOffRouteDetected = useCallback(
    (isOffRoute: boolean) => {
      if (!orderId) return;
      if (isOffRoute !== riderLocation?.isOffRoute) {
        supabase
          .from('delivery_tracking')
          .update({ isOffRoute, updated_at: new Date().toISOString() })
          .eq('order_id', orderId)
          .then(() => {});
      }
    },
    [orderId, riderLocation?.isOffRoute],
  );

  const handleGeofenceArrival = useCallback(() => {
    if (!orderId) return;
    void triggerGeofenceArrival(orderId as string, riderProfile?.id);
  }, [orderId, riderProfile?.id]);

  // ─── Render ────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <SafeAreaView style={styles.centerContainer}>
        <Stack.Screen options={{ title: 'Track Delivery' }} />
        <ActivityIndicator size="large" color="#1565C0" />
        <Text style={styles.loadingText}>Loading delivery tracking…</Text>
      </SafeAreaView>
    );
  }

  if (error || !destination) {
    return (
      <SafeAreaView style={styles.centerContainer}>
        <Stack.Screen options={{ title: 'Track Delivery' }} />
        <Ionicons name="warning-outline" size={48} color="#E65100" />
        <Text style={styles.errorText}>{error || 'Delivery destination not found'}</Text>
        <TouchableOpacity
          style={styles.retryBtn}
          onPress={() => void loadTrackingBundle()}
        >
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  const snapshot = (order?.delivery_snapshot || {}) as DeliverySnapshot;

  // Calculate delivery duration string for completed deliveries
  let deliveryDurationText = '';
  if (order?.dispatched_at && order?.delivered_at) {
    try {
      deliveryDurationText = formatDistanceStrict(
        new Date(order.dispatched_at),
        new Date(order.delivered_at),
      );
    } catch {
      deliveryDurationText = '';
    }
  }

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: `Track #${order?.order_number || ''}`,
          headerRight: () => (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
              <TouchableOpacity onPress={handleShare} activeOpacity={0.7}>
                <Ionicons name="share-outline" size={22} color="#1565C0" />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => void loadTrackingBundle()} activeOpacity={0.7}>
                <Ionicons name="refresh" size={22} color="#1565C0" />
              </TouchableOpacity>
            </View>
          ),
        }}
      />

      {/* Connection Health Banner */}
      {connectionLost && (
        <View style={styles.connectionBanner}>
          <Text style={styles.connectionText}>🔴 Live connection lost — retrying…</Text>
        </View>
      )}

      {/* Full-Screen Interactive Leaflet Map */}
      <LiveTrackingMap
        ref={mapRef}
        destination={destination}
        initialRider={
          riderLocation
            ? {
                lat: riderLocation.lat,
                lng: riderLocation.lng,
                heading: riderLocation.heading,
                speed: riderLocation.speed,
                accuracy: riderLocation.accuracy,
                batteryLevel: riderLocation.batteryLevel,
                riderName: riderProfile?.name || order?.user_name || 'Delivery Partner',
                riderPhone: riderProfile?.phone || '',
                lastUpdated: riderLocation.updatedAt,
                isOffRoute: riderLocation.isOffRoute,
                geofenceArrived: destination.geofenceArrived,
              }
            : null
        }
        initialRoute={
          routeResult
            ? {
                activeRoute: routeResult.polylineCoords,
                referenceRoute: referenceRouteCoords,
                durationSeconds: routeResult.durationSeconds,
                distanceMeters: routeResult.distanceMeters,
                source: routeResult.source,
              }
            : null
        }
        initialHistory={historyPoints}
        onOffRouteDetected={handleOffRouteDetected}
        onGeofenceArrival={handleGeofenceArrival}
      />

      {/* Expandable ETA & Order Controls Card */}
      <ETACard
        etaSeconds={routeResult?.durationSeconds ?? null}
        distanceMeters={routeResult?.distanceMeters ?? null}
        totalDistanceMeters={routeResult?.distanceMeters ? routeResult.distanceMeters * 1.5 : null}
        orderNumber={order?.order_number || ''}
        shopName={destination.shopName}
        landmark={destination.landmark}
        receiverName={destination.receiverName}
        receiverPhone={destination.receiverPhone}
        riderName={riderProfile?.name || 'Assigned Driver'}
        riderPhone={riderProfile?.phone || ''}
        batteryLevel={riderLocation?.batteryLevel}
        speedKmh={riderLocation?.speed ? Math.round(riderLocation.speed * 3.6) : null}
        deliveryWindow={snapshot.best_delivery_window || ''}
        deliveryStatus={order?.delivery_status}
        dispatchedAt={order?.dispatched_at || null}
        lastUpdatedAt={riderLocation?.updatedAt || null}
        isDelivered={isDelivered}
        isOffRoute={riderLocation?.isOffRoute}
        geofenceArrived={destination.geofenceArrived}
        adminNotes={order?.notes || null}
        timeline={timeline}
        orderItems={Array.isArray(order?.items) ? order.items : []}
        grandTotal={order?.grand_total}
        paymentMode={order?.payment_mode}
        gstin={(order as any)?.gstin || (snapshot as any)?.gstin}
        proof={deliveryProof}
      />

      {/* ─── Delivered Full-Screen Overlay ─────────────────────────────────── */}
      {isDelivered && (
        <View style={styles.deliveredOverlay}>
          <View style={styles.deliveredCard}>
            <Text style={styles.deliveredBigIcon}>✅</Text>
            <Text style={styles.deliveredTitle}>Delivered</Text>
            <Text style={styles.deliveredShop}>{destination.shopName}</Text>
            <Text style={styles.deliveredTime}>
              Delivered at {timeline?.delivered_at ? new Date(timeline.delivered_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }) : 'Completed'}
            </Text>

            {deliveryDurationText ? (
              <View style={styles.durationBadge}>
                <Text style={styles.durationText}>
                  ⏱ Delivery took {deliveryDurationText}
                </Text>
              </View>
            ) : null}

            {/* Delivery proof photo thumbnail */}
            {deliveryProof?.photo_url && (
              <View style={{ marginTop: 12, alignItems: 'center' }}>
                <Image
                  source={{ uri: deliveryProof.photo_url }}
                  style={{ width: 120, height: 90, borderRadius: 10 }}
                  resizeMode="cover"
                />
                <Text style={{ fontSize: 11, color: '#2E7D32', marginTop: 4, fontWeight: '700' }}>
                  ✓ Delivery Photo Recorded
                </Text>
              </View>
            )}

            <TouchableOpacity style={styles.closeBtn} onPress={() => router.back()}>
              <Text style={styles.closeBtnText}>Close & Return to Orders</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* ─── Failed Delivery Full-Screen Overlay ───────────────────────────── */}
      {isDeliveryFailed && (
        <View style={styles.failedOverlay}>
          <View style={styles.failedCard}>
            <Text style={styles.failedBigIcon}>❌</Text>
            <Text style={styles.failedTitle}>Delivery Failed</Text>
            <Text style={styles.failedReasonText}>
              Reason: {failedReason || 'Retailer unreachable / Shop closed'}
            </Text>
            <Text style={styles.failedTimeText}>
              Recorded at {new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })}
            </Text>

            <View style={styles.failedActionsRow}>
              <TouchableOpacity
                style={styles.reassignBtn}
                onPress={() => setShowReassignModal(true)}
              >
                <Ionicons name="person-add" size={16} color="#fff" />
                <Text style={styles.reassignBtnText}>Reassign Driver</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.dismissBtn}
                onPress={() => router.back()}
              >
                <Text style={styles.dismissBtnText}>Close</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}

      {/* Reassign Driver Modal */}
      {showReassignModal && order && (
        <AssignDeliveryModal
          visible={showReassignModal}
          orderId={order.id}
          orderNumber={order.order_number}
          onClose={() => setShowReassignModal(false)}
          onAssigned={() => {
            setShowReassignModal(false);
            setIsDeliveryFailed(false);
            void loadTrackingBundle();
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F5F5',
  },
  centerContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 30,
    backgroundColor: '#F5F5F5',
  },
  loadingText: {
    marginTop: 16,
    fontSize: 14,
    color: '#78909C',
    fontWeight: '600',
  },
  errorText: {
    marginTop: 16,
    fontSize: 14,
    color: '#E65100',
    fontWeight: '600',
    textAlign: 'center',
  },
  retryBtn: {
    marginTop: 20,
    paddingHorizontal: 24,
    paddingVertical: 10,
    backgroundColor: '#1565C0',
    borderRadius: 8,
  },
  retryText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 14,
  },
  connectionBanner: {
    backgroundColor: '#D32F2F',
    paddingVertical: 6,
    alignItems: 'center',
    zIndex: 90,
  },
  connectionText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },

  // Delivered Overlay
  deliveredOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(27, 94, 32, 0.94)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    zIndex: 200,
  },
  deliveredCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 28,
    alignItems: 'center',
    width: '100%',
    maxWidth: 380,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 20,
    elevation: 20,
  },
  deliveredBigIcon: {
    fontSize: 54,
    marginBottom: 8,
  },
  deliveredTitle: {
    fontSize: 24,
    fontWeight: '900',
    color: '#2E7D32',
    marginBottom: 4,
  },
  deliveredShop: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1A1D20',
    marginBottom: 4,
    textAlign: 'center',
  },
  deliveredTime: {
    fontSize: 13,
    color: '#757575',
    marginBottom: 12,
  },
  durationBadge: {
    backgroundColor: '#E8F5E9',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    marginBottom: 20,
  },
  durationText: {
    color: '#2E7D32',
    fontSize: 13,
    fontWeight: '700',
  },
  closeBtn: {
    backgroundColor: '#2E7D32',
    paddingVertical: 12,
    paddingHorizontal: 28,
    borderRadius: 12,
    width: '100%',
    alignItems: 'center',
  },
  closeBtnText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 14,
  },

  // Failed Overlay
  failedOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(183, 28, 28, 0.94)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    zIndex: 200,
  },
  failedCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 28,
    alignItems: 'center',
    width: '100%',
    maxWidth: 380,
    elevation: 20,
  },
  failedBigIcon: {
    fontSize: 54,
    marginBottom: 8,
  },
  failedTitle: {
    fontSize: 24,
    fontWeight: '900',
    color: '#C62828',
    marginBottom: 6,
  },
  failedReasonText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#D32F2F',
    textAlign: 'center',
    marginBottom: 6,
  },
  failedTimeText: {
    fontSize: 12,
    color: '#757575',
    marginBottom: 20,
  },
  failedActionsRow: {
    flexDirection: 'row',
    gap: 10,
    width: '100%',
  },
  reassignBtn: {
    flex: 1.3,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1565C0',
    paddingVertical: 12,
    borderRadius: 12,
    gap: 6,
  },
  reassignBtnText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 13,
  },
  dismissBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FAFAFA',
    borderWidth: 1,
    borderColor: '#CFD8DC',
    paddingVertical: 12,
    borderRadius: 12,
  },
  dismissBtnText: {
    color: '#455A64',
    fontWeight: '700',
    fontSize: 13,
  },
});
