import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
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

const GOOGLE_API_KEY = (process.env.EXPO_PUBLIC_GOOGLE_VISION_API_KEY || '').trim();

type DeliveryStop = {
  orderId: string;
  orderNumber: string;
  retailerName: string;
  phone: string;
  address: string;
  status: string;
  grandTotal: number;
};

type OptimizedStop = DeliveryStop & {
  legDistance?: string;
  legDuration?: string;
};

export default function TodaysPath() {
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

      // 1. Get user location via navigator.geolocation (works in Expo Go)
      let loc = { lat: 20.5937, lng: 78.9629 }; // Default: center of India

      try {
        const position = await new Promise<GeolocationPosition>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: false,
            timeout: 10000,
            maximumAge: 60000,
          });
        });
        loc = { lat: position.coords.latitude, lng: position.coords.longitude };
      } catch {
        console.log('Could not get location, using default');
      }

      setUserLocation(loc);

      // 2. Fetch today's undelivered orders
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const endOfDay = new Date();
      endOfDay.setHours(23, 59, 59, 999);

      const { data, error: dbError } = await supabase
        .from('orders')
        .select('id, order_number, user_id, user_name, user_phone, delivery_address, status, grand_total')
        .gte('created_at', today.toISOString())
        .lte('created_at', endOfDay.toISOString())
        .not('status', 'in', '(delivered,cancelled)')
        .order('created_at', { ascending: true });

      if (dbError) throw dbError;

      // Fetch latest profile addresses for all retailers in these orders
      const userIds = [...new Set((data || []).map((o: any) => o.user_id).filter(Boolean))];
      const profileAddressMap: Record<string, string> = {};

      if (userIds.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, address, city, state, pincode')
          .in('id', userIds);

        (profiles || []).forEach((p: any) => {
          const fullAddr = [p.address, p.city, p.state, p.pincode].filter(Boolean).join(', ');
          if (fullAddr.trim()) profileAddressMap[p.id] = fullAddr;
        });
      }

      const deliveryStops: DeliveryStop[] = (data || [])
        .map((o: any) => {
          // Use live profile address if available, otherwise fall back to stored delivery_address
          const liveAddress = o.user_id ? profileAddressMap[o.user_id] : null;
          const address = liveAddress || o.delivery_address || '';
          return {
            orderId: o.id,
            orderNumber: o.order_number,
            retailerName: o.user_name || 'Retailer',
            phone: o.user_phone || '—',
            address,
            status: o.status,
            grandTotal: o.grand_total || 0,
          };
        })
        .filter((s: DeliveryStop) => s.address.trim() !== '');

      setStops(deliveryStops);

      if (deliveryStops.length === 0) {
        setLoading(false);
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
          address: deliveryStops[deliveryStops.length - 1].address,
        },
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_AWARE',
        computeAlternativeRoutes: false,
        languageCode: 'en',
        regionCode: 'IN',
      };

      // Add intermediates (waypoints) if more than 1 stop
      if (deliveryStops.length > 1) {
        body.intermediates = deliveryStops.slice(0, -1).map((s) => ({
          address: s.address,
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

    const destination = encodeURIComponent(
      optimizedStops[optimizedStops.length - 1].address
    );

    let waypointsStr = '';
    if (optimizedStops.length > 1) {
      const midStops = optimizedStops
        .slice(0, -1)
        .map((s) => encodeURIComponent(s.address))
        .join('|');
      waypointsStr = `&waypoints=${midStops}`;
    }

    // Omit origin so Google Maps uses the device's live current location
    const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${destination}${waypointsStr}&travelmode=driving`;

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
          <ActivityIndicator size="large" color="#4C51C9" />
          <Text style={{ marginTop: 12, color: '#666' }}>
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
          <Ionicons name="navigate-outline" size={64} color="#ccc" />
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
                <Ionicons name="navigate" size={22} color="#4C51C9" />
                <Text style={styles.statValue}>{routeInfo.distance}</Text>
                <Text style={styles.statLabel}>Total Distance</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.statItem}>
                <Ionicons name="time" size={22} color="#FB8C00" />
                <Text style={styles.statValue}>{routeInfo.duration}</Text>
                <Text style={styles.statLabel}>Est. Drive Time</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.statItem}>
                <Ionicons name="cash" size={22} color="#43A047" />
                <Text style={styles.statValue}>
                  ₹{stopsToShow.reduce((s, st) => s + st.grandTotal, 0).toFixed(0)}
                </Text>
                <Text style={styles.statLabel}>Total Value</Text>
              </View>
            </View>

            <TouchableOpacity style={styles.mapsBtn} onPress={openInGoogleMaps}>
              <Ionicons name="navigate-circle" size={22} color="#fff" />
              <Text style={styles.mapsBtnText}>Open in Google Maps</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Error banner */}
        {error && (
          <View style={styles.errorBanner}>
            <Ionicons name="warning" size={18} color="#E65100" />
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
            <Ionicons name="location" size={16} color="#fff" />
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
                    <Ionicons name="receipt-outline" size={12} color="#4C51C9" />
                    <Text style={styles.metaText}>#{stop.orderNumber}</Text>
                  </View>
                  {'legDistance' in stop && (stop as OptimizedStop).legDistance ? (
                    <View style={styles.metaItem}>
                      <Ionicons name="car-outline" size={12} color="#666" />
                      <Text style={styles.metaText}>
                        {(stop as OptimizedStop).legDistance} · {(stop as OptimizedStop).legDuration}
                      </Text>
                    </View>
                  ) : null}
                  <View
                    style={[
                      styles.statusChip,
                      { backgroundColor: stop.status === 'pending' ? '#FFF3E0' : '#E3F2FD' },
                    ]}
                  >
                    <Text
                      style={[
                        styles.statusChipText,
                        { color: stop.status === 'pending' ? '#E65100' : '#1565C0' },
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
                    <Ionicons name="call-outline" size={14} color="#4C51C9" />
                    <Text style={styles.actionChipText}>{stop.phone}</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.directionChip}
                    onPress={() => {
                      const url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
                        stop.address
                      )}&travelmode=driving`;
                      Linking.openURL(url);
                    }}
                  >
                    <Ionicons name="navigate-outline" size={14} color="#fff" />
                    <Text style={styles.directionChipText}>Directions</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </React.Fragment>
        ))}

        {/* End marker */}
        <View style={[styles.startCard, { marginBottom: 30 }]}>
          <View style={[styles.startDot, { backgroundColor: '#43A047' }]}>
            <Ionicons name="checkmark" size={16} color="#fff" />
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
            <Ionicons name="navigate-circle" size={22} color="#fff" />
            <Text style={styles.footerBtnText}>Start Navigation in Google Maps</Text>
          </TouchableOpacity>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: '#555', marginTop: 16 },
  emptySubtitle: { fontSize: 14, color: '#888', marginTop: 8, textAlign: 'center' },
  primaryBtn: {
    marginTop: 20,
    backgroundColor: '#4C51C9',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
  },
  primaryBtnText: { color: '#fff', fontWeight: '700' },

  summaryCard: {
    backgroundColor: '#fff',
    margin: 16,
    borderRadius: 16,
    padding: 16,
    elevation: 2,
    shadowColor: '#000',
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
  summaryTitle: { fontSize: 17, fontWeight: '700', color: '#333' },
  badge: {
    backgroundColor: '#EDE7F6',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  badgeText: { color: '#4C51C9', fontSize: 12, fontWeight: '700' },
  summaryStats: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    marginBottom: 16,
  },
  statItem: { alignItems: 'center', flex: 1 },
  statValue: { fontSize: 16, fontWeight: '700', color: '#333', marginTop: 6 },
  statLabel: { fontSize: 11, color: '#888', marginTop: 2 },
  statDivider: { width: 1, height: 40, backgroundColor: '#eee' },
  mapsBtn: {
    backgroundColor: '#4C51C9',
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 13,
    gap: 8,
  },
  mapsBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },

  errorBanner: {
    backgroundColor: '#FFF3E0',
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 10,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  errorText: { flex: 1, color: '#E65100', fontSize: 13 },

  stopsHeader: { paddingHorizontal: 16, marginBottom: 12 },
  stopsHeaderTitle: { fontSize: 16, fontWeight: '700', color: '#333' },
  stopsHeaderSub: { fontSize: 12, color: '#888', marginTop: 2 },

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
    backgroundColor: '#4C51C9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  startLabel: { fontSize: 14, fontWeight: '700', color: '#333' },
  startSub: { fontSize: 12, color: '#888', marginTop: 1 },

  connector: {
    width: 2,
    height: 16,
    backgroundColor: '#ddd',
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
    backgroundColor: '#4C51C9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopNumberText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  stopLine: {
    width: 2,
    flex: 1,
    backgroundColor: '#ddd',
    marginVertical: 4,
  },
  stopContent: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
  },
  stopTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  stopName: { fontSize: 15, fontWeight: '700', color: '#333', flex: 1, marginRight: 8 },
  stopAmount: { fontSize: 14, fontWeight: '700', color: '#43A047' },
  stopAddress: { fontSize: 13, color: '#666', marginTop: 4, lineHeight: 18 },
  stopMeta: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
    alignItems: 'center',
  },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaText: { fontSize: 12, color: '#666' },
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
    backgroundColor: '#f0f0ff',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  actionChipText: { color: '#4C51C9', fontSize: 12, fontWeight: '600' },
  directionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#4C51C9',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  directionChipText: { color: '#fff', fontSize: 12, fontWeight: '600' },

  footer: {
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#eee',
    padding: 16,
  },
  footerBtn: {
    backgroundColor: '#4C51C9',
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 15,
    gap: 8,
  },
  footerBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
