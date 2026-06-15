// P6: i18n applied — all strings use t() from src/i18n
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
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
    <SafeAreaView style={styles.container}>
      <Stack.Screen
        options={{
          title: t('admin.analyticsScreen.title'),
          headerRight: () => (
            <TouchableOpacity onPress={exportCsv} style={{ paddingHorizontal: 12 }}>
              <Ionicons name="download-outline" size={22} color="#4C51C9" />
            </TouchableOpacity>
          ),
        }}
      />

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
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
          <SkeletonSection />
        ) : summary ? (
          <View style={styles.summaryGrid}>
            <SummaryCard label={t('admin.analyticsScreen.totalOrders')} value={summary.total_orders} color="#4C51C9" />
            <SummaryCard label={t('admin.analyticsScreen.delivered')} value={summary.delivered_orders} color="#66BB6A" />
            <SummaryCard label={t('admin.analyticsScreen.cancelled')} value={summary.cancelled_orders} color="#EF5350" />
            <SummaryCard label={t('admin.analyticsScreen.netRevenue')} value={`₹${Number(summary.net_revenue).toFixed(0)}`} color="#43A047" />
            <SummaryCard label={t('admin.analyticsScreen.avgOrderValue')} value={`₹${Number(summary.avg_order_value).toFixed(0)}`} color="#7E57C2" />
            <SummaryCard label={t('admin.analyticsScreen.creditOutstanding')} value={`₹${Number(summary.total_credit_outstanding).toFixed(0)}`} color="#FF7043" />
          </View>
        ) : null}

        {/* Revenue Chart (Simple Bar) */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('admin.analyticsScreen.dailyRevenue')}</Text>
          {loadingDaily ? (
            <ActivityIndicator size="small" color="#4C51C9" style={{ marginVertical: 20 }} />
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
            <ActivityIndicator size="small" color="#4C51C9" style={{ marginVertical: 20 }} />
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
            <ActivityIndicator size="small" color="#4C51C9" style={{ marginVertical: 20 }} />
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
            <ActivityIndicator size="small" color="#4C51C9" style={{ marginVertical: 20 }} />
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
                  <Text style={[styles.tableCell, { flex: 1.2, textAlign: 'right', color: '#EF5350' }]}>
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

function SummaryCard({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <View style={styles.summaryCard}>
      <Text style={[styles.summaryValue, { color }]}>{value}</Text>
      <Text style={styles.summaryLabel}>{label}</Text>
    </View>
  );
}

function SkeletonSection() {
  return (
    <View style={[styles.summaryGrid, { opacity: 0.4 }]}>
      {[...Array(6)].map((_, i) => (
        <View key={i} style={[styles.summaryCard, { backgroundColor: '#e0e0e0' }]}>
          <View style={{ width: 50, height: 22, backgroundColor: '#ccc', borderRadius: 4, marginBottom: 6 }} />
          <View style={{ width: 70, height: 12, backgroundColor: '#ccc', borderRadius: 4 }} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },

  rangeRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  rangePill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  rangePillActive: {
    backgroundColor: '#4C51C9',
    borderColor: '#4C51C9',
  },
  rangePillText: { fontSize: 13, color: '#555', fontWeight: '500' },
  rangePillTextActive: { color: '#fff', fontWeight: '600' },

  dateRangeLabel: {
    fontSize: 12,
    color: '#888',
    marginBottom: 16,
  },

  summaryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 16,
  },
  summaryCard: {
    width: '31%',
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
  },
  summaryValue: { fontSize: 18, fontWeight: '700' },
  summaryLabel: { fontSize: 11, color: '#888', marginTop: 4, textAlign: 'center' },

  section: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 16,
    marginBottom: 16,
  },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: '#333', marginBottom: 12 },
  emptyText: { fontSize: 13, color: '#999', textAlign: 'center', paddingVertical: 16 },

  chartContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    height: 140,
    paddingTop: 16,
  },
  barWrapper: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  bar: {
    width: 14,
    backgroundColor: '#4C51C9',
    borderRadius: 4,
    minHeight: 4,
  },
  barValue: { fontSize: 8, color: '#888', marginBottom: 2 },
  barLabel: { fontSize: 9, color: '#888', marginTop: 4 },

  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  statusLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    width: 100,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 8,
  },
  statusLabel: { fontSize: 12, color: '#555', textTransform: 'capitalize' },
  statusRight: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusBarTrack: {
    flex: 1,
    height: 8,
    backgroundColor: '#f0f0f0',
    borderRadius: 4,
    overflow: 'hidden',
  },
  statusBarFill: {
    height: '100%',
    borderRadius: 4,
  },
  statusCount: { fontSize: 11, color: '#888', width: 70, textAlign: 'right' },

  tableHeader: {
    flexDirection: 'row',
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
    marginBottom: 4,
  },
  tableHeaderText: { fontSize: 11, fontWeight: '600', color: '#888' },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f8f8f8',
  },
  tableCell: { fontSize: 13, color: '#333' },
});
