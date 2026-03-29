import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../src/services/supabase';
import { useAuthStore } from '../../src/store/authStore';

type DeliveryStats = {
  todaysCreated: number;
  todaysToDeliver: number;
  todaysDelivered: number;
};

export default function DeliveryDashboard() {
  const router = useRouter();
  const { user, logout } = useAuthStore();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [stats, setStats] = useState<DeliveryStats>({
    todaysCreated: 0,
    todaysToDeliver: 0,
    todaysDelivered: 0,
  });

  const getTodayRange = () => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);

    const end = new Date();
    end.setHours(23, 59, 59, 999);

    return { start: start.toISOString(), end: end.toISOString() };
  };

  const fetchStats = async () => {
    try {
      setLoading(true);
      const { start, end } = getTodayRange();

      const [createdRes, toDeliverRes, deliveredRes] = await Promise.all([
        supabase
          .from('orders')
          .select('id', { head: true, count: 'exact' })
          .gte('created_at', start)
          .lte('created_at', end),

        supabase
          .from('orders')
          .select('id', { head: true, count: 'exact' })
          .gte('created_at', start)
          .lte('created_at', end)
          .not('status', 'in', '(delivered,cancelled)'),

        supabase
          .from('orders')
          .select('id', { head: true, count: 'exact' })
          .gte('created_at', start)
          .lte('created_at', end)
          .eq('status', 'delivered'),
      ]);

      setStats({
        todaysCreated: createdRes.count || 0,
        todaysToDeliver: toDeliverRes.count || 0,
        todaysDelivered: deliveredRes.count || 0,
      });
    } catch (error) {
      console.error('Delivery stats fetch error:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchStats();
    setRefreshing(false);
  }, []);

  const handleLogout = async () => {
    await logout();
    router.replace('/(auth)/login');
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#4C51C9" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      >
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Delivery Portal</Text>
            <Text style={styles.subtitle}>{user?.name || 'Delivery Partner'}</Text>
          </View>
          <TouchableOpacity onPress={handleLogout}>
            <Ionicons name="log-out-outline" size={24} color="#e53935" />
          </TouchableOpacity>
        </View>

        <View style={styles.statsGrid}>
          <StatCard icon="add-circle" label="Created Today" value={stats.todaysCreated} color="#4C51C9" />
          <StatCard icon="bicycle" label="To Deliver Today" value={stats.todaysToDeliver} color="#FB8C00" />
          <StatCard icon="checkmark-done-circle" label="Delivered Today" value={stats.todaysDelivered} color="#43A047" />
        </View>

        <View style={styles.actionsWrap}>
          <ActionCard
            icon="map-outline"
            title="Today's Path"
            subtitle="Optimized route for all deliveries"
            onPress={() => router.push('/delivery/todays-path')}
          />
          <ActionCard
            icon="person-add-outline"
            title="Create Retailer"
            subtitle="Add a new retailer account"
            onPress={() => router.push('/delivery/create-retailer')}
          />
          <ActionCard
            icon="receipt-outline"
            title="Today's Orders"
            subtitle="View and update delivery status"
            onPress={() => router.push('/delivery/orders')}
          />
          <ActionCard
            icon="add-circle-outline"
            title="Create Order"
            subtitle="Create a new order for retailer"
            onPress={() => router.push('/delivery/create-order')}
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function StatCard({ icon, label, value, color }: any) {
  return (
    <View style={styles.statCard}>
      <Ionicons name={icon} size={26} color={color} />
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function ActionCard({ icon, title, subtitle, onPress }: any) {
  return (
    <TouchableOpacity style={styles.actionCard} onPress={onPress}>
      <Ionicons name={icon} size={22} color="#4C51C9" />
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text style={styles.actionTitle}>{title}</Text>
        <Text style={styles.actionSubtitle}>{subtitle}</Text>
      </View>
      <Ionicons name="chevron-forward" size={20} color="#999" />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: {
    padding: 20,
    backgroundColor: '#fff',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: { fontSize: 24, fontWeight: '700', color: '#333' },
  subtitle: { fontSize: 14, color: '#777', marginTop: 4 },
  statsGrid: {
    padding: 16,
    flexDirection: 'row',
    gap: 10,
  },
  statCard: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  statValue: { fontSize: 22, fontWeight: '700', color: '#333', marginTop: 8 },
  statLabel: { fontSize: 12, color: '#666', marginTop: 4, textAlign: 'center' },
  actionsWrap: { paddingHorizontal: 16, paddingBottom: 20, gap: 10 },
  actionCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
  },
  actionTitle: { fontSize: 15, fontWeight: '700', color: '#333' },
  actionSubtitle: { fontSize: 12, color: '#777', marginTop: 2 },
});
