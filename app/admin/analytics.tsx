// P6: i18n applied — all strings use t() from src/i18n
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Dimensions,
  Alert,
  Share,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { format, startOfDay, endOfDay, startOfWeek, endOfWeek, startOfMonth, endOfMonth, subDays } from 'date-fns';
import { useTranslation } from 'react-i18next';

import { supabase } from '../../src/services/supabase';
import { trackRpc } from '../../src/utils/performanceMonitor';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import type { AppColors } from '../../src/theme/colors';

const screenWidth = Dimensions.get('window').width;

type DateRange = 'today' | 'week' | 'month' | 'custom';

type SalesSummary = {
  total_orders: number;
  delivered_orders: number;
  cancelled_orders: number;
  gross_revenue: number;
  discount_given: number;
  net_revenue: number;
  avg_order_value: number;
  total_credit_outstanding: number;
};

type TopProduct = {
  product_id: string;
  product_name: string;
  total_qty_sold: number;
  total_revenue: number;
};

type TopRetailer = {
  retailer_id: string;
  retailer_name: string;
  order_count: number;
  total_value: number;
  credit_used: number;
};

type DailyRevenue = {
  day: string;
  orders: number;
  revenue: number;
};

type StatusBreakdown = {
  status: string;
  count: number;
  percent: number;
};

const STATUS_COLORS: Record<string, string> = {
  pending: '#FFA726',
  approved: '#42A5F5',
  packed: '#7E57C2',
  dispatched: '#26A69A',
  delivered: '#66BB6A',
  cancelled: '#EF5350',
  pending_payment: '#FF7043',
};

