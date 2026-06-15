import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
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
    const barColor = pct > 80 ? '#EF5350' : pct > 60 ? '#FFA726' : '#4C51C9';

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
                { backgroundColor: item.approved ? '#E8F5E9' : '#FFF3E0' },
              ]}
            >
              <Text
                style={{
                  color: item.approved ? '#43A047' : '#FFA726',
                  fontSize: 11,
                  fontWeight: '600',
                }}
              >
                {item.approved ? 'Approved' : 'Pending'}
              </Text>
            </View>

            {togglingId === item.id ? (
              <ActivityIndicator size="small" color="#4C51C9" />
            ) : (
              <Switch
                value={item.approved}
                onValueChange={() => toggleApproval(item)}
                trackColor={{ false: '#ddd', true: '#A5D6A7' }}
                thumbColor={item.approved ? '#43A047' : '#ccc'}
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
    <SafeAreaView style={styles.container}>
      <Stack.Screen options={{ title: 'Retailers' }} />

      <View style={styles.searchBar}>
        <Ionicons name="search" size={18} color="#999" />
        <TextInput
          style={styles.searchInput}
          placeholder="Search by name or phone..."
          placeholderTextColor="#999"
          value={search}
          onChangeText={setSearch}
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => setSearch('')}>
            <Ionicons name="close-circle" size={18} color="#999" />
          </TouchableOpacity>
        )}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#4C51C9" />
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          ListEmptyComponent={
            <View style={styles.center}>
              <Ionicons name="people-outline" size={52} color="#ccc" />
              <Text style={styles.emptyText}>No retailers found</Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', marginTop: 60 },
  emptyText: { marginTop: 10, color: '#888' },

  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
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
    color: '#333',
  },

  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardRight: {
    alignItems: 'flex-end',
    gap: 6,
  },
  retailerName: { fontSize: 15, fontWeight: '700', color: '#333' },
  retailerPhone: { fontSize: 13, color: '#888', marginTop: 2 },

  approvedBadge: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 10,
  },

  creditSection: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
  },
  creditLabel: {
    fontSize: 12,
    color: '#666',
    marginBottom: 6,
  },
  creditTrack: {
    height: 5,
    backgroundColor: '#E8E8E8',
    borderRadius: 3,
    overflow: 'hidden',
  },
  creditFill: {
    height: '100%',
    borderRadius: 3,
  },
});
