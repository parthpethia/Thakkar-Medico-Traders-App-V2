import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  RefreshControl,
  Alert,
  Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../../src/services/supabase';
import { useAppTheme } from '../../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../../src/theme/useThemedStyles';
import type { AppColors } from '../../../src/theme/colors';

type Retailer = {
  id: string;
  name: string;
  phone: string;
  email: string;
  business_name: string;
  approved: boolean;
  credit_limit: number;
  credit_used: number;
  loyalty_points: number;
};

export default function RetailersList() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const router = useRouter();
  const [retailers, setRetailers] = useState<Retailer[]>([]);
  const [filtered, setFiltered] = useState<Retailer[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const fetchRetailers = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, name, phone, email, business_name, approved, credit_limit, credit_used, loyalty_points')
        .eq('role', 'retailer')
        .order('name', { ascending: true });

      if (error) throw error;
      const rows = (data || []) as Retailer[];
      setRetailers(rows);
      setFiltered(rows);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to fetch retailers');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRetailers();
  }, []);

  useEffect(() => {
    if (!search.trim()) {
      setFiltered(retailers);
      return;
    }
    const q = search.toLowerCase();
    setFiltered(
      retailers.filter(
        (r) =>
          (r.name || '').toLowerCase().includes(q) ||
          (r.phone || '').includes(q) ||
          (r.business_name || '').toLowerCase().includes(q),
      ),
    );
  }, [search, retailers]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchRetailers();
    setRefreshing(false);
  }, [fetchRetailers]);

  const toggleApproval = async (retailer: Retailer) => {
    const newApproved = !retailer.approved;
    const label = newApproved ? 'Approve' : 'Suspend';

    Alert.alert(label, `${label} ${retailer.name || retailer.phone}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: label,
        onPress: async () => {
          setTogglingId(retailer.id);
          const { error } = await supabase
            .from('profiles')
            .update({ approved: newApproved })
            .eq('id', retailer.id);

          setTogglingId(null);

          if (error) {
            Alert.alert('Error', error.message);
            return;
          }

          setRetailers((prev) =>
            prev.map((r) => (r.id === retailer.id ? { ...r, approved: newApproved } : r)),
          );
        },
      },
    ]);
  };

  const creditPercent = (r: Retailer) =>
    r.credit_limit > 0 ? Math.min((r.credit_used / r.credit_limit) * 100, 100) : 0;

  const renderItem = ({ item }: { item: Retailer }) => {
    const pct = creditPercent(item);
    const barColor = pct > 80 ? colors.error : pct > 60 ? colors.warning : colors.primary;

    return (
      <TouchableOpacity
        style={styles.card}
        activeOpacity={0.7}
        onPress={() => router.push(`/admin/retailers/${item.id}`)}
      >
        <View style={styles.cardHeader}>
          <View style={{ flex: 1 }}>
            <Text style={styles.retailerName}>{item.name || item.business_name || 'Unnamed'}</Text>
            <Text style={styles.retailerPhone}>{item.phone || item.email || '—'}</Text>
          </View>

          <View style={styles.cardRight}>
            <View
              style={[
                styles.approvedBadge,
                { backgroundColor: item.approved ? colors.successMuted : colors.warningBg },
              ]}
            >
              <Text
                style={{
                  color: item.approved ? colors.success : colors.warning,
                  fontSize: 11,
                  fontWeight: '600',
                }}
              >
                {item.approved ? 'Approved' : 'Pending'}
              </Text>
            </View>

            {togglingId === item.id ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Switch
                value={item.approved}
                onValueChange={() => toggleApproval(item)}
                trackColor={{ false: colors.switchTrackOff, true: colors.switchTrackOn }}
                thumbColor={item.approved ? colors.switchThumbOn : colors.switchThumbOff}
              />
            )}
          </View>
        </View>

        {item.credit_limit > 0 && (
          <View style={styles.creditSection}>
            <Text style={styles.creditLabel}>
              Credit: ₹{item.credit_used.toFixed(0)} / ₹{item.credit_limit.toFixed(0)}
            </Text>
            <View style={styles.creditTrack}>
              <View
                style={[styles.creditFill, { width: `${pct}%` as any, backgroundColor: barColor }]}
              />
            </View>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <Stack.Screen options={{ title: 'Retailers' }} />

      <View style={styles.searchBar}>
        <Ionicons name="search" size={18} color={colors.textMuted} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search by name or phone..."
          placeholderTextColor={colors.textMuted}
          value={search}
          onChangeText={setSearch}
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => setSearch('')}>
            <Ionicons name="close-circle" size={18} color={colors.textMuted} />
          </TouchableOpacity>
        )}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
          ListEmptyComponent={
            <View style={styles.center}>
              <Ionicons name="people-outline" size={52} color={colors.textMuted} />
              <Text style={styles.emptyText}>No retailers found</Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

function createStyles(c: AppColors, _isDark: boolean) {
  return {
  container: { flex: 1, backgroundColor: c.background },
  center: { flex: 1, justifyContent: 'center' as const, alignItems: 'center' as const, marginTop: 60 },
  emptyText: { marginTop: 10, color: c.textMuted },

  searchBar: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    backgroundColor: c.surface,
    margin: 16,
    marginBottom: 0,
    borderRadius: 12,
    paddingHorizontal: 14,
    height: 48,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: c.text,
  },

  card: {
    backgroundColor: c.surface,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  cardHeader: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
  },
  cardRight: {
    alignItems: 'flex-end' as const,
    gap: 6,
  },
  retailerName: { fontSize: 15, fontWeight: '700' as const, color: c.text },
  retailerPhone: { fontSize: 13, color: c.textMuted, marginTop: 2 },

  approvedBadge: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 10,
  },

  creditSection: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: c.borderLight,
  },
  creditLabel: {
    fontSize: 12,
    color: c.textSecondary,
    marginBottom: 6,
  },
  creditTrack: {
    height: 5,
    backgroundColor: c.border,
    borderRadius: 3,
    overflow: 'hidden' as const,
  },
  creditFill: {
    height: '100%' as const,
    borderRadius: 3,
  },

  };
}