export default function Analytics() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const [range, setRange] = useState<DateRange>('week');
  const [summary, setSummary] = useState<SalesSummary | null>(null);
  const [topProducts, setTopProducts] = useState<TopProduct[]>([]);
  const [topRetailers, setTopRetailers] = useState<TopRetailer[]>([]);
  const [dailyRevenue, setDailyRevenue] = useState<DailyRevenue[]>([]);
  const [statusBreakdown, setStatusBreakdown] = useState<StatusBreakdown[]>([]);

  const [loadingSummary, setLoadingSummary] = useState(true);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [loadingRetailers, setLoadingRetailers] = useState(true);
  const [loadingDaily, setLoadingDaily] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const { fromDate, toDate } = useMemo(() => {
    const now = new Date();
    switch (range) {
      case 'today':
        return { fromDate: startOfDay(now), toDate: endOfDay(now) };
      case 'week':
        return { fromDate: startOfWeek(now, { weekStartsOn: 1 }), toDate: endOfWeek(now, { weekStartsOn: 1 }) };
      case 'month':
        return { fromDate: startOfMonth(now), toDate: endOfMonth(now) };
      default:
        return { fromDate: subDays(now, 30), toDate: now };
    }
  }, [range]);

  const rangeLabelMap: Record<string, string> = {
    today: t('admin.analyticsScreen.today'),
    week: t('admin.analyticsScreen.thisWeek'),
    month: t('admin.analyticsScreen.thisMonth'),
  };

  const fetchSummary = useCallback(async () => {
    setLoadingSummary(true);
    try {
      const { data, error } = await trackRpc('get_sales_summary', () =>
        supabase.rpc('get_sales_summary', {
          p_from_date: fromDate.toISOString(),
          p_to_date: toDate.toISOString(),
        })
      );
      if (error) throw error;
      if (data && Array.isArray(data) && data.length > 0) {
        setSummary(data[0] as SalesSummary);
      } else if (data && !Array.isArray(data)) {
        setSummary(data as SalesSummary);
      }
    } catch (err: any) {
      console.error('Sales summary error:', err.message);
    } finally {
      setLoadingSummary(false);
    }
  }, [fromDate, toDate]);

  const fetchTopProducts = useCallback(async () => {
    setLoadingProducts(true);
    try {
      const { data, error } = await trackRpc('get_top_products', () =>
        supabase.rpc('get_top_products', {
          p_from_date: fromDate.toISOString(),
          p_to_date: toDate.toISOString(),
          p_limit: 10,
        })
      );
      if (error) throw error;
      setTopProducts((data || []) as TopProduct[]);
    } catch (err: any) {
      console.error('Top products error:', err.message);
    } finally {
      setLoadingProducts(false);
    }
  }, [fromDate, toDate]);

  const fetchTopRetailers = useCallback(async () => {
    setLoadingRetailers(true);
    try {
      const { data, error } = await supabase.rpc('get_top_retailers', {
        p_from_date: fromDate.toISOString(),
        p_to_date: toDate.toISOString(),
        p_limit: 10,
      });
      if (error) throw error;
      setTopRetailers((data || []) as TopRetailer[]);
    } catch (err: any) {
      console.error('Top retailers error:', err.message);
    } finally {
      setLoadingRetailers(false);
    }
  }, [fromDate, toDate]);

  const fetchDailyRevenue = useCallback(async () => {
    setLoadingDaily(true);
    try {
      const { data, error } = await trackRpc('get_daily_revenue', () =>
        supabase.rpc('get_daily_revenue', {
          p_from_date: fromDate.toISOString(),
          p_to_date: toDate.toISOString(),
        })
      );
      if (error) throw error;
      setDailyRevenue((data || []) as DailyRevenue[]);
    } catch (err: any) {
      console.error('Daily revenue error:', err.message);
    } finally {
      setLoadingDaily(false);
    }
  }, [fromDate, toDate]);

  const fetchStatusBreakdown = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const { data, error } = await supabase.rpc('get_status_breakdown', {
        p_from_date: fromDate.toISOString(),
        p_to_date: toDate.toISOString(),
      });
      if (error) throw error;
      setStatusBreakdown((data || []) as StatusBreakdown[]);
    } catch (err: any) {
      console.error('Status breakdown error:', err.message);
    } finally {
      setLoadingStatus(false);
    }
  }, [fromDate, toDate]);

  const fetchAll = useCallback(async () => {
    await Promise.all([
      fetchSummary(),
      fetchTopProducts(),
      fetchTopRetailers(),
      fetchDailyRevenue(),
      fetchStatusBreakdown(),
    ]);
  }, [fetchSummary, fetchTopProducts, fetchTopRetailers, fetchDailyRevenue, fetchStatusBreakdown]);

  useEffect(() => {
    fetchAll();
  }, [range]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchAll();
    setRefreshing(false);
  }, [fetchAll]);

  const exportCsv = async () => {
    try {
      const escapeCsv = (val: string | number) => {
        const str = String(val);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };

      let csv = 'Section,Metric,Value\n';

      if (summary) {
        csv += `Summary,Total Orders,${summary.total_orders}\n`;
        csv += `Summary,Delivered,${summary.delivered_orders}\n`;
        csv += `Summary,Cancelled,${summary.cancelled_orders}\n`;
        csv += `Summary,Gross Revenue,${summary.gross_revenue}\n`;
        csv += `Summary,Discount Given,${summary.discount_given}\n`;
        csv += `Summary,Net Revenue,${summary.net_revenue}\n`;
        csv += `Summary,Avg Order Value,${summary.avg_order_value}\n`;
        csv += `Summary,Credit Outstanding,${summary.total_credit_outstanding}\n`;
      }

      csv += '\nTop Products\nRank,Product Name,Qty Sold,Revenue\n';
      topProducts.forEach((p, i) => {
        csv += `${i + 1},${escapeCsv(p.product_name)},${p.total_qty_sold},${p.total_revenue}\n`;
      });

      csv += '\nTop Retailers\nRank,Retailer Name,Orders,Total Value,Credit Used\n';
      topRetailers.forEach((r, i) => {
        csv += `${i + 1},${escapeCsv(r.retailer_name)},${r.order_count},${r.total_value},${r.credit_used}\n`;
      });

      csv += '\nDaily Revenue\nDate,Orders,Revenue\n';
      dailyRevenue.forEach((d) => {
        csv += `${d.day},${d.orders},${d.revenue}\n`;
      });

      csv += '\nStatus Breakdown\nStatus,Count,Percent\n';
      statusBreakdown.forEach((s) => {
        csv += `${s.status},${s.count},${s.percent}%\n`;
      });

      await Share.share({
        message: csv,
        title: `Analytics_${format(fromDate, 'yyyyMMdd')}_${format(toDate, 'yyyyMMdd')}.csv`,
      });
    } catch (err: any) {
      Alert.alert(t('admin.analyticsScreen.exportError'), err.message || t('common.error'));
    }
  };

  const maxDailyRevenue = useMemo(
    () => Math.max(...dailyRevenue.map((d) => d.revenue), 1),
    [dailyRevenue],
  );

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <Stack.Screen
        options={{
          title: t('admin.analyticsScreen.title'),
          headerRight: () => (
            <TouchableOpacity onPress={exportCsv} style={{ paddingHorizontal: 12 }}>
              <Ionicons name="download-outline" size={22} color={colors.primary} />
            </TouchableOpacity>
          ),
        }}
      />

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {/* Date Range Selector */}
        <View style={styles.rangeRow}>
          {(['today', 'week', 'month'] as DateRange[]).map((r) => (
            <TouchableOpacity
              key={r}
              style={[styles.rangePill, range === r && styles.rangePillActive]}
              onPress={() => setRange(r)}
            >
              <Text style={[styles.rangePillText, range === r && styles.rangePillTextActive]}>
                {rangeLabelMap[r] || r}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={styles.dateRangeLabel}>
          {format(fromDate, 'dd MMM yyyy')} — {format(toDate, 'dd MMM yyyy')}
        </Text>

        {/* Summary Cards */}
        {loadingSummary ? (
          <SkeletonSection styles={styles} colors={colors} />
        ) : summary ? (
          <View style={styles.summaryGrid}>
            <SummaryCard styles={styles} label={t('admin.analyticsScreen.totalOrders')} value={summary.total_orders} color={colors.primary} />
            <SummaryCard styles={styles} label={t('admin.analyticsScreen.delivered')} value={summary.delivered_orders} color="#66BB6A" />
            <SummaryCard styles={styles} label={t('admin.analyticsScreen.cancelled')} value={summary.cancelled_orders} color="#EF5350" />
            <SummaryCard styles={styles} label={t('admin.analyticsScreen.netRevenue')} value={`₹${Number(summary.net_revenue).toFixed(0)}`} color={colors.success} />
            <SummaryCard styles={styles} label={t('admin.analyticsScreen.avgOrderValue')} value={`₹${Number(summary.avg_order_value).toFixed(0)}`} color="#7E57C2" />
            <SummaryCard styles={styles} label={t('admin.analyticsScreen.creditOutstanding')} value={`₹${Number(summary.total_credit_outstanding).toFixed(0)}`} color="#FF7043" />
          </View>
        ) : null}

        {/* Revenue Chart (Simple Bar) */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('admin.analyticsScreen.dailyRevenue')}</Text>
          {loadingDaily ? (
            <ActivityIndicator size="small" color={colors.primary} style={{ marginVertical: 20 }} />
          ) : dailyRevenue.length === 0 ? (
            <Text style={styles.emptyText}>{t('admin.analyticsScreen.noRevenueData')}</Text>
          ) : (
            <View style={styles.chartContainer}>
              {dailyRevenue.slice(-14).map((d, i) => {
                const barHeight = Math.max((d.revenue / maxDailyRevenue) * 100, 4);
                return (
                  <View key={d.day} style={styles.barWrapper}>
                    <Text style={styles.barValue}>
                      {d.revenue >= 1000 ? `${(d.revenue / 1000).toFixed(0)}k` : d.revenue.toFixed(0)}
                    </Text>
                    <View style={[styles.bar, { height: barHeight }]} />
                    <Text style={styles.barLabel}>
                      {format(new Date(d.day), 'dd')}
                    </Text>
                  </View>
                );
              })}
            </View>
          )}
        </View>

        {/* Status Breakdown */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('admin.analyticsScreen.statusBreakdown')}</Text>
          {loadingStatus ? (
            <ActivityIndicator size="small" color={colors.primary} style={{ marginVertical: 20 }} />
          ) : statusBreakdown.length === 0 ? (
            <Text style={styles.emptyText}>{t('admin.analyticsScreen.noOrdersInPeriod')}</Text>
          ) : (
            statusBreakdown.map((s) => (
              <View key={s.status} style={styles.statusRow}>
                <View style={styles.statusLeft}>
                  <View style={[styles.statusDot, { backgroundColor: STATUS_COLORS[s.status] || '#888' }]} />
                  <Text style={styles.statusLabel}>{s.status}</Text>
                </View>
                <View style={styles.statusRight}>
                  <View style={styles.statusBarTrack}>
                    <View
                      style={[
                        styles.statusBarFill,
                        {
                          width: `${Math.min(s.percent, 100)}%`,
                          backgroundColor: STATUS_COLORS[s.status] || '#888',
                        },
                      ]}
                    />
                  </View>
                  <Text style={styles.statusCount}>{s.count} ({s.percent}%)</Text>
                </View>
              </View>
            ))
          )}
        </View>

        {/* Top Products */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('admin.analyticsScreen.topProducts')}</Text>
          {loadingProducts ? (
            <ActivityIndicator size="small" color={colors.primary} style={{ marginVertical: 20 }} />
          ) : topProducts.length === 0 ? (
            <Text style={styles.emptyText}>{t('admin.analyticsScreen.noProductData')}</Text>
          ) : (
            <View>
              <View style={styles.tableHeader}>
                <Text style={[styles.tableHeaderText, { flex: 0.5 }]}>#</Text>
                <Text style={[styles.tableHeaderText, { flex: 2.5 }]}>{t('admin.analyticsScreen.product')}</Text>
                <Text style={[styles.tableHeaderText, { flex: 1, textAlign: 'right' }]}>{t('admin.analyticsScreen.qty')}</Text>
                <Text style={[styles.tableHeaderText, { flex: 1.5, textAlign: 'right' }]}>{t('admin.analyticsScreen.revenue')}</Text>
              </View>
              {topProducts.map((p, i) => (
                <View key={p.product_id} style={styles.tableRow}>
                  <Text style={[styles.tableCell, { flex: 0.5 }]}>{i + 1}</Text>
                  <Text style={[styles.tableCell, { flex: 2.5 }]} numberOfLines={1}>{p.product_name}</Text>
                  <Text style={[styles.tableCell, { flex: 1, textAlign: 'right' }]}>{p.total_qty_sold}</Text>
                  <Text style={[styles.tableCell, { flex: 1.5, textAlign: 'right', fontWeight: '600' }]}>
                    ₹{Number(p.total_revenue).toFixed(0)}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </View>

        {/* Top Retailers */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('admin.analyticsScreen.topRetailers')}</Text>
          {loadingRetailers ? (
            <ActivityIndicator size="small" color={colors.primary} style={{ marginVertical: 20 }} />
          ) : topRetailers.length === 0 ? (
            <Text style={styles.emptyText}>{t('admin.analyticsScreen.noRetailerData')}</Text>
          ) : (
            <View>
              <View style={styles.tableHeader}>
                <Text style={[styles.tableHeaderText, { flex: 0.5 }]}>#</Text>
                <Text style={[styles.tableHeaderText, { flex: 2 }]}>{t('admin.analyticsScreen.retailer')}</Text>
                <Text style={[styles.tableHeaderText, { flex: 1, textAlign: 'right' }]}>{t('admin.analyticsScreen.totalOrders')}</Text>
                <Text style={[styles.tableHeaderText, { flex: 1.5, textAlign: 'right' }]}>{t('admin.analyticsScreen.value')}</Text>
                <Text style={[styles.tableHeaderText, { flex: 1.2, textAlign: 'right' }]}>{t('admin.analyticsScreen.credit')}</Text>
              </View>
              {topRetailers.map((r, i) => (
                <View key={r.retailer_id} style={styles.tableRow}>
                  <Text style={[styles.tableCell, { flex: 0.5 }]}>{i + 1}</Text>
                  <Text style={[styles.tableCell, { flex: 2 }]} numberOfLines={1}>{r.retailer_name}</Text>
                  <Text style={[styles.tableCell, { flex: 1, textAlign: 'right' }]}>{r.order_count}</Text>
                  <Text style={[styles.tableCell, { flex: 1.5, textAlign: 'right', fontWeight: '600' }]}>
                    ₹{Number(r.total_value).toFixed(0)}
                  </Text>
                  <Text style={[styles.tableCell, styles.creditCell, { flex: 1.2, textAlign: 'right' }]}>
                    ₹{Number(r.credit_used).toFixed(0)}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function SummaryCard({
  styles,
  label,
  value,
  color,
}: {
  styles: ReturnType<typeof createStyles>;
  label: string;
  value: string | number;
  color: string;
}) {
  return (
    <View style={styles.summaryCard}>
      <Text style={[styles.summaryValue, { color }]}>{value}</Text>
      <Text style={styles.summaryLabel}>{label}</Text>
    </View>
  );
}

function SkeletonSection({
  styles,
  colors,
}: {
  styles: ReturnType<typeof createStyles>;
  colors: AppColors;
}) {
  return (
    <View style={[styles.summaryGrid, { opacity: 0.4 }]}>
      {[...Array(6)].map((_, i) => (
        <View key={i} style={[styles.summaryCard, { backgroundColor: colors.skeleton }]}>
          <View style={{ width: 50, height: 22, backgroundColor: colors.border, borderRadius: 4, marginBottom: 6 }} />
          <View style={{ width: 70, height: 12, backgroundColor: colors.border, borderRadius: 4 }} />
        </View>
      ))}
    </View>
  );
}

function createStyles(c: AppColors, _isDark: boolean) {
  return {
  container: { flex: 1, backgroundColor: c.background },

  rangeRow: {
    flexDirection: 'row' as const,
    gap: 8,
    marginBottom: 8,
  },
  rangePill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
  },
  rangePillActive: {
    backgroundColor: c.primary,
    borderColor: c.primary,
  },
  rangePillText: { fontSize: 13, color: c.textSecondary, fontWeight: '500' as const },
  rangePillTextActive: { color: c.onPrimary, fontWeight: '600' as const },

  dateRangeLabel: {
    fontSize: 12,
    color: c.textMuted,
    marginBottom: 16,
  },

  summaryGrid: {
    flexDirection: 'row' as const,
    flexWrap: 'wrap' as const,
    gap: 10,
    marginBottom: 16,
  },
  summaryCard: {
    width: '31%' as const,
    backgroundColor: c.surface,
    borderRadius: 12,
    padding: 14,
    alignItems: 'center' as const,
  },
  summaryValue: { fontSize: 18, fontWeight: '700' as const },
  summaryLabel: { fontSize: 11, color: c.textMuted, marginTop: 4, textAlign: 'center' as const },

  section: {
    backgroundColor: c.surface,
    borderRadius: 14,
    padding: 16,
    marginBottom: 16,
  },
  sectionTitle: { fontSize: 16, fontWeight: '700' as const, color: c.text, marginBottom: 12 },
  emptyText: { fontSize: 13, color: c.textMuted, textAlign: 'center' as const, paddingVertical: 16 },

  chartContainer: {
    flexDirection: 'row' as const,
    alignItems: 'flex-end' as const,
    justifyContent: 'space-between' as const,
    height: 140,
    paddingTop: 16,
  },
  barWrapper: {
    flex: 1,
    alignItems: 'center' as const,
    justifyContent: 'flex-end' as const,
  },
  bar: {
    width: 14,
    backgroundColor: c.primary,
    borderRadius: 4,
    minHeight: 4,
  },
  barValue: { fontSize: 8, color: c.textMuted, marginBottom: 2 },
  barLabel: { fontSize: 9, color: c.textMuted, marginTop: 4 },

  statusRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    marginBottom: 10,
  },
  statusLeft: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    width: 100,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 8,
  },
  statusLabel: { fontSize: 12, color: c.textSecondary, textTransform: 'capitalize' as const },
  statusRight: {
    flex: 1,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 8,
  },
  statusBarTrack: {
    flex: 1,
    height: 8,
    backgroundColor: c.borderLight,
    borderRadius: 4,
    overflow: 'hidden' as const,
  },
  statusBarFill: {
    height: '100%' as const,
    borderRadius: 4,
  },
  statusCount: { fontSize: 11, color: c.textMuted, width: 70, textAlign: 'right' as const },

  tableHeader: {
    flexDirection: 'row' as const,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: c.borderLight,
    marginBottom: 4,
  },
  tableHeaderText: { fontSize: 11, fontWeight: '600' as const, color: c.textMuted },
  tableRow: {
    flexDirection: 'row' as const,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  tableCell: { fontSize: 13, color: c.text },
  creditCell: { color: c.error },
  };
}
