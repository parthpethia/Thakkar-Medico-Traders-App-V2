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

import { useAuthStore } from '../../src/store/authStore';
import { supabase } from '../../src/services/supabase';

/* ================= TYPES ================= */

type DashboardStats = {
  todayOrders: number;
  todayRevenue: number;
  pendingOrders: number;
  totalUsers: number;
  pendingUsers: number;
  totalProducts: number;
};

/* ================= SCREEN ================= */

export default function AdminIndex() {
  const router = useRouter();
  const { user, logout } = useAuthStore();

  const [stats, setStats] = useState<DashboardStats>({
    todayOrders: 0,
    todayRevenue: 0,
    pendingOrders: 0,
    totalUsers: 0,
    pendingUsers: 0,
    totalProducts: 0,
  });

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  /* ================= ADMIN GUARD ================= */

  useEffect(() => {
    if (!user) return;

    if (user.role !== 'admin') {
      router.replace('/');
    }
  }, [user]);

  /* ================= FETCH DASHBOARD ================= */

  const fetchDashboard = async () => {
    try {
      setLoading(true);

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const [
        todayOrdersRes,
        todayRevenueRes,
        pendingOrdersRes,
        totalUsersRes,
        pendingUsersRes,
        productsRes,
      ] = await Promise.all([
        supabase
          .from('orders')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', today.toISOString())
          .neq('status', 'cancelled'),

        supabase
          .from('orders')
          .select('grand_total')
          .gte('created_at', today.toISOString())
          .neq('status', 'cancelled'),

        supabase
          .from('orders')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pending'),

        supabase
          .from('profiles')
          .select('id', { count: 'exact', head: true }),

        supabase
          .from('profiles')
          .select('id', { count: 'exact', head: true })
          .eq('approved', false),

        supabase
          .from('products')
          .select('id', { count: 'exact', head: true }),
      ]);

      const todayRevenue =
        todayRevenueRes.data?.reduce(
          (sum, o) => sum + (o.grand_total || 0),
          0
        ) || 0;

      setStats({
        todayOrders: todayOrdersRes.count || 0,
        todayRevenue,
        pendingOrders: pendingOrdersRes.count || 0,
        totalUsers: totalUsersRes.count || 0,
        pendingUsers: pendingUsersRes.count || 0,
        totalProducts: productsRes.count || 0,
      });
    } catch (err) {
      console.error('Admin dashboard error:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDashboard();
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchDashboard();
    setRefreshing(false);
  }, []);

  /* ================= LOGOUT ================= */

  const handleLogout = async () => {
    await logout();
    router.replace('/(auth)/login');
  };

  /* ================= LOADING ================= */

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loading}>
          <ActivityIndicator size="large" color="#4C51C9" />
        </View>
      </SafeAreaView>
    );
  }

  /* ================= UI ================= */

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      >
        {/* Header */}
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Admin Dashboard</Text>
            <Text style={styles.subtitle}>{user?.name}</Text>
          </View>

          <TouchableOpacity onPress={handleLogout}>
            <Ionicons name="log-out-outline" size={24} color="#e53935" />
          </TouchableOpacity>
        </View>

        {/* TODAY STATS */}
        <View style={styles.statsGrid}>
          <StatCard
            icon="cart"
            label="Today's Orders"
            value={stats.todayOrders}
            color="#4C51C9"
          />
          <StatCard
            icon="cash"
            label="Today's Sales"
            value={`₹${stats.todayRevenue.toFixed(0)}`}
            color="#43A047"
          />
          <StatCard
            icon="time"
            label="Pending Orders"
            value={stats.pendingOrders}
            color="#FFA726"
          />
          <StatCard
            icon="cube"
            label="Products"
            value={stats.totalProducts}
            color="#8E24AA"
          />
        </View>

        {/* USER STATS */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Users</Text>
          <View style={styles.userRow}>
            <UserStat label="Total Users" value={stats.totalUsers} />
            <UserStat
              label="Pending Verification"
              value={stats.pendingUsers}
            />
          </View>
        </View>

        {/* ACTIONS */}
        <View style={styles.section}>
          <AdminAction
            icon="people"
            title="Manage Users"
            subtitle="Approve & manage retailers"
            onPress={() => router.push('/admin/users')}
          />
          <AdminAction
            icon="cube"
            title="Manage Products"
            subtitle="Add & edit products"
            onPress={() => router.push('/admin/products')}
          />
          <AdminAction
            icon="receipt"
            title="Manage Orders"
            subtitle="Process customer orders"
            onPress={() => router.push('/admin/orders')}
          />
          <AdminAction
            icon="settings"
            title="Settings"
            subtitle="App & business configuration"
            onPress={() => router.push('/admin/settings')}
          />
          <AdminAction
            icon="storefront"
            title="Go to Store"
            subtitle="Back to the storefront"
            onPress={() => {
              import('../(tabs)/_layout').then((module) => {
                module.setAdminBrowsingStore(true);
                router.replace('/(tabs)');
              });
            }}
          />
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

/* ================= COMPONENTS ================= */

function StatCard({ icon, label, value, color }: any) {
  return (
    <View style={styles.statCard}>
      <Ionicons name={icon} size={28} color={color} />
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function UserStat({ label, value }: any) {
  return (
    <View style={styles.userStat}>
      <Text style={styles.userValue}>{value}</Text>
      <Text style={styles.userLabel}>{label}</Text>
    </View>
  );
}

function AdminAction({ icon, title, subtitle, onPress }: any) {
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

/* ================= STYLES ================= */

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },

  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  header: {
    padding: 20,
    backgroundColor: '#fff',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },

  title: { fontSize: 22, fontWeight: '700', color: '#333' },
  subtitle: { fontSize: 14, color: '#666', marginTop: 2 },

  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    padding: 12,
    gap: 12,
  },

  statCard: {
    width: '47%',
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 20,
    alignItems: 'center',
  },

  statValue: {
    fontSize: 22,
    fontWeight: '700',
    marginTop: 8,
    color: '#333',
  },

  statLabel: {
    fontSize: 12,
    color: '#666',
    marginTop: 4,
    textAlign: 'center',
  },

  section: { padding: 16 },

  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#333',
    marginBottom: 12,
  },

  userRow: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderRadius: 12,
  },

  userStat: {
    flex: 1,
    padding: 16,
    alignItems: 'center',
  },

  userValue: {
    fontSize: 20,
    fontWeight: '700',
    color: '#333',
  },

  userLabel: {
    fontSize: 12,
    color: '#666',
    marginTop: 4,
    textAlign: 'center',
  },

  actionCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },

  actionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
  },

  actionSubtitle: {
    fontSize: 13,
    color: '#888',
    marginTop: 2,
  },
});
