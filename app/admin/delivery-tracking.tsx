import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { formatDistanceToNow } from 'date-fns';
import { supabase } from '../../src/services/supabase';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import type { AppColors } from '../../src/theme/colors';
import { useRealtimeOrders } from '../../src/hooks/useRealtimeOrders';

type DriverRow = {
  profile_id: string;
  lat: number;
  lng: number;
  recorded_at: string;
  name: string;
  phone: string | null;
};

export default function AdminDeliveryTracking() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [drivers, setDrivers] = useState<DriverRow[]>([]);

  const load = useCallback(async () => {
    try {
      const { data: locations, error } = await supabase
        .from('driver_locations')
        .select('profile_id, lat, lng, recorded_at')
        .order('recorded_at', { ascending: false });

      if (error) throw error;

      const ids = [...new Set((locations || []).map((l) => l.profile_id))];
      const nameMap: Record<string, { name: string; phone: string | null }> = {};

      if (ids.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, name, business_name, phone')
          .in('id', ids);

        (profiles || []).forEach((p: any) => {
          nameMap[p.id] = {
            name: p.name || p.business_name || 'Driver',
            phone: p.phone,
          };
        });
      }

      setDrivers(
        (locations || []).map((l) => ({
          ...l,
          name: nameMap[l.profile_id]?.name || 'Driver',
          phone: nameMap[l.profile_id]?.phone ?? null,
        })),
      );
    } catch (err: unknown) {
      console.error(err);
    }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await load();
      setLoading(false);
    })();
  }, [load]);

  useRealtimeOrders({
    table: 'driver_locations',
    event: '*',
    onInsert: () => void load(),
    onUpdate: () => void load(),
  });

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  return (
    <SafeAreaView style={styles.container}>
      <Stack.Screen options={{ title: 'Live drivers' }} />
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <ScrollView
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        >
          <Text style={styles.hint}>
            Positions update every 60 seconds while a driver has dispatched orders.
          </Text>
          {drivers.length === 0 ? (
            <View style={styles.center}>
              <Ionicons name="navigate-outline" size={48} color={colors.textMuted} />
              <Text style={styles.empty}>No live driver locations yet.</Text>
            </View>
          ) : (
            drivers.map((d) => (
              <View key={d.profile_id} style={styles.card}>
                <Text style={styles.name}>{d.name}</Text>
                <Text style={styles.meta}>
                  Updated {formatDistanceToNow(new Date(d.recorded_at), { addSuffix: true })}
                </Text>
                <Text style={styles.coords}>
                  {d.lat.toFixed(5)}, {d.lng.toFixed(5)}
                </Text>
                <TouchableOpacity
                  style={styles.mapBtn}
                  onPress={() =>
                    Linking.openURL(
                      `https://www.google.com/maps?q=${d.lat},${d.lng}`,
                    )
                  }
                >
                  <Ionicons name="map-outline" size={18} color={colors.onPrimary} />
                  <Text style={styles.mapBtnText}>Open in Maps</Text>
                </TouchableOpacity>
              </View>
            ))
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function createStyles(c: AppColors) {
  return {
    container: { flex: 1, backgroundColor: c.background },
    center: { alignItems: 'center' as const, justifyContent: 'center' as const, padding: 40 },
    hint: { fontSize: 13, color: c.textSecondary, marginBottom: 16, lineHeight: 18 },
    empty: { marginTop: 12, color: c.textMuted },
    card: {
      backgroundColor: c.surface,
      borderRadius: 12,
      padding: 14,
      marginBottom: 12,
    },
    name: { fontSize: 16, fontWeight: '700' as const, color: c.text },
    meta: { fontSize: 12, color: c.textMuted, marginTop: 4 },
    coords: { fontSize: 13, color: c.textSecondary, marginTop: 6, fontFamily: 'monospace' as const },
    mapBtn: {
      marginTop: 12,
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      gap: 6,
      backgroundColor: c.primary,
      paddingVertical: 10,
      borderRadius: 10,
    },
    mapBtnText: { color: c.onPrimary, fontWeight: '600' as const },
  };
}
