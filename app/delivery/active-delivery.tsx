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
  AppState,
  type AppStateStatus,
  Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { supabase } from '../../src/services/supabase';
import { useAuthStore } from '../../src/store/authStore';
import {
  startOrderTracking,
  stopOrderTracking,
  getTrackingBatteryLevel,
  isTrackingActive,
  getTrackingOrderId,
  onGpsQualityChange,
  getGpsQuality,
} from '../../src/services/riderLocationService';
import NetInfo from '@react-native-community/netinfo';
import {
  fetchRoute,
  calculateDistance,
  formatETA,
  type RouteResult,
} from '../../src/services/routesApiService';
import { checkGeofence, triggerGeofenceArrival } from '../../src/services/geofenceService';
import { resolveOrderCoords } from '../../src/utils/orderDeliveryCoords';
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
    delivery_address_id?: string | null;
    dispatched_at?: string;
    delivered_at?: string;
    failed_reason?: string;
    sla_deadline?: string | null;
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
 * Check if the calculated arrival timestamp will exceed the SLA deadline or preferred delivery window.
 */
function checkSlaBreach(etaSeconds: number | null, windowStr?: string, slaDeadlineIso?: string | null): boolean {
  if (!etaSeconds) return false;
  const arrivalTimeMs = Date.now() + etaSeconds * 1000;

  // 1. Check explicit ISO sla_deadline first
  if (slaDeadlineIso) {
    const deadlineMs = new Date(slaDeadlineIso).getTime();
    if (Number.isFinite(deadlineMs) && deadlineMs > 0) {
      return arrivalTimeMs > deadlineMs;
    }
  }

  // 2. Parse delivery window string if provided
  if (!windowStr || windowStr.trim() === '') return false;

  try {
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
 * Calculate minimum distance in meters from a point to a polyline.
 */
function minDistanceToPolyline(lat: number, lng: number, polyline: [number, number][]): number {
  if (!polyline || polyline.length === 0) return Infinity;
  let min = Infinity;
  for (const pt of polyline) {
    const d = calculateDistance({ lat, lng }, { lat: pt[0], lng: pt[1] });
    if (d < min) min = d;
  }
  return min;
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
  const [gpsQuality, setGpsQuality] = useState<'good' | 'poor'>('good');
  const [networkType, setNetworkType] = useState<string>('unknown');
  const [isNetworkConnected, setIsNetworkConnected] = useState(true);

  // Notice & Acknowledgment State
  const [toastNotice, setToastNotice] = useState<string | null>(null);
  const [pendingDestinationUpdate, setPendingDestinationUpdate] = useState<{
    newLat: number;
    newLng: number;
    shiftMeters: number;
    shopName?: string;
    address?: string;
  } | null>(null);

  // Sheets & Full-screen overlays
  const [showProofSheet, setShowProofSheet] = useState(false);
  const [showFailedSheet, setShowFailedSheet] = useState(false);
  const [isDeliveredSuccess, setIsDeliveredSuccess] = useState(false);
  const [deliveredPhotoUrl, setDeliveredPhotoUrl] = useState<string | null>(null);
  const [deliveredTimeStr, setDeliveredTimeStr] = useState<string>('');
  const [isFailedState, setIsFailedState] = useState(false);
  const [failedReasonText, setFailedReasonText] = useState<string>('');

  // Location subscriber & throttling references
  const locationWatchRef = useRef<Location.LocationSubscription | null>(null);
  const lastRouteFetchTime = useRef(0);
  const isFetchingRoute = useRef(false);
  const consecutiveDeviationsRef = useRef(0);
  const riderCoordsRef = useRef<{ lat: number; lng: number; heading: number | null } | null>(null);
  const destCoordsRef = useRef<{ lat: number; lng: number } | null>(null);
  const activeBundleRef = useRef<ActiveOrderBundle | null>(null);
  const routeResultRef = useRef<RouteResult | null>(null);
  const geofenceArrivedRef = useRef(false);
  const isTerminalRef = useRef(false);
  const channelRef = useRef<any>(null);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  const [isCanaryEnabled, setIsCanaryEnabled] = useState(false);
  const isCanaryRef = useRef(false);
  const [isCircuitBreakerTripped, setIsCircuitBreakerTripped] = useState(false);
  const isCircuitBreakerTrippedRef = useRef(false);
  const sessionReconnectCountRef = useRef(0);
  const recalcTimestampsRef = useRef<number[]>([]);

  useEffect(() => {
    riderCoordsRef.current = riderCoords;
  }, [riderCoords]);
  useEffect(() => {
    destCoordsRef.current = destCoords;
  }, [destCoords]);
  useEffect(() => {
    activeBundleRef.current = activeBundle;
  }, [activeBundle]);
  useEffect(() => {
    routeResultRef.current = routeResult;
  }, [routeResult]);
  useEffect(() => {
    geofenceArrivedRef.current = geofenceArrived;
  }, [geofenceArrived]);
  useEffect(() => {
    isTerminalRef.current = isDeliveredSuccess || isFailedState;
  }, [isDeliveredSuccess, isFailedState]);

  const tripCircuitBreaker = useCallback((reason: string, details: any = {}) => {
    if (isCircuitBreakerTrippedRef.current) return;
    console.warn(`[ActiveDelivery] 🚨 Auto Circuit Breaker Tripped: ${reason}`, details);
    isCircuitBreakerTrippedRef.current = true;
    setIsCircuitBreakerTripped(true);
    setIsCanaryEnabled(false);
    isCanaryRef.current = false;
    setPendingDestinationUpdate(null);
    consecutiveDeviationsRef.current = 0;

    // Persist trip state for remainder of today's shift
    if (user?.id) {
      const shiftKey = `canary_breaker_${user.id}_${new Date().toISOString().slice(0, 10)}`;
      void AsyncStorage.setItem(shiftKey, 'tripped').catch(() => {});
    }

    // Log telemetry event for instant dashboard / push alert
    void supabase
      .rpc('log_delivery_telemetry_event', {
        p_event_type: 'auto_circuit_breaker_triggered',
        p_order_id: activeBundleRef.current?.order?.id || null,
        p_metadata: { reason, ...details, rider_id: user?.id },
      })
      .then(() => {}, () => {});

    setToastNotice('⚠️ Auto-switched to standard navigation mode for stability.');
    setTimeout(() => setToastNotice(null), 5000);
  }, [user?.id]);

  const checkCanary = useCallback(async () => {
    if (!user?.id) return;
    try {
      // Check if circuit breaker was already tripped for today's shift
      const shiftKey = `canary_breaker_${user.id}_${new Date().toISOString().slice(0, 10)}`;
      const tripped = await AsyncStorage.getItem(shiftKey);
      if (tripped === 'tripped') {
        console.log('[ActiveDelivery] Circuit breaker tripped for this shift — holding in baseline mode');
        setIsCircuitBreakerTripped(true);
        isCircuitBreakerTrippedRef.current = true;
        setIsCanaryEnabled(false);
        isCanaryRef.current = false;
        return;
      }

      const { data } = await supabase.rpc('check_rider_canary_flag', {
        p_rider_id: user.id,
        p_feature_set: 'delivery_flow_v2',
      });
      const enabled = Boolean(data);
      setIsCanaryEnabled(enabled);
      isCanaryRef.current = enabled;
      console.log(`[ActiveDelivery] Canary status for rider ${user.id.slice(0, 8)}: ${enabled ? 'CANARY ENABLED' : 'BASELINE'}`);
    } catch {
      setIsCanaryEnabled(false);
      isCanaryRef.current = false;
    }
  }, [user?.id]);

  useEffect(() => {
    void checkCanary();
  }, [checkCanary]);

  // PART A: Realtime listener on canary_rider_flags for IMMEDIATE rollback
  useEffect(() => {
    if (!user?.id) return;
    const flagChannel = supabase
      .channel(`canary-flag-watch-${user.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'canary_rider_flags',
          filter: `rider_id=eq.${user.id}`,
        },
        (payload: any) => {
          const newEnabled = payload.new ? Boolean(payload.new.enabled) : false;
          console.log(`[ActiveDelivery] Realtime canary flag update received: ${newEnabled ? 'ENABLED' : 'DISABLED'}`);

          if (!newEnabled) {
            // Immediate in-place rollback to baseline mode
            setIsCanaryEnabled(false);
            isCanaryRef.current = false;
            setPendingDestinationUpdate(null);
            consecutiveDeviationsRef.current = 0;
            setToastNotice('ℹ️ Navigation mode updated to standard.');
            setTimeout(() => setToastNotice(null), 4000);
          } else {
            // Admin explicitly re-enabled: clear shift breaker
            const shiftKey = `canary_breaker_${user.id}_${new Date().toISOString().slice(0, 10)}`;
            void AsyncStorage.removeItem(shiftKey).catch(() => {});
            setIsCircuitBreakerTripped(false);
            isCircuitBreakerTrippedRef.current = false;
            setIsCanaryEnabled(true);
            isCanaryRef.current = true;
            setToastNotice('✨ Canary navigation features enabled.');
            setTimeout(() => setToastNotice(null), 4000);
          }
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(flagChannel);
    };
  }, [user?.id]);

  const logTelemetry = useCallback((eventType: string, orderId?: string | null, metadata?: any) => {
    if (!isCanaryRef.current) return; // Only log granular client telemetry for canary cohort
    void supabase
      .rpc('log_delivery_telemetry_event', {
        p_event_type: eventType,
        p_order_id: orderId || null,
        p_metadata: metadata || {},
      })
      .then(
        () => {},
        (e) => {
          console.warn('[ActiveDelivery] Telemetry log warning:', e);
        },
      );
  }, []);

  // PART C: Low-friction rider issue reporting
  const handleReportRouteIssue = useCallback(() => {
    logTelemetry('rider_reported_issue', activeBundleRef.current?.order?.id, {
      rider_coords: riderCoordsRef.current,
      dest_coords: destCoordsRef.current,
      timestamp: new Date().toISOString(),
    });
    setToastNotice('✅ Route issue reported to dispatch. Thank you!');
    setTimeout(() => setToastNotice(null), 4000);
  }, [logTelemetry]);

  // ─── 1. Fetch active order for this rider ─────────────────────────────────
  const loadActiveOrder = useCallback(async (isInitial = false) => {
    if (!user?.id) return;
    if (isInitial || !activeBundleRef.current) {
      setLoading(true);
    }

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
        activeBundleRef.current = null;
        setLoading(false);
        return;
      }

      setActiveBundle(bundleData);
      activeBundleRef.current = bundleData;

      // Check terminal statuses
      if (
        bundleData.order.status === 'delivered' ||
        bundleData.order.delivery_status === 'delivered'
      ) {
        setIsDeliveredSuccess(true);
        isTerminalRef.current = true;
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
        isTerminalRef.current = true;
        setFailedReasonText(bundleData.order.failed_reason || 'Could not complete delivery');
      }

      // ─── Resolve Destination Coordinates ─────────────────────────────────
      let destLat = 0;
      let destLng = 0;
      const resolvedCoords = await resolveOrderCoords(supabase, bundleData.order);
      if (resolvedCoords && (resolvedCoords.lat !== 0 || resolvedCoords.lng !== 0)) {
        destLat = resolvedCoords.lat;
        destLng = resolvedCoords.lng;
      } else {
        const snap = bundleData.delivery_snapshot || {};
        if (snap.lat && snap.lng && (Number(snap.lat) !== 0 || Number(snap.lng) !== 0)) {
          destLat = Number(snap.lat);
          destLng = Number(snap.lng);
        } else {
          const addr = snap.full_address || snap.address || bundleData.order.delivery_address || '';
          const geocoded = await geocodeAddressWithNominatim(addr);
          if (geocoded) {
            destLat = geocoded.lat;
            destLng = geocoded.lng;
          } else {
            // Default fallback coords near Thakkar Medico Warehouse
            destLat = 21.150167;
            destLng = 79.099140;
          }
        }
      }

      destCoordsRef.current = { lat: destLat, lng: destLng };
      setDestCoords({ lat: destLat, lng: destLng });

      // ─── Start High-Accuracy GPS Broadcasting (only if not already tracking this order) ──
      if (!isTrackingActive() || getTrackingOrderId() !== bundleData.order.id) {
        void startOrderTracking(bundleData.order.id, user.id);
      }

      // Local initial position
      if (!riderCoordsRef.current) {
        try {
          const currentPos = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.High,
          });
          const initialRider = {
            lat: currentPos.coords.latitude,
            lng: currentPos.coords.longitude,
            heading: currentPos.coords.heading ?? null,
          };
          setRiderCoords(initialRider);
          riderCoordsRef.current = initialRider;
        } catch {
          const fallbackRider = { lat: 21.150167, lng: 79.099140, heading: 0 };
          setRiderCoords(fallbackRider);
          riderCoordsRef.current = fallbackRider;
        }
      }

      setBatteryLevel(getTrackingBatteryLevel());
    } catch (err: unknown) {
      console.warn('[ActiveDelivery] Error loading active order:', err);
    } finally {
      setLoading(false);
    }
  }, [user?.id, user?.name, user?.phone, paramOrderId]);

  useEffect(() => {
    void loadActiveOrder(true);
  }, [loadActiveOrder]);

  // ─── Cold-Start Resume: check AsyncStorage for abandoned tracking session ──
  useEffect(() => {
    if (!user?.id) return;
    async function checkColdStartResume() {
      try {
        const savedOrderId = await AsyncStorage.getItem('tracking_order_id');
        const savedRiderId = await AsyncStorage.getItem('tracking_rider_id');
        if (!savedOrderId || savedRiderId !== user?.id) return;
        if (isTrackingActive() && getTrackingOrderId() === savedOrderId) return;

        // Verify order is still active in Supabase
        const { data: orderCheck } = await supabase
          .from('orders')
          .select('id, status, delivery_status')
          .eq('id', savedOrderId)
          .maybeSingle();

        if (
          orderCheck &&
          !['delivered', 'cancelled', 'delivery_failed'].includes(orderCheck.status) &&
          orderCheck.delivery_status !== 'delivered' &&
          orderCheck.delivery_status !== 'failed'
        ) {
          console.log('[ActiveDelivery] Cold-start resume: restarting tracking for', savedOrderId.slice(0, 8));
          void startOrderTracking(savedOrderId, user.id);
        }
      } catch {
        // Non-fatal
      }
    }
    void checkColdStartResume();
  }, [user?.id]);

  // ─── GPS Quality Indicator ────────────────────────────────────────────────
  useEffect(() => {
    setGpsQuality(getGpsQuality());
    onGpsQualityChange((quality) => {
      setGpsQuality(quality);
    });
    return () => {
      onGpsQualityChange(null);
    };
  }, []);

  // ─── Network Quality Indicator ────────────────────────────────────────────
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      setIsNetworkConnected(state.isConnected ?? true);
      setNetworkType(state.type || 'unknown');
    });
    return () => unsubscribe();
  }, []);

  // ─── Heartbeat Watchdog: 60s check, restart only if truly stale >3 minutes (180s) ───
  useEffect(() => {
    const orderId = activeBundle?.order?.id;
    if (!orderId || !user?.id || isDeliveredSuccess || isFailedState) return;

    const watchdogInterval = setInterval(async () => {
      try {
        const heartbeat = await AsyncStorage.getItem('tracking_heartbeat');
        if (!heartbeat) return;
        const lastBeat = parseInt(heartbeat, 10);
        const staleMs = Date.now() - lastBeat;
        // 3 minutes (180s) tolerance for stationary intervals / traffic signals / shops
        if (staleMs > 180000 && !isTerminalRef.current) {
          console.warn(`[ActiveDelivery] Watchdog: tracking heartbeat stale (${Math.round(staleMs / 1000)}s) — refreshing tracking`);
          void startOrderTracking(orderId, user.id);
        }
      } catch {
        // Non-fatal
      }
    }, 60000);

    return () => clearInterval(watchdogInterval);
  }, [activeBundle?.order?.id, user?.id, isDeliveredSuccess, isFailedState]);

  // ─── 2. Fetch OSRM Route (Primary) with deviation trigger ──────────────────
  const fetchAndDrawRoute = useCallback(async (targetOverride?: { lat: number; lng: number }) => {
    const target = targetOverride || destCoordsRef.current;
    const currentRider = riderCoordsRef.current;
    if (!currentRider || !target || isTerminalRef.current || isFetchingRoute.current) return;

    isFetchingRoute.current = true;
    try {
      const res = await fetchRoute(
        { lat: currentRider.lat, lng: currentRider.lng },
        { lat: target.lat, lng: target.lng },
      );

      if (res && res.polylineCoords.length > 0) {
        setRouteResult(res);
        routeResultRef.current = res;
        lastRouteFetchTime.current = Date.now();
        mapRef.current?.updateRouteCoords(res.polylineCoords);
      }
    } catch (err) {
      console.warn('[ActiveDelivery] Route fetch error:', err);
    } finally {
      isFetchingRoute.current = false;
    }
  }, []);

  // ─── 3. Realtime subscription (Option a: Health check & safe reconnect) ────
  const subscribeRealtimeChannel = useCallback((currentId: string) => {
    if (!currentId) return;

    if (channelRef.current) {
      try {
        void supabase.removeChannel(channelRef.current);
      } catch (e) {
        console.warn('[ActiveDelivery] Channel cleanup warning:', e);
      }
      channelRef.current = null;
    }

    const channel = supabase
      .channel(`active_order_realtime_${currentId}_${Date.now()}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'orders', filter: `id=eq.${currentId}` },
        async (payload) => {
          const updated = payload.new as any;
          if (updated.status === 'delivered' || updated.delivery_status === 'delivered') {
            setIsDeliveredSuccess(true);
            isTerminalRef.current = true;
            void stopOrderTracking(); // Admin-forced stop
            setDeliveredTimeStr(
              updated.delivered_at
                ? new Date(updated.delivered_at).toLocaleTimeString('en-IN', {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: true,
                  })
                : 'Delivered',
            );
          } else if (updated.status === 'delivery_failed' || updated.delivery_status === 'failed') {
            setIsFailedState(true);
            isTerminalRef.current = true;
            void stopOrderTracking(); // Admin-forced stop
            setFailedReasonText(updated.failed_reason || 'Delivery marked as failed');
          }

          // Re-resolve destination if order changed
          const coords = await resolveOrderCoords(supabase, updated);
          if (coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lng) && (coords.lat !== 0 || coords.lng !== 0)) {
            const currentD = destCoordsRef.current;
            if (currentD && (currentD.lat !== 0 || currentD.lng !== 0)) {
              const shift = calculateDistance({ lat: currentD.lat, lng: currentD.lng }, { lat: coords.lat, lng: coords.lng });
              if (shift > 30) {
                if (isCanaryRef.current) {
                  // Canary cohort: Thresholded shift with notice toast (<=300m) or modal acknowledgment (>300m)
                  logTelemetry('destination_shifted', currentId, { shift_meters: Math.round(shift), new_lat: coords.lat, new_lng: coords.lng });

                  if (shift > 300) {
                    console.log(`[ActiveDelivery] Significant destination shift (${Math.round(shift)}m) — holding for rider confirmation`);
                    setPendingDestinationUpdate({
                      newLat: coords.lat,
                      newLng: coords.lng,
                      shiftMeters: Math.round(shift),
                      shopName: updated.user_name || 'Retailer',
                      address: coords.address,
                    });
                  } else {
                    console.log(`[ActiveDelivery] Minor destination update (${Math.round(shift)}m) — auto-updating route`);
                    destCoordsRef.current = { lat: coords.lat, lng: coords.lng };
                    setDestCoords({ lat: coords.lat, lng: coords.lng });
                    mapRef.current?.updateDestination(coords.lat, coords.lng, updated.user_name, coords.address);
                    setToastNotice(`📍 Delivery address was updated (+${Math.round(shift)}m) — route recalculated.`);
                    setTimeout(() => setToastNotice(null), 5000);
                    void fetchAndDrawRoute({ lat: coords.lat, lng: coords.lng });
                  }
                } else {
                  // Baseline cohort: Standard direct map update without modal/toast interruption
                  destCoordsRef.current = { lat: coords.lat, lng: coords.lng };
                  setDestCoords({ lat: coords.lat, lng: coords.lng });
                  mapRef.current?.updateDestination(coords.lat, coords.lng, updated.user_name, coords.address);
                  void fetchAndDrawRoute({ lat: coords.lat, lng: coords.lng });
                }
              }
            } else {
              destCoordsRef.current = { lat: coords.lat, lng: coords.lng };
              setDestCoords({ lat: coords.lat, lng: coords.lng });
              mapRef.current?.updateDestination(coords.lat, coords.lng, updated.user_name, coords.address);
            }
          }
        },
      )
      .subscribe();

    channelRef.current = channel;
  }, [fetchAndDrawRoute, logTelemetry]);

  // Initial subscription on active order ready
  useEffect(() => {
    const currentId = activeBundle?.order?.id;
    if (currentId) {
      subscribeRealtimeChannel(currentId);
    }

    return () => {
      if (channelRef.current) {
        void supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [activeBundle?.order?.id, subscribeRealtimeChannel]);

  // AppState Mobile Lifecycle Watcher: Reconnect WebSocket & refresh order on foreground
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
      if (appStateRef.current.match(/inactive|background/) && nextAppState === 'active') {
        console.log('[ActiveDelivery] App returned to foreground — refreshing active order & checking channel health');
        void loadActiveOrder(false);
        void checkCanary();

        const currentChannel = channelRef.current;
        const isDead = !currentChannel || currentChannel.state !== 'joined';
        const currentOrderId = activeBundleRef.current?.order?.id;
        if (isDead && currentOrderId && isCanaryRef.current) {
          sessionReconnectCountRef.current += 1;
          console.log(`[ActiveDelivery] Reconnect attempt #${sessionReconnectCountRef.current} for this shift`);

          // PART B: Client-side Circuit Breaker for Reconnects (>2/shift)
          if (sessionReconnectCountRef.current > 2) {
            tripCircuitBreaker('Excessive Reconnections (>2/shift)', {
              reconnect_count: sessionReconnectCountRef.current,
            });
            return;
          }

          console.log('[ActiveDelivery] Realtime channel is not joined — recreating subscription (Canary)');
          logTelemetry('realtime_reconnect', currentOrderId, {
            trigger: 'foreground_reconnect',
            reconnect_count: sessionReconnectCountRef.current,
            previous_state: currentChannel?.state || 'none',
          });
          subscribeRealtimeChannel(currentOrderId);
        }
      }
      appStateRef.current = nextAppState;
    });

    return () => {
      sub.remove();
    };
  }, [loadActiveOrder, checkCanary, subscribeRealtimeChannel, logTelemetry, tripCircuitBreaker]);

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

  // ─── 4. Watch rider local position & detect off-route deviations ───────────
  useEffect(() => {
    const orderId = activeBundle?.order?.id;
    if (!orderId || isDeliveredSuccess || isFailedState) return;

    let sub: Location.LocationSubscription | null = null;
    let isCancelled = false;

    async function subscribeLocalPosition() {
      try {
        sub = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.High,
            timeInterval: 3000,
            distanceInterval: 5,
          },
          (loc) => {
            if (isCancelled) return;
            const { latitude, longitude, heading } = loc.coords;
            const newRider = { lat: latitude, lng: longitude, heading: heading ?? null };
            setRiderCoords(newRider);
            riderCoordsRef.current = newRider;
            setBatteryLevel(getTrackingBatteryLevel());

            mapRef.current?.updateRiderPosition(latitude, longitude, heading ?? null);

            // Geofence check against active destination ref (500m)
            const target = destCoordsRef.current;
            if (target && !geofenceArrivedRef.current) {
              const arrived = checkGeofence(latitude, longitude, target.lat, target.lng);
              if (arrived) {
                setGeofenceArrived(true);
                geofenceArrivedRef.current = true;
                if (user?.id) {
                  void triggerGeofenceArrival(orderId, user.id);
                }
              }
            }

            // Proactive off-route deviation check (>200m from polyline)
            const currentRoute = routeResultRef.current;
            if (currentRoute?.polylineCoords && currentRoute.polylineCoords.length > 1) {
              const distToPath = minDistanceToPolyline(latitude, longitude, currentRoute.polylineCoords);
              const now = Date.now();
              if (distToPath > 200) {
                if (isCanaryRef.current) {
                  // Canary logic: 30s cooldown & 2-reading hysteresis + telemetry
                  consecutiveDeviationsRef.current += 1;
                  const cooldownElapsed = now - lastRouteFetchTime.current > 30000;
                  console.log(`[ActiveDelivery] Off-route sample #${consecutiveDeviationsRef.current}: ${Math.round(distToPath)}m off polyline (cooldown elapsed: ${cooldownElapsed})`);

                  if (consecutiveDeviationsRef.current >= 2 && cooldownElapsed) {
                    console.log(`[ActiveDelivery] Recalculation triggered: confirmed off-route (${consecutiveDeviationsRef.current} readings, ${Math.round(distToPath)}m)`);

                    // PART B: Client-side Circuit Breaker for Rapid Recalculations (>1/min for 3m)
                    recalcTimestampsRef.current = recalcTimestampsRef.current.filter((t) => now - t < 180000);
                    recalcTimestampsRef.current.push(now);

                    if (recalcTimestampsRef.current.length >= 3) {
                      tripCircuitBreaker('Rapid Off-Route Recalculations (>1/min for 3m)', {
                        recalc_count_3m: recalcTimestampsRef.current.length,
                        last_deviation_meters: Math.round(distToPath),
                      });
                      return;
                    }

                    logTelemetry('off_route_recalculation', orderId, { deviation_meters: Math.round(distToPath), consecutive_samples: consecutiveDeviationsRef.current });

                    consecutiveDeviationsRef.current = 0;
                    void fetchAndDrawRoute();
                  }
                } else {
                  // Baseline logic: 15s debounce single-sample recalculation
                  if (now - lastRouteFetchTime.current > 15000) {
                    lastRouteFetchTime.current = now;
                    void fetchAndDrawRoute();
                  }
                }
              } else {
                consecutiveDeviationsRef.current = 0;
              }
            }
          },
        );
        locationWatchRef.current = sub;
      } catch (err) {
        console.warn('[ActiveDelivery] Local position watcher error:', err);
      }
    }

    void subscribeLocalPosition();

    return () => {
      isCancelled = true;
      if (sub) sub.remove();
      locationWatchRef.current = null;
    };
  }, [activeBundle?.order?.id, isDeliveredSuccess, isFailedState, fetchAndDrawRoute, logTelemetry, tripCircuitBreaker, user?.id]);

  const handleApplyPendingDestination = () => {
    if (!pendingDestinationUpdate) return;
    const { newLat, newLng, shopName: sName, address: sAddr } = pendingDestinationUpdate;
    destCoordsRef.current = { lat: newLat, lng: newLng };
    setDestCoords({ lat: newLat, lng: newLng });
    mapRef.current?.updateDestination(newLat, newLng, sName, sAddr);
    setPendingDestinationUpdate(null);
    setToastNotice('📍 Route updated to new destination pin.');
    setTimeout(() => setToastNotice(null), 4000);
    void fetchAndDrawRoute({ lat: newLat, lng: newLng });
  };

  const handleDismissPendingDestination = () => {
    setPendingDestinationUpdate(null);
  };

  // ─── 5. Navigate Action (Google Maps deep link priority) ───────────────────
  const handleOpenNavigation = async () => {
    const rLat = riderCoords ? riderCoords.lat : 21.150167;
    const rLng = riderCoords ? riderCoords.lng : 79.099140;
    const dLat = destCoords?.lat || 0;
    const dLng = destCoords?.lng || 0;
    const fullAddr = (activeBundle?.delivery_snapshot?.full_address || activeBundle?.order?.delivery_address || '').trim();

    let nativeGoogleMapsUrl = '';
    let webGoogleMapsUrl = '';

    if (Number.isFinite(dLat) && Number.isFinite(dLng) && dLat !== 0 && dLng !== 0 && dLat !== 21.150167) {
      nativeGoogleMapsUrl = `comgooglemaps://?saddr=${rLat},${rLng}&daddr=${dLat},${dLng}&directionsmode=driving`;
      webGoogleMapsUrl = `https://www.google.com/maps/dir/?api=1&origin=${rLat},${rLng}&destination=${dLat},${dLng}&travelmode=driving`;
    } else if (fullAddr !== '') {
      const searchTarget = encodeURIComponent(fullAddr + ', Nagpur');
      nativeGoogleMapsUrl = `comgooglemaps://?saddr=${rLat},${rLng}&daddr=${searchTarget}&directionsmode=driving`;
      webGoogleMapsUrl = `https://www.google.com/maps/dir/?api=1&origin=${rLat},${rLng}&destination=${searchTarget}&travelmode=driving`;
    } else {
      Alert.alert('Location Error', 'Destination coordinates or address text are not available.');
      return;
    }

    try {
      const canOpenNative = await Linking.canOpenURL(nativeGoogleMapsUrl);
      if (canOpenNative) {
        await Linking.openURL(nativeGoogleMapsUrl);
      } else {
        await Linking.openURL(webGoogleMapsUrl);
      }
    } catch {
      await Linking.openURL(webGoogleMapsUrl).catch(() => {
        Alert.alert('Navigation', `Destination: ${fullAddr || `${dLat}, ${dLng}`}`);
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
  if (loading && !activeBundle) {
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
  const isSlaBreached = checkSlaBreach(routeResult?.durationSeconds ?? null, preferredWindow, order.sla_deadline);

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
          <View style={[styles.liveBroadcastDot, gpsQuality === 'poor' && { backgroundColor: '#F59E0B' }]} />
          <Text style={styles.broadcastText} numberOfLines={1}>
            📍 Sharing your location · Order #{order.order_number}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {/* GPS Quality Indicator */}
          <View style={{
            width: 8, height: 8, borderRadius: 4,
            backgroundColor: gpsQuality === 'good' ? '#10B981' : '#F59E0B',
          }} />
          {/* Network Quality Indicator */}
          <Text style={{ fontSize: 10, color: isNetworkConnected ? '#A7F3D0' : '#FCA5A5', fontWeight: '700' }}>
            {isNetworkConnected ? `🟢 ${networkType === 'cellular' ? '4G' : networkType === 'wifi' ? 'WiFi' : 'Online'}` : '🔴 Offline'}
          </Text>
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
      </View>

      {/* ─── Toast Notice Banner (Minor address shift <= 300m) ─────────────── */}
      {toastNotice && (
        <View style={styles.toastNoticeBanner}>
          <Ionicons name="information-circle" size={16} color="#FFFFFF" />
          <Text style={styles.toastNoticeText}>{toastNotice}</Text>
        </View>
      )}

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
        {/* Status Chip Row + Low-Friction Rider Issue Button */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
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

          {isCanaryEnabled && !isCircuitBreakerTripped && (
            <TouchableOpacity
              style={styles.reportIssueBtn}
              onPress={handleReportRouteIssue}
              activeOpacity={0.7}
            >
              <Ionicons name="warning-outline" size={12} color="#D97706" />
              <Text style={styles.reportIssueBtnText}>Route Issue?</Text>
            </TouchableOpacity>
          )}
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

      {/* ─── Significant Destination Shift Acknowledgment Modal (> 300m) ──── */}
      {pendingDestinationUpdate && (
        <Modal
          visible={Boolean(pendingDestinationUpdate)}
          transparent
          animationType="fade"
          onRequestClose={() => setPendingDestinationUpdate(null)}
        >
          <View style={styles.shiftModalOverlay}>
            <View style={styles.shiftModalCard}>
              <View style={styles.shiftModalIconWrap}>
                <Ionicons name="location" size={32} color="#1565C0" />
              </View>
              <Text style={styles.shiftModalTitle}>Destination Address Updated</Text>
              <Text style={styles.shiftModalSubtitle}>
                The store location was updated by dispatch (+{pendingDestinationUpdate.shiftMeters >= 1000 ? (pendingDestinationUpdate.shiftMeters / 1000).toFixed(1) + ' km' : pendingDestinationUpdate.shiftMeters + ' m'} shift).
              </Text>
              {pendingDestinationUpdate.address ? (
                <View style={styles.shiftModalAddressBox}>
                  <Text style={styles.shiftModalAddressLabel}>New Address:</Text>
                  <Text style={styles.shiftModalAddressText}>{pendingDestinationUpdate.address}</Text>
                </View>
              ) : null}
              <View style={styles.shiftModalBtnRow}>
                <TouchableOpacity
                  style={styles.shiftModalDismissBtn}
                  onPress={() => setPendingDestinationUpdate(null)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.shiftModalDismissText}>Keep Current</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.shiftModalAcceptBtn}
                  onPress={handleApplyPendingDestination}
                  activeOpacity={0.8}
                >
                  <Text style={styles.shiftModalAcceptText}>Update Route</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
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
    height: SCREEN_HEIGHT < 700 ? Math.round(SCREEN_HEIGHT * 0.35) : Math.round(SCREEN_HEIGHT * 0.40),
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
    paddingBottom: 40,
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

  // Toast Notice Banner
  toastNoticeBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1E293B',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  toastNoticeText: {
    color: '#F8FAFC',
    fontSize: 13,
    fontWeight: '700',
    flex: 1,
  },

  // Shift Modal
  shiftModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.75)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  shiftModalCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: 24,
    alignItems: 'center',
    width: '100%',
    maxWidth: 360,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.25,
    shadowRadius: 20,
    elevation: 16,
  },
  shiftModalIconWrap: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#E3F2FD',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  shiftModalTitle: {
    fontSize: 18,
    fontWeight: '900',
    color: '#0F172A',
    marginBottom: 8,
    textAlign: 'center',
  },
  shiftModalSubtitle: {
    fontSize: 13,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 16,
  },
  shiftModalAddressBox: {
    backgroundColor: '#F8FAFC',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    padding: 12,
    width: '100%',
    marginBottom: 20,
  },
  shiftModalAddressLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: '#94A3B8',
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  shiftModalAddressText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1E293B',
    lineHeight: 18,
  },
  shiftModalBtnRow: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
  },
  shiftModalDismissBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: '#F1F5F9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shiftModalDismissText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#64748B',
  },
  shiftModalAcceptBtn: {
    flex: 1.3,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: '#1565C0',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 4,
  },
  shiftModalAcceptText: {
    fontSize: 13,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  reportIssueBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#FEF3C7',
    borderWidth: 1,
    borderColor: '#FDE68A',
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
  },
  reportIssueBtnText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#B45309',
  },
});
