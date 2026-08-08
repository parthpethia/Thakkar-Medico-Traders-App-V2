import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
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
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import { stackScreenBase } from '../../src/theme/stackScreenStyles';
import type { AppColors } from '../../src/theme/colors';

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
  const styles = useThemedStyles(createAdminIndexStyles);
  const { colors } = useAppTheme();
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

      const { data, error } = await supabase.rpc('get_admin_dashboard_stats', {
        p_today: today.toISOString(),
      });

      if (error) throw error;

      if (data) {
        const statsData = data as {
          todayOrders: number;
          todayRevenue: number;
          pendingOrders: number;
          totalUsers: number;
          pendingUsers: number;
          totalProducts: number;
        };

        setStats({
          todayOrders: statsData.todayOrders || 0,
          todayRevenue: statsData.todayRevenue || 0,
          pendingOrders: statsData.pendingOrders || 0,
          totalUsers: statsData.totalUsers || 0,
          pendingUsers: statsData.pendingUsers || 0,
          totalProducts: statsData.totalProducts || 0,
        });
      }
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
      <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
        <View style={styles.loading}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  /* ================= UI ================= */

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
          />
        }
      >
        {/* Header */}
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Admin Dashboard</Text>
            <Text style={styles.subtitle}>{user?.name}</Text>
          </View>

          <TouchableOpacity onPress={handleLogout}>
            <Ionicons name="log-out-outline" size={24} color={colors.error} />
          </TouchableOpacity>
        </View>

        {/* TODAY STATS */}
        <View style={styles.statsGrid}>
          <StatCard
            icon="cart"
            label="Today's Orders"
            value={stats.todayOrders}
            color={colors.primary}
            cardStyles={styles}
          />
          <StatCard
            icon="cash"
            label="Today's Sales"
            value={`₹${stats.todayRevenue.toFixed(0)}`}
            color={colors.success}
            cardStyles={styles}
          />
          <StatCard
            icon="time"
            label="Pending Orders"
            value={stats.pendingOrders}
            color={colors.warning}
            cardStyles={styles}
          />
          <StatCard
            icon="cube"
            label="Products"
            value={stats.totalProducts}
            color="#8E24AA"
            cardStyles={styles}
          />
        </View>

        {/* USER STATS */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Users</Text>
          <View style={styles.userRow}>
            <UserStat label="Total Users" value={stats.totalUsers} cardStyles={styles} />
            <UserStat label="Pending Verification" value={stats.pendingUsers} cardStyles={styles} />
          </View>
        </View>

        {/* ACTIONS */}
        <View style={styles.section}>
          <AdminAction
            icon="analytics"
            title="Analytics"
            subtitle="Sales, revenue & performance insights"
            onPress={() => router.push('/admin/analytics')}
            cardStyles={styles}
            colors={colors}
          />
          <AdminAction
            icon="cube"
            title="Stock Management"
            subtitle="Low stock alerts & adjustments"
            onPress={() => router.push('/admin/stock')}
            cardStyles={styles}
            colors={colors}
          />
          <AdminAction
            icon="people"
            title="Manage Users"
            subtitle="Approve & manage retailers"
            onPress={() => router.push('/admin/users')}
            cardStyles={styles}
            colors={colors}
          />
          <AdminAction
            icon="briefcase"
            title="Manage Retailers"
            subtitle="Credit limits, payments & details"
            onPress={() => router.push('/admin/retailers')}
            cardStyles={styles}
            colors={colors}
          />
          <AdminAction
            icon="cube"
            title="Manage Products"
            subtitle="Add & edit products"
            onPress={() => router.push('/admin/products')}
            cardStyles={styles}
            colors={colors}
          />
          <AdminAction
            icon="receipt"
            title="Manage Orders"
            subtitle="Process customer orders"
            onPress={() => router.push('/admin/orders')}
            cardStyles={styles}
            colors={colors}
          />
          <AdminAction
            icon="calculator"
            title="POS Counter Billing"
            subtitle="Direct counter sales & billing billing"
            onPress={() => router.push('/admin/orders/pos')}
            cardStyles={styles}
            colors={colors}
          />
          <AdminAction
            icon="sparkles"
            title="Scan Bill (Photo-to-Order)"
            subtitle="AI OCR extraction of bill photos into orders"
            onPress={() => router.push('/orders/scan-bill')}
            cardStyles={styles}
            colors={colors}
          />
          <AdminAction
            icon="document-attach"
            title="Invoice to Order"
            subtitle="Import orders directly from invoice documents"
            onPress={() => router.push('/admin/invoice-import')}
            cardStyles={styles}
            colors={colors}
          />
          <AdminAction
            icon="navigate"
            title="Live drivers"
            subtitle="Track delivery partners on the road"
            onPress={() => router.push('/admin/delivery-tracking')}
            cardStyles={styles}
            colors={colors}
          />
          <AdminAction
            icon="settings"
            title="Settings"
            subtitle="App & business configuration"
            onPress={() => router.push('/admin/settings')}
            cardStyles={styles}
            colors={colors}
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
            cardStyles={styles}
            colors={colors}
          />
        </View>

        <View style={styles.bottomSpacer} />
      </ScrollView>
    </SafeAreaView>
  );
}

