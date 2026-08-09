import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  ActivityIndicator,
  Alert,
  TouchableOpacity,
  ScrollView,
  Linking,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../../src/services/supabase';
import { useAppTheme } from '../../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../../src/theme/useThemedStyles';
import type { AppColors } from '../../../src/theme/colors';
import * as Location from 'expo-location';
import {
  googleMapsDirUrl,
  resolveOrderCoords,
} from '../../../src/utils/orderDeliveryCoords';
import { Order } from '../../../src/types';
import { TAB_BAR_LAYOUT, tabScrollBottomPadding } from '../../../src/theme/tabBarTheme';
import { getGoogleMapsApiKey } from '../../../src/services/googleMapsApi';
import { useAuthStore } from '../../../src/store/authStore';

const GOOGLE_API_KEY = getGoogleMapsApiKey();

type DeliveryStop = {
  orderId: string;
  orderNumber: string;
  retailerName: string;
  retailerId: string;
  phone: string;
  address: string;
  lat: number;
  lng: number;
  status: string;
  grandTotal: number;
  priority?: number;
  slaDeadline?: string | null;
  manifestId?: string | null;
};

type OptimizedStop = DeliveryStop & {
  legDistance?: string;
  legDuration?: string;
};

export default function TodaysPath() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const router = useRouter();
  const { user } = useAuthStore();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [stops, setStops] = useState<DeliveryStop[]>([]);
  const [optimizedStops, setOptimizedStops] = useState<OptimizedStop[]>([]);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [routeInfo, setRouteInfo] = useState<{ distance: string; duration: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRouteStale, setIsRouteStale] = useState(false);

  const init = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setIsRouteStale(false);

      if (!user?.id) {
        setLoading(false);
        return;
      }

      let loc = { lat: 21.15016745169625, lng: 79.09914048349087 };

      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          const position = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          loc = { lat: position.coords.latitude, lng: position.coords.longitude };
        }
      } catch {
        console.log('Could not get location, using default');
      }

      setUserLocation(loc);

      const { data, error: dbError } = await supabase
        .from('orders')
        .select('*')
        .or(`assigned_to.eq.${user.id},created_by.eq.${user.id}`)
        .eq('fulfillment_mode', 'delivery')
        .in('status', ['accepted', 'picked_up', 'dispatched']);

      if (dbError) throw dbError;

      const routeOrders = (data || []) as Order[];

      const deliveryStops: DeliveryStop[] = [];

      for (const o of routeOrders) {
        const coords = await resolveOrderCoords(supabase, o);
        if (!coords) continue;

        const hasValidCoords = Number.isFinite(coords.lat) && Number.isFinite(coords.lng) && (coords.lat !== 0 || coords.lng !== 0);
        const address = o.delivery_address || coords.address;
        const hasValidAddress = address && address.trim() !== '' && address !== '0, 0';

        if (!hasValidCoords && !hasValidAddress) {
          console.warn(`[Route] Skipping stop for order #${o.order_number} due to missing coords and address`);
          continue;
        }

        deliveryStops.push({
          orderId: o.id,
          orderNumber: o.order_number,
          retailerName: o.user_name || 'Retailer',
          retailerId: o.user_id,
          phone: o.user_phone || '—',
          address: address || 'No address',
          lat: coords.lat,
          lng: coords.lng,
          status: o.status,
          grandTotal: o.grand_total || 0,
          priority: o.priority,
          slaDeadline: o.sla_deadline,
          manifestId: o.manifest_id,
        });
      }

      setStops(deliveryStops);

      if (deliveryStops.length === 0) {
        setLoading(false);
        setError(
          'No GPS stops for today. Accept orders and ensure shop locations have coordinates.',
        );
        return;
      }

      // 3. Calculate optimized route via Google Directions API (REST)
      await calculateOptimalRoute(loc, deliveryStops);
    } catch (err: any) {
      setError(err.message || 'Failed to load delivery data');
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    init();
  }, [init]);

  // In-Place Leg Refresh: Updates only the modified stop's coordinates and leg ETA/distance,
  // strictly preserving the rider's existing stop sequence without reordering the day's route.
  const refreshStopsInPlace = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setIsRouteStale(false);

      if (!user?.id || stops.length === 0) {
        setLoading(false);
        return;
      }

      const orderIds = stops.map(s => s.orderId);
      const { data: updatedOrders, error: fetchErr } = await supabase
        .from('orders')
        .select('*')
        .in('id', orderIds);

      if (fetchErr) throw fetchErr;

      const orderMap = new Map((updatedOrders || []).map((o: any) => [o.id, o]));
      const updatedStops: DeliveryStop[] = [];

      for (const existingStop of stops) {
        const orderData = orderMap.get(existingStop.orderId);
        if (!orderData) {
          updatedStops.push(existingStop);
          continue;
        }

        // If order was finalized, remove it from active stops
        if (['delivered', 'cancelled', 'failed', 'returned'].includes(orderData.status || '') ||
            ['delivered', 'cancelled', 'failed', 'returned'].includes(orderData.delivery_status || '')) {
          continue;
        }

        const coords = await resolveOrderCoords(supabase, orderData);
        const lat = coords?.lat || existingStop.lat;
        const lng = coords?.lng || existingStop.lng;
        const address = orderData.delivery_address || coords?.address || existingStop.address;

        updatedStops.push({
          ...existingStop,
          lat,
          lng,
          address,
          grandTotal: orderData.grand_total || existingStop.grandTotal,
          priority: orderData.priority ?? existingStop.priority,
          slaDeadline: orderData.sla_deadline || existingStop.slaDeadline,
          status: orderData.status || existingStop.status,
        });
      }

      setStops(updatedStops);

      const loc = userLocation || { lat: 21.15016745169625, lng: 79.09914048349087 };
      // Recalculate legs in-place via OSRM, strictly keeping existing stop sequence
      await calculateOptimalRouteOSRM(loc, updatedStops);
    } catch (err: any) {
      console.warn('[TodaysPath] In-place refresh error:', err);
      setError('Could not update stop location. Pull down to retry.');
    } finally {
      setLoading(false);
    }
  }, [user?.id, stops, userLocation]);

  // Realtime subscription for mid-day route staleness flagging
  useEffect(() => {
    if (!user?.id) return;

    const channel = supabase
      .channel(`todays_path_orders_${user.id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'orders' },
        (payload) => {
          const updated = payload.new as any;
          if (updated.assigned_to === user.id || updated.created_by === user.id) {
            console.log('[TodaysPath] Assigned order updated mid-day — flagging route as stale');
            setIsRouteStale(true);
          }
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [user?.id]);

  const calculateOptimalRouteOSRM = async (
    origin: { lat: number; lng: number },
    deliveryStops: DeliveryStop[]
  ) => {
    try {
      const coordsSeq = [[origin.lng, origin.lat]];
      deliveryStops.forEach(s => {
        if (s.lng && s.lat) coordsSeq.push([s.lng, s.lat]);
      });

      if (coordsSeq.length <= 1) {
        setOptimizedStops(deliveryStops);
        return;
      }

      const coordsString = coordsSeq.map(c => c[0] + ',' + c[1]).join(';');
      const mirrors = [
        `https://router.project-osrm.org/route/v1/driving/${coordsString}?overview=false&geometries=geojson`,
        `https://routing.openstreetmap.de/routed-car/route/v1/driving/${coordsString}?overview=false&geometries=geojson`,
      ];

      let json: any = null;
      for (const url of mirrors) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 3500);
          const response = await fetch(url, { signal: controller.signal });
          clearTimeout(timer);
          if (response.ok) {
            const data = await response.json();
            if (data.code === 'Ok' && data.routes && data.routes[0]) {
              json = data;
              break;
            }
          }
        } catch {
          // Try next mirror
        }
      }

      if (json && json.routes && json.routes[0]) {
        const route = json.routes[0];
        const legs = route.legs || [];
        const reordered: OptimizedStop[] = [];

        deliveryStops.forEach((stop, idx) => {
          const leg = legs[idx];
          reordered.push({
            ...stop,
            legDistance: leg ? (leg.distance >= 1000 ? (leg.distance / 1000).toFixed(1) + ' km' : Math.round(leg.distance) + ' m') : '—',
            legDuration: leg ? Math.ceil(leg.duration / 60) + ' mins' : '—',
          });
        });

        setOptimizedStops(reordered);

        const totalDist = route.distance || 0;
        const totalDur = route.duration || 0;
        setRouteInfo({
          distance: (totalDist / 1000).toFixed(1) + ' km',
          duration: Math.ceil(totalDur / 60) + ' mins',
        });
        setError(null);
      } else {
        // Guaranteed local calculation using Haversine distance and city speed
        let totalDistanceM = 0;
        let totalDurationS = 0;
        let prevPos = origin;

        const reordered: OptimizedStop[] = deliveryStops.map((stop) => {
          let distM = 0;
          if (stop.lat && stop.lng && prevPos.lat && prevPos.lng) {
            // Haversine straight-line × 1.3 city road factor
            distM = Math.round(haversineDistance(prevPos.lat, prevPos.lng, stop.lat, stop.lng) * 1.3);
            prevPos = { lat: stop.lat, lng: stop.lng };
          }
          const durS = Math.max(60, Math.round((distM / (25 * 1000)) * 3600)); // 25 km/h
          totalDistanceM += distM;
          totalDurationS += durS;

          return {
            ...stop,
            legDistance: distM >= 1000 ? (distM / 1000).toFixed(1) + ' km' : (distM > 0 ? distM + ' m' : '—'),
            legDuration: durS > 0 ? Math.ceil(durS / 60) + ' mins' : '—',
          };
        });

        setOptimizedStops(reordered);
        setRouteInfo({
          distance: (totalDistanceM / 1000).toFixed(1) + ' km',
          duration: Math.ceil(totalDurationS / 60) + ' mins',
        });
        setError(null);
      }
    } catch {
      setOptimizedStops(deliveryStops);
      setError(null);
    }
  };

  function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371000;
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  const calculateOptimalRoute = async (
    origin: { lat: number; lng: number },
    deliveryStops: DeliveryStop[]
  ) => {
    try {
      if (deliveryStops.length === 0) return;

      const destStop = deliveryStops[deliveryStops.length - 1];
      const body: any = {
        origin: {
          location: { latLng: { latitude: origin.lat, longitude: origin.lng } },
        },
        destination: (destStop.lat === 0 && destStop.lng === 0)
          ? { address: destStop.address }
          : {
              location: {
                latLng: {
                  latitude: destStop.lat,
                  longitude: destStop.lng,
                },
              },
            },
        travelMode: 'TWO_WHEELER', // Bike-specific routing for Indian city traffic
        routingPreference: 'TRAFFIC_AWARE',
        computeAlternativeRoutes: false,
        languageCode: 'en',
        regionCode: 'IN',
      };

      if (deliveryStops.length > 1) {
        body.intermediates = deliveryStops.slice(0, -1).map((s) => {
          if (s.lat === 0 && s.lng === 0) {
            return { address: s.address };
          }
          return {
            location: { latLng: { latitude: s.lat, longitude: s.lng } },
          };
        });
        body.optimizeWaypointOrder = true;
      }

      const fieldMask =
        'routes.legs.distanceMeters,routes.legs.duration,' +
        'routes.legs.localizedValues,' +
        'routes.optimizedIntermediateWaypointIndex,' +
        'routes.distanceMeters,routes.duration,routes.localizedValues';

      const response = await fetch(
        'https://routes.googleapis.com/directions/v2:computeRoutes',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': GOOGLE_API_KEY,
            'X-Goog-FieldMask': fieldMask,
          },
          body: JSON.stringify(body),
        }
      );

      const result = await response.json();

      if (result.error) {
        console.log('Routes API error:', result.error.message);
        await calculateOptimalRouteOSRM(origin, deliveryStops);
        return;
      }

      if (!result.routes || result.routes.length === 0) {
        console.log('Routes API returned no routes');
        await calculateOptimalRouteOSRM(origin, deliveryStops);
        return;
      }

      const route = result.routes[0];
      const waypointOrder: number[] = route.optimizedIntermediateWaypointIndex || [];
      const legs = route.legs || [];

      // Build optimized stop list
      const reordered: OptimizedStop[] = [];

      if (deliveryStops.length === 1) {
        const leg = legs[0];
        reordered.push({
          ...deliveryStops[0],
          legDistance: leg?.localizedValues?.distance?.text || formatMeters(leg?.distanceMeters),
          legDuration: leg?.localizedValues?.duration?.text || formatSeconds(leg?.duration),
        });
      } else {
        const intermediatesCount = deliveryStops.length - 1;
        // Use optimized order if available and complete, otherwise fallback to original order
        const order = (waypointOrder && waypointOrder.length === intermediatesCount)
          ? waypointOrder
          : Array.from({ length: intermediatesCount }, (_, i) => i);

        for (let i = 0; i < order.length; i++) {
          const originalIndex = order[i];
          const leg = legs[i];
          reordered.push({
            ...deliveryStops[originalIndex],
            legDistance: leg?.localizedValues?.distance?.text || formatMeters(leg?.distanceMeters),
            legDuration: leg?.localizedValues?.duration?.text || formatSeconds(leg?.duration),
          });
        }
        // Add destination (last stop)
        const lastLeg = legs[legs.length - 1];
        reordered.push({
          ...deliveryStops[deliveryStops.length - 1],
          legDistance: lastLeg?.localizedValues?.distance?.text || formatMeters(lastLeg?.distanceMeters),
          legDuration: lastLeg?.localizedValues?.duration?.text || formatSeconds(lastLeg?.duration),
        });
      }

      setOptimizedStops(reordered);

      // Calculate totals from route-level values or sum legs
      const totalDistM = route.distanceMeters || legs.reduce((s: number, l: any) => s + (l.distanceMeters || 0), 0);
      const totalDurS = parseDuration(route.duration) || legs.reduce((s: number, l: any) => s + parseDuration(l.duration), 0);

      setRouteInfo({
        distance: (totalDistM / 1000).toFixed(1) + ' km',
        duration: Math.ceil(totalDurS / 60) + ' mins',
      });
    } catch (err: any) {
      console.log('Route calculation error:', err);
      setOptimizedStops(deliveryStops);
      setError('Could not optimize route. Showing stops in original order.');
    }
  };

  // Helper: parse Routes API duration string like "1234s" to seconds number
  const parseDuration = (dur: string | undefined): number => {
    if (!dur) return 0;
    return parseInt(dur.replace('s', ''), 10) || 0;
  };

  // Helper: format meters to readable string
  const formatMeters = (m: number | undefined): string => {
    if (!m) return '';
    return m >= 1000 ? (m / 1000).toFixed(1) + ' km' : m + ' m';
  };

  // Helper: format duration string "1234s" to readable
  const formatSeconds = (dur: string | undefined): string => {
    const secs = parseDuration(dur);
    if (secs === 0) return '';
    const mins = Math.ceil(secs / 60);
    return mins >= 60 ? `${Math.floor(mins / 60)} hr ${mins % 60} min` : `${mins} min`;
  };

  const openInGoogleMaps = () => {
    if (optimizedStops.length === 0) return;

    const last = optimizedStops[optimizedStops.length - 1];
    const hasValidLastCoords = Number.isFinite(last.lat) && Number.isFinite(last.lng) && (last.lat !== 0 || last.lng !== 0);
    const destination = hasValidLastCoords ? `${last.lat},${last.lng}` : (last.address || 'Nagpur');

    let waypointsStr = '';
    if (optimizedStops.length > 1) {
      const midStops = optimizedStops
        .slice(0, -1)
        .map((s) => {
          const hasCoords = Number.isFinite(s.lat) && Number.isFinite(s.lng) && (s.lat !== 0 || s.lng !== 0);
          return hasCoords ? `${s.lat},${s.lng}` : s.address.trim();
        })
        .filter(Boolean)
        .join('|');
      if (midStops) {
        waypointsStr = `&waypoints=${encodeURIComponent(midStops)}`;
      }
    }

    const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}${waypointsStr}&travelmode=driving`;

    Linking.openURL(mapsUrl).catch(() => {
      Alert.alert('Error', 'Could not open Google Maps');
    });
  };

  const callRetailer = (phone: string) => {
    if (!phone || phone === '—') return;
    const cleanPhone = phone.replace(/[^+\d]/g, '');
    Linking.openURL(`tel:${cleanPhone}`).catch(() => {
      Alert.alert('Error', 'Could not open phone dialer');
    });
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await init();
    setRefreshing(false);
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={{ marginTop: 12, color: colors.textSecondary }}>
            Calculating best delivery route...
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (stops.length === 0) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Ionicons name="navigate-outline" size={64} color={colors.switchThumbOff} />
          <Text style={styles.emptyTitle}>No Deliveries Today</Text>
          <Text style={styles.emptySubtitle}>
            There are no pending delivery orders for today.
          </Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={() => router.back()}>
            <Text style={styles.primaryBtnText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const stopsToShow = optimizedStops.length > 0 ? optimizedStops : stops;

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        contentContainerStyle={{ paddingBottom: 24 }}
      >
        {/* Route summary */}
        {routeInfo && (
          <View style={styles.summaryCard}>
            <View style={styles.summaryTop}>
              <Text style={styles.summaryTitle}>Optimized Route</Text>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{stopsToShow.length} stops</Text>
              </View>
            </View>

            <View style={styles.summaryStats}>
              <View style={styles.statItem}>
                <Ionicons name="navigate" size={22} color={colors.primary} />
                <Text style={styles.statValue}>{routeInfo.distance}</Text>
                <Text style={styles.statLabel}>Total Distance</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.statItem}>
                <Ionicons name="time" size={22} color={colors.warning} />
                <Text style={styles.statValue}>{routeInfo.duration}</Text>
                <Text style={styles.statLabel}>Est. Drive Time</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.statItem}>
                <Ionicons name="cash" size={22} color={colors.success} />
                <Text style={styles.statValue}>
                  ₹{stopsToShow.reduce((s, st) => s + st.grandTotal, 0).toFixed(0)}
                </Text>
                <Text style={styles.statLabel}>Total Value</Text>
              </View>
            </View>

            <TouchableOpacity style={styles.mapsBtn} onPress={openInGoogleMaps}>
              <Ionicons name="navigate-circle" size={22} color={colors.onPrimary} />
              <Text style={styles.mapsBtnText}>Open in Google Maps</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Stale route alert banner (In-Place leg update — preserves stop order) */}
        {isRouteStale && (
          <TouchableOpacity
            style={styles.staleBanner}
            onPress={() => {
              void refreshStopsInPlace();
            }}
            activeOpacity={0.85}
          >
            <Ionicons name="refresh-circle" size={20} color="#FFFFFF" />
            <Text style={styles.staleBannerText}>
              📍 Stop address updated · Tap to refresh leg (keeps stop order)
            </Text>
            <Ionicons name="chevron-forward" size={16} color="#FFFFFF" />
          </TouchableOpacity>
        )}

        {/* Error banner */}
        {error && (
          <View style={styles.errorBanner}>
            <Ionicons name="warning" size={18} color={colors.warning} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* Stops header */}
        <View style={styles.stopsHeader}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={styles.stopsHeaderTitle}>Delivery Sequence</Text>
            <TouchableOpacity onPress={() => void init()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={{ fontSize: 12, color: colors.primary, fontWeight: '700' }}>Re-optimize Order</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.stopsHeaderSub}>
            Stops listed in optimized order
          </Text>
        </View>

        {/* Starting point */}
        <View style={styles.startCard}>
          <View style={styles.startDot}>
            <Ionicons name="location" size={16} color={colors.onPrimary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.startLabel}>Starting Point</Text>
            <Text style={styles.startSub}>Your current location</Text>
          </View>
        </View>

        <View style={styles.connector} />

        {stopsToShow.map((stop, index) => {
          let slaText = '';
          let isDeadlineOverdue = false;
          let isDeadlineCritical = false;
          let isDeadlineApproaching = false;

          if (stop.slaDeadline) {
            const diff = new Date(stop.slaDeadline).getTime() - Date.now();
            if (diff <= 0) {
              slaText = 'SLA Overdue';
              isDeadlineOverdue = true;
            } else {
              const leftMins = Math.ceil(diff / 60000);
              slaText = leftMins < 60 ? `${leftMins}m` : `${Math.floor(leftMins/60)}h ${leftMins%60}m`;
              if (leftMins <= 30) isDeadlineCritical = true;
              else if (leftMins <= 60) isDeadlineApproaching = true;
            }
          }

          const isUrgent = stop.priority === 1 || isDeadlineOverdue || isDeadlineCritical;
          const isHigh = !isUrgent && (stop.priority === 2 || isDeadlineApproaching);
          const slaColor = isUrgent ? colors.error : (isHigh ? colors.warning : colors.textSecondary);

          return (
            <React.Fragment key={stop.orderId}>
              <View style={styles.stopCard}>
                <View style={styles.stopLeft}>
                  <View style={styles.stopNumber}>
                    <Text style={styles.stopNumberText}>{index + 1}</Text>
                  </View>
                  {index < stopsToShow.length - 1 && <View style={styles.stopLine} />}
                </View>

                <View style={styles.stopContent}>
                  <View style={styles.stopTitleRow}>
                    <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={styles.stopName} numberOfLines={1}>
                        {stop.retailerName}
                      </Text>
                      {isUrgent && (
                        <View style={[styles.priorityBadge, { backgroundColor: colors.error }]}>
                          <Text style={styles.priorityText}>URGENT</Text>
                        </View>
                      )}
                      {isHigh && (
                        <View style={[styles.priorityBadge, { backgroundColor: colors.warning }]}>
                          <Text style={styles.priorityText}>HIGH</Text>
                        </View>
                      )}
                    </View>
                    <Text style={styles.stopAmount}>₹{stop.grandTotal.toFixed(0)}</Text>
                  </View>

                  <Text style={styles.stopAddress} numberOfLines={2}>
                    {stop.address}
                  </Text>

                  <View style={styles.stopMeta}>
                    <View style={styles.metaItem}>
                      <Ionicons name="receipt-outline" size={12} color={colors.primary} />
                      <Text style={styles.metaText}>#{stop.orderNumber}</Text>
                    </View>
                    {slaText ? (
                      <View style={styles.metaItem}>
                        <Ionicons name="time-outline" size={12} color={slaColor} />
                        <Text style={[styles.metaText, { color: slaColor, fontWeight: '700' }]}>
                          {slaText}
                        </Text>
                      </View>
                    ) : null}
                    {'legDistance' in stop && (stop as OptimizedStop).legDistance ? (
                      <View style={styles.metaItem}>
                        <Ionicons name="car-outline" size={12} color={colors.textSecondary} />
                        <Text style={styles.metaText}>
                          {(stop as OptimizedStop).legDistance} · {(stop as OptimizedStop).legDuration}
                        </Text>
                      </View>
                    ) : null}
                    <View
                      style={[
                        styles.statusChip,
                        { backgroundColor: stop.status === 'pending' ? colors.warningBg : colors.primaryMuted },
                      ]}
                    >
                      <Text
                        style={[
                          styles.statusChipText,
                          { color: stop.status === 'pending' ? colors.warning : colors.primary },
                        ]}
                      >
                        {stop.status}
                      </Text>
                    </View>
                  </View>

                <View style={styles.stopActions}>
                  {(stop.status === 'dispatched' || stop.status === 'picked_up') && (
                    <TouchableOpacity
                      style={styles.liveChip}
                      onPress={() => router.push(`/delivery/active-delivery?orderId=${stop.orderId}`)}
                    >
                      <Ionicons name="compass-outline" size={14} color="#FFFFFF" />
                      <Text style={styles.liveChipText}>Live Track</Text>
                    </TouchableOpacity>
                  )}

                  <TouchableOpacity
                    style={styles.actionChip}
                    onPress={() => callRetailer(stop.phone)}
                  >
                    <Ionicons name="call-outline" size={14} color={colors.primary} />
                    <Text style={styles.actionChipText}>Call</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.directionChip}
                    onPress={() => {
                      const url = googleMapsDirUrl(stop.lat, stop.lng, stop.address, userLocation ? { lat: userLocation.lat, lng: userLocation.lng } : undefined);
                      if (url) {
                        Linking.openURL(url).catch(() => Alert.alert('Error', 'Could not open maps'));
                      } else {
                        Alert.alert('Error', 'Address and coordinates are invalid.');
                      }
                    }}
                  >
                    <Ionicons name="navigate-outline" size={14} color={colors.onPrimary} />
                    <Text style={styles.directionChipText}>Maps</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.orderChip}
                    onPress={() => router.push(`/delivery/${stop.orderId}`)}
                  >
                    <Ionicons name="document-text-outline" size={14} color={colors.primary} />
                    <Text style={styles.orderChipText}>Console</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </React.Fragment>
          );
        })}

        {/* End marker */}
        <View style={[styles.startCard, { marginBottom: 30 }]}>
          <View style={[styles.startDot, { backgroundColor: colors.success }]}>
            <Ionicons name="checkmark" size={16} color={colors.onPrimary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.startLabel}>Route Complete</Text>
            <Text style={styles.startSub}>All deliveries done!</Text>
          </View>
        </View>
      </ScrollView>

      {/* Bottom navigation button */}
      {optimizedStops.length > 0 && (
        <View style={styles.footer}>
          <TouchableOpacity style={styles.footerBtn} onPress={openInGoogleMaps}>
            <Ionicons name="navigate-circle" size={22} color={colors.onPrimary} />
            <Text style={styles.footerBtnText}>Start Navigation in Google Maps</Text>
          </TouchableOpacity>
        </View>
      )}
    </SafeAreaView>
  );
}

function createStyles(c: AppColors, isDark: boolean) {
  return {
  container: { flex: 1, backgroundColor: c.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: c.textSecondary, marginTop: 16 },
  emptySubtitle: { fontSize: 14, color: c.textMuted, marginTop: 8, textAlign: 'center', lineHeight: 20 },
  primaryBtn: {
    marginTop: 20,
    backgroundColor: c.primary,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
  },
  primaryBtnText: { color: c.surface, fontWeight: '700' },

  summaryCard: {
    backgroundColor: c.surface,
    margin: 16,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: c.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
  },
  summaryTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  summaryTitle: { fontSize: 17, fontWeight: '800', color: c.text },
  badge: {
    backgroundColor: c.primaryMuted,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  badgeText: { color: c.primary, fontSize: 12, fontWeight: '700' },
  summaryStats: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    marginBottom: 16,
  },
  statItem: { alignItems: 'center', flex: 1 },
  statValue: { fontSize: 16, fontWeight: '800', color: c.text, marginTop: 6 },
  statLabel: { fontSize: 11, color: c.textMuted, marginTop: 2, fontWeight: '500' },
  statDivider: { width: 1, height: 40, backgroundColor: c.border },
  mapsBtn: {
    backgroundColor: c.primary,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    gap: 8,
  },
  mapsBtnText: { color: c.surface, fontSize: 15, fontWeight: '700' },

  staleBanner: {
    backgroundColor: '#0F766E',
    marginHorizontal: 16,
    marginBottom: 10,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    shadowColor: '#0F766E',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 6,
    elevation: 3,
  },
  staleBannerText: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },

  errorBanner: {
    backgroundColor: c.warningBg,
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 10,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  errorText: { flex: 1, color: c.warning, fontSize: 13, fontWeight: '500' },

  stopsHeader: { paddingHorizontal: 16, marginBottom: 12 },
  stopsHeaderTitle: { fontSize: 16, fontWeight: '800', color: c.text, textTransform: 'uppercase' as const, letterSpacing: 0.5 },
  stopsHeaderSub: { fontSize: 12, color: c.textMuted, marginTop: 2, fontWeight: '500' },

  startCard: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    gap: 12,
    paddingVertical: 8,
  },
  startDot: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: c.primary,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: c.primary,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 3,
    elevation: 2,
  },
  startLabel: { fontSize: 14, fontWeight: '700', color: c.text },
  startSub: { fontSize: 12, color: c.textMuted, marginTop: 1, fontWeight: '500' },

  connector: {
    width: 2,
    height: 16,
    backgroundColor: c.border,
    marginLeft: 31,
  },

  stopCard: {
    flexDirection: 'row',
    marginHorizontal: 16,
  },
  stopLeft: { alignItems: 'center', width: 32, marginRight: 12 },
  stopNumber: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: c.primary,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: c.primary,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 3,
    elevation: 2,
  },
  stopNumberText: { color: c.surface, fontWeight: '800', fontSize: 13 },
  stopLine: {
    width: 2,
    flex: 1,
    backgroundColor: c.border,
    marginVertical: 4,
  },
  stopContent: {
    flex: 1,
    backgroundColor: c.surface,
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: c.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
  },
  stopTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  stopName: { fontSize: 15, fontWeight: '700', color: c.text, flex: 1, marginRight: 8 },
  stopAmount: { fontSize: 14, fontWeight: '800', color: c.success },
  stopAddress: { fontSize: 13, color: c.textSecondary, marginTop: 4, lineHeight: 18, fontWeight: '500' },
  stopMeta: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
    alignItems: 'center',
  },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaText: { fontSize: 12, color: c.textSecondary, fontWeight: '500' },
  statusChip: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  statusChipText: { fontSize: 11, fontWeight: '700', textTransform: 'capitalize' },
  stopActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
  },
  liveChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#1565C0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  liveChipText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
  actionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: c.primaryMuted,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  actionChipText: { color: c.primary, fontSize: 12, fontWeight: '600' },
  directionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: c.primary,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  directionChipText: { color: c.surface, fontSize: 12, fontWeight: '600' },
  orderChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: c.primaryMuted,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  orderChipText: { color: c.primary, fontSize: 12, fontWeight: '600' },

  footer: {
    backgroundColor: c.surface,
    borderTopWidth: 1,
    borderTopColor: c.border,
    padding: 16,
    paddingBottom: TAB_BAR_LAYOUT.spacerHeight + 8,
  },
  footerBtn: {
    backgroundColor: c.primary,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 15,
    gap: 8,
  },
  footerBtnText: { color: c.surface, fontSize: 16, fontWeight: '700' },
  priorityBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1.5,
    borderRadius: 4,
  },
  priorityText: {
    fontSize: 8,
    fontWeight: '900' as const,
    color: '#FFFFFF',
  },
  } as const;
}
