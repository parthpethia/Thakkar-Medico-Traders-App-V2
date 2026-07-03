import React, { useEffect, useState } from 'react';
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
import { supabase } from '../../src/services/supabase';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import type { AppColors } from '../../src/theme/colors';
import * as Location from 'expo-location';
import {
  googleMapsDirUrl,
  resolveOrderCoords,
} from '../../src/utils/orderDeliveryCoords';
import { Order } from '../../src/types';

const GOOGLE_API_KEY = (process.env.EXPO_PUBLIC_GOOGLE_VISION_API_KEY || '').trim();

type DeliveryStop = {
  orderId: string;
  orderNumber: string;
  retailerName: string;
  phone: string;
  address: string;
  lat: number;
  lng: number;
  status: string;
  grandTotal: number;
};

type OptimizedStop = DeliveryStop & {
  legDistance?: string;
  legDuration?: string;
};

export default function TodaysPath() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [stops, setStops] = useState<DeliveryStop[]>([]);
  const [optimizedStops, setOptimizedStops] = useState<OptimizedStop[]>([]);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [routeInfo, setRouteInfo] = useState<{ distance: string; duration: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    init();
  }, []);

  const init = async () => {
    try {
      setLoading(true);
      setError(null);

      let loc = { lat: 20.5937, lng: 78.9629 };

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

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const endOfDay = new Date();
      endOfDay.setHours(23, 59, 59, 999);

      const { data, error: dbError } = await supabase.rpc('get_orders_page', {
        p_role: 'delivery',
        p_user_id: null as unknown as string,
        p_status: null,
        p_cursor: null,
        p_cursor_id: null,
        p_page_size: 100,
        p_from_date: today.toISOString(),
        p_to_date: endOfDay.toISOString(),
        p_area: null,
      });

      if (dbError) throw dbError;

      const rows = (data || []) as Order[];
      const routeOrders = rows.filter(
        (o) =>
          o.fulfillment_mode === 'delivery' &&
          ['accepted', 'picked_up', 'dispatched'].includes(o.status),
      );

      const deliveryStops: DeliveryStop[] = [];

      for (const o of routeOrders) {
        const coords = await resolveOrderCoords(supabase, o);
        if (!coords) continue;
        deliveryStops.push({
          orderId: o.id,
          orderNumber: o.order_number,
          retailerName: o.user_name || 'Retailer',
          phone: o.user_phone || '—',
          address: o.delivery_address || `${coords.lat}, ${coords.lng}`,
          lat: coords.lat,
          lng: coords.lng,
          status: o.status,
          grandTotal: o.grand_total || 0,
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
  };

  const calculateOptimalRoute = async (
    origin: { lat: number; lng: number },
    deliveryStops: DeliveryStop[]
  ) => {
    try {
      if (deliveryStops.length === 0) return;

      // Use Google Routes API (new) instead of legacy Directions API
      const body: any = {
        origin: {
          location: { latLng: { latitude: origin.lat, longitude: origin.lng } },
        },
        destination: {
          location: {
            latLng: {
              latitude: deliveryStops[deliveryStops.length - 1].lat,
              longitude: deliveryStops[deliveryStops.length - 1].lng,
            },
          },
        },
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_AWARE',
        computeAlternativeRoutes: false,
        languageCode: 'en',
        regionCode: 'IN',
      };

      if (deliveryStops.length > 1) {
        body.intermediates = deliveryStops.slice(0, -1).map((s) => ({
          location: { latLng: { latitude: s.lat, longitude: s.lng } },
        }));
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
        setOptimizedStops(deliveryStops);
        setError(
          `Route optimization unavailable (${result.error.status || result.error.code}). Showing stops in original order.`
        );
        return;
      }

      if (!result.routes || result.routes.length === 0) {
        console.log('Routes API returned no routes');
        setOptimizedStops(deliveryStops);
        setError('No route found. Showing stops in original order.');
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
        // Waypoints reordered by optimizedIntermediateWaypointIndex
        for (let i = 0; i < waypointOrder.length; i++) {
          const originalIndex = waypointOrder[i];
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
    const destination = `${last.lat},${last.lng}`;

    let waypointsStr = '';
    if (optimizedStops.length > 1) {
      const midStops = optimizedStops
        .slice(0, -1)
        .map((s) => `${s.lat},${s.lng}`)
        .join('|');
      waypointsStr = `&waypoints=${encodeURIComponent(midStops)}`;
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
        <Stack.Screen options={{ title: "Today's Path" }} />
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
        <Stack.Screen options={{ title: "Today's Path" }} />
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
      <Stack.Screen options={{ title: "Today's Path" }} />

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
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

        {/* Error banner */}
        {error && (
          <View style={styles.errorBanner}>
            <Ionicons name="warning" size={18} color={colors.warning} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* Stops header */}
        <View style={styles.stopsHeader}>
          <Text style={styles.stopsHeaderTitle}>Delivery Sequence</Text>
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

        {stopsToShow.map((stop, index) => (
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
                  <Text style={styles.stopName} numberOfLines={1}>
                    {stop.retailerName}
                  </Text>
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
                  <TouchableOpacity
                    style={styles.actionChip}
                    onPress={() => callRetailer(stop.phone)}
                  >
                    <Ionicons name="call-outline" size={14} color={colors.primary} />
                    <Text style={styles.actionChipText}>{stop.phone}</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.directionChip}
                    onPress={() => Linking.openURL(googleMapsDirUrl(stop.lat, stop.lng))}
                  >
                    <Ionicons name="navigate-outline" size={14} color={colors.onPrimary} />
                    <Text style={styles.directionChipText}>Directions</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </React.Fragment>
        ))}

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
  emptyTitle: { fontSize: 18, fontWeight: '700', color: c.textSecondary, marginTop: 16 },
  emptySubtitle: { fontSize: 14, color: c.textMuted, marginTop: 8, textAlign: 'center' },
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
    elevation: 2,
    shadowColor: c.shadow,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  summaryTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  summaryTitle: { fontSize: 17, fontWeight: '700', color: c.text },
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
  statValue: { fontSize: 16, fontWeight: '700', color: c.text, marginTop: 6 },
  statLabel: { fontSize: 11, color: c.textMuted, marginTop: 2 },
  statDivider: { width: 1, height: 40, backgroundColor: c.border },
  mapsBtn: {
    backgroundColor: c.primary,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 13,
    gap: 8,
  },
  mapsBtnText: { color: c.surface, fontSize: 15, fontWeight: '700' },

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
  errorText: { flex: 1, color: c.warning, fontSize: 13 },

  stopsHeader: { paddingHorizontal: 16, marginBottom: 12 },
  stopsHeaderTitle: { fontSize: 16, fontWeight: '700', color: c.text },
  stopsHeaderSub: { fontSize: 12, color: c.textMuted, marginTop: 2 },

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
  },
  startLabel: { fontSize: 14, fontWeight: '700', color: c.text },
  startSub: { fontSize: 12, color: c.textMuted, marginTop: 1 },

  connector: {
    width: 2,
    height: 16,
    backgroundColor: c.switchTrackOff,
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
  },
  stopNumberText: { color: c.surface, fontWeight: '700', fontSize: 14 },
  stopLine: {
    width: 2,
    flex: 1,
    backgroundColor: c.switchTrackOff,
    marginVertical: 4,
  },
  stopContent: {
    flex: 1,
    backgroundColor: c.surface,
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
  },
  stopTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  stopName: { fontSize: 15, fontWeight: '700', color: c.text, flex: 1, marginRight: 8 },
  stopAmount: { fontSize: 14, fontWeight: '700', color: c.success },
  stopAddress: { fontSize: 13, color: c.textSecondary, marginTop: 4, lineHeight: 18 },
  stopMeta: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
    alignItems: 'center',
  },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaText: { fontSize: 12, color: c.textSecondary },
  statusChip: {
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  statusChipText: { fontSize: 11, fontWeight: '600', textTransform: 'capitalize' },
  stopActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
  },
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

  footer: {
    backgroundColor: c.surface,
    borderTopWidth: 1,
    borderTopColor: c.border,
    padding: 16,
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
};
}