/* ================= COMPONENTS ================= */

function StatCard({
  icon,
  label,
  value,
  color,
  cardStyles,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string | number;
  color: string;
  cardStyles: ReturnType<typeof createAdminIndexStyles>;
}) {
  return (
    <View style={cardStyles.statCard}>
      <Ionicons name={icon} size={28} color={color} />
      <Text style={cardStyles.statValue}>{value}</Text>
      <Text style={cardStyles.statLabel}>{label}</Text>
    </View>
  );
}

function UserStat({
  label,
  value,
  cardStyles,
}: {
  label: string;
  value: number;
  cardStyles: ReturnType<typeof createAdminIndexStyles>;
}) {
  return (
    <View style={cardStyles.userStat}>
      <Text style={cardStyles.userValue}>{value}</Text>
      <Text style={cardStyles.userLabel}>{label}</Text>
    </View>
  );
}

function AdminAction({
  icon,
  title,
  subtitle,
  onPress,
  cardStyles,
  colors,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle: string;
  onPress: () => void;
  cardStyles: ReturnType<typeof createAdminIndexStyles>;
  colors: AppColors;
}) {
  return (
    <TouchableOpacity style={cardStyles.actionCard} onPress={onPress}>
      <Ionicons name={icon} size={22} color={colors.primary} />
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text style={cardStyles.actionTitle}>{title}</Text>
        <Text style={cardStyles.actionSubtitle}>{subtitle}</Text>
      </View>
      <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
    </TouchableOpacity>
  );
}

function createAdminIndexStyles(c: AppColors, isDark: boolean) {
  const base = stackScreenBase(c, isDark);
  return {
    container: base.container,
    scrollContent: { paddingBottom: 24 },
    loading: { flex: 1, justifyContent: 'center' as const, alignItems: 'center' as const },
    header: {
      padding: 20,
      backgroundColor: c.surface,
      flexDirection: 'row' as const,
      justifyContent: 'space-between' as const,
      alignItems: 'center' as const,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    title: { fontSize: 22, fontWeight: '700' as const, color: c.text },
    subtitle: { fontSize: 14, color: c.textSecondary, marginTop: 2 },
    statsGrid: {
      flexDirection: 'row' as const,
      flexWrap: 'wrap' as const,
      padding: 12,
      gap: 12,
    },
    statCard: {
      width: '47%' as const,
      ...base.statCard,
    },
    statValue: {
      fontSize: 22,
      fontWeight: '700' as const,
      marginTop: 8,
      color: c.text,
    },
    statLabel: {
      fontSize: 12,
      color: c.textSecondary,
      marginTop: 4,
      textAlign: 'center' as const,
    },
    section: { padding: 16 },
    sectionTitle: base.sectionTitle,
    userRow: {
      flexDirection: 'row' as const,
      backgroundColor: c.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.border,
    },
    userStat: {
      flex: 1,
      padding: 16,
      alignItems: 'center' as const,
    },
    userValue: {
      fontSize: 20,
      fontWeight: '700' as const,
      color: c.text,
    },
    userLabel: {
      fontSize: 12,
      color: c.textSecondary,
      marginTop: 4,
      textAlign: 'center' as const,
    },
    actionCard: base.actionCard,
    actionTitle: {
      fontSize: 16,
      fontWeight: '600' as const,
      color: c.text,
    },
    actionSubtitle: {
      fontSize: 13,
      color: c.textMuted,
      marginTop: 2,
    },
    bottomSpacer: { height: 40 },
  };
}
