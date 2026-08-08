import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  TextInput,
  ScrollView,
  Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../../src/services/supabase';
import { useAuthStore } from '../../src/store/authStore';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import { useDebouncedValue } from '../../src/hooks/useDebouncedValue';
import type { AppColors } from '../../src/theme/colors';

const PAGE_SIZE = 50;

type Retailer = {
  id: string;
  name: string | null;
  phone: string | null;
  business_name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  role: string | null;
  approved: boolean | null;
  retailer_code: string | null;
};

export default function DeliveryCreateOrder() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const router = useRouter();
  const { user } = useAuthStore();

  // --- Retailer search state ---
  const [retailers, setRetailers] = useState<Retailer[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState('');
  const [searchByCode, setSearchByCode] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [selectedRetailerId, setSelectedRetailerId] = useState<string | null>(null);

  // --- Today's stops state ---
  const [todayStopRetailers, setTodayStopRetailers] = useState<Retailer[]>([]);

  // Debounce the search text so we don't fire an RPC on every keystroke
  const debouncedSearch = useDebouncedValue(search, 300);

  // Track the latest fetch to avoid stale responses from overlapping requests
  const fetchIdRef = useRef(0);

  const selectedRetailer = useMemo(() => {
    // Check in the main list first, then in today's stops
    return (
      retailers.find((r) => r.id === selectedRetailerId) ||
      todayStopRetailers.find((r) => r.id === selectedRetailerId) ||
      null
    );
  }, [retailers, todayStopRetailers, selectedRetailerId]);

  // -----------------------------------------------------------------------
  // Fetch retailers from the server-side search_retailers RPC
  // -----------------------------------------------------------------------
  const fetchRetailers = useCallback(
    async (offset: number, query: string, byCode: boolean, append: boolean) => {
      const myFetchId = ++fetchIdRef.current;

      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }

      try {
        const { data, error } = await supabase.rpc('search_retailers', {
          p_query: query || null,
          p_search_by_code: byCode,
          p_offset: offset,
          p_page_size: PAGE_SIZE,
        });

        // Discard stale response
        if (myFetchId !== fetchIdRef.current) return;

        if (error) throw error;

        const rows = (data || []) as (Retailer & { total_count: number })[];
        const newTotal = rows.length > 0 ? rows[0].total_count : 0;

        // Strip the total_count field from each row for state
        const cleaned: Retailer[] = rows.map(({ total_count, ...rest }) => rest);

        setTotalCount(newTotal);
        setHasMore(offset + cleaned.length < newTotal);

        if (append) {
          setRetailers((prev) => [...prev, ...cleaned]);
        } else {
          setRetailers(cleaned);
        }
      } catch (err: any) {
        if (myFetchId !== fetchIdRef.current) return;
        Alert.alert('Error', err.message || 'Failed to search retailers');
      } finally {
        if (myFetchId === fetchIdRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [],
  );

  // -----------------------------------------------------------------------
  // Fetch today's delivery stops (lightweight, separate query)
  // -----------------------------------------------------------------------
  const fetchTodayStops = useCallback(async () => {
    if (!user?.id) return;
    try {
      // 1. Get active order user_ids for this delivery user
      const { data: orderData, error: orderErr } = await supabase
        .from('orders')
        .select('user_id')
        .or(`assigned_to.eq.${user.id},created_by.eq.${user.id}`)
        .eq('fulfillment_mode', 'delivery')
        .in('status', ['assigned', 'accepted', 'picked_up', 'dispatched']);

      if (orderErr) throw orderErr;

      const ids = [...new Set((orderData || []).map((o: any) => o.user_id).filter(Boolean))] as string[];
      if (ids.length === 0) {
        setTodayStopRetailers([]);
        return;
      }

      // 2. Fetch just those retailer profiles (typically < 20 rows)
      const { data: profiles, error: profErr } = await supabase
        .from('profiles')
        .select('id, name, phone, business_name, address, city, state, pincode, role, approved, retailer_code')
        .in('id', ids);

      if (profErr) throw profErr;
      setTodayStopRetailers((profiles || []) as Retailer[]);
    } catch {
      // Silently fail — today's stops is non-critical UI
      setTodayStopRetailers([]);
    }
  }, [user?.id]);

  // -----------------------------------------------------------------------
  // When debounced search or toggle changes → reset and re-fetch from offset 0
  // -----------------------------------------------------------------------
  useEffect(() => {
    fetchRetailers(0, debouncedSearch, searchByCode, false);
  }, [debouncedSearch, searchByCode, fetchRetailers]);

  // -----------------------------------------------------------------------
  // On screen focus: refresh today's stops & reset search
  // -----------------------------------------------------------------------
  useFocusEffect(
    useCallback(() => {
      fetchTodayStops();
      // Also re-fetch the retailer list from offset 0 (e.g. after creating a new retailer)
      fetchRetailers(0, debouncedSearch, searchByCode, false);
    }, [fetchTodayStops, fetchRetailers, debouncedSearch, searchByCode]),
  );

  // -----------------------------------------------------------------------
  // Infinite scroll — load next page
  // -----------------------------------------------------------------------
  const handleLoadMore = useCallback(() => {
    if (loadingMore || !hasMore || loading) return;
    fetchRetailers(retailers.length, debouncedSearch, searchByCode, true);
  }, [loadingMore, hasMore, loading, retailers.length, debouncedSearch, searchByCode, fetchRetailers]);

  const goToAddItems = async () => {
    if (!selectedRetailer) {
      Alert.alert('Select Retailer', 'Please select a retailer first.');
      return;
    }

    router.push(`/delivery/create-order-items?retailerId=${selectedRetailer.id}`);
  };

  // -----------------------------------------------------------------------
  // Render helpers
  // -----------------------------------------------------------------------
  const renderFooter = () => {
    if (!loadingMore) return null;
    return (
      <View style={{ paddingVertical: 20, alignItems: 'center' }}>
        <ActivityIndicator size="small" color={colors.primary} />
      </View>
    );
  };

  if (loading && retailers.length === 0) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: 'Select Retailer' }} />
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Select Retailer' }} />

      <View style={styles.content}>
        <View style={styles.section}>
          <View style={styles.sectionTitleRow}>
            <Text style={styles.sectionTitle}>All Retailers</Text>
            {totalCount > 0 && (
              <Text style={styles.countBadge}>{totalCount.toLocaleString()}</Text>
            )}
          </View>
          <View style={styles.searchRow}>
            <View style={[styles.searchWrap, { flex: 1 }]}>
              <Ionicons name="search" size={16} color={colors.textMuted} />
              <TextInput
                style={styles.searchInput}
                placeholder={searchByCode ? 'Search by party code' : 'Search by party name'}
                placeholderTextColor={colors.textMuted}
                value={search}
                onChangeText={setSearch}
              />
              {search.length > 0 && (
                <TouchableOpacity onPress={() => setSearch('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="close-circle" size={16} color={colors.textMuted} />
                </TouchableOpacity>
              )}
            </View>
          </View>
          <View style={styles.toggleRow}>
            <Text style={[styles.toggleLabel, !searchByCode && styles.toggleLabelActive]}>
              Party Name
            </Text>
            <Switch
              value={searchByCode}
              onValueChange={(v) => {
                setSearchByCode(v);
                setSearch('');
              }}
              trackColor={{ false: colors.primaryMuted, true: colors.primaryMuted }}
              thumbColor={searchByCode ? colors.primary : colors.primary}
              style={{ marginHorizontal: 6 }}
            />
            <Text style={[styles.toggleLabel, searchByCode && styles.toggleLabelActive]}>
              Party Code
            </Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 12, marginTop: 10 }}>
            <TouchableOpacity
              style={styles.newRetailerBtn}
              onPress={() => router.push('/delivery/create-retailer')}
            >
              <Ionicons name="add-circle-outline" size={18} color={colors.primary} />
              <Text style={styles.newRetailerText}>New Retailer</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.newRetailerBtn, { backgroundColor: colors.primaryMuted, paddingHorizontal: 12, borderRadius: 8 }]}
              onPress={() => router.push('/orders/scan-bill')}
            >
              <Ionicons name="sparkles" size={18} color={colors.primary} />
              <Text style={[styles.newRetailerText, { fontWeight: '700' }]}>Scan Bill Photo (AI)</Text>
            </TouchableOpacity>
          </View>
        </View>

        {!search && todayStopRetailers.length > 0 && (
          <View style={styles.todayStopsSection}>
            <View style={styles.todayStopsHeader}>
              <Ionicons name="location" size={14} color={colors.primary} />
              <Text style={styles.todayStopsTitle}>Today's Delivery Stops</Text>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.todayStopsScroll}>
              {todayStopRetailers.map((item) => {
                const active = selectedRetailerId === item.id;
                return (
                  <TouchableOpacity
                    key={item.id}
                    style={[styles.todayStopCard, active && styles.todayStopCardActive]}
                    onPress={() => setSelectedRetailerId(item.id)}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.todayStopName} numberOfLines={1}>
                      {item.business_name || item.name || 'Retailer'}
                    </Text>
                    {item.retailer_code ? (
                      <Text style={styles.todayStopCode} numberOfLines={1}>
                        {item.retailer_code}
                      </Text>
                    ) : null}
                    <Text style={styles.todayStopCity} numberOfLines={2}>
                      {item.address || [item.city, item.state].filter(Boolean).join(', ') || '—'}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        )}

        <FlatList
          data={retailers}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 120 }}
          onEndReached={handleLoadMore}
          onEndReachedThreshold={0.4}
          ListFooterComponent={renderFooter}
          renderItem={({ item }) => {
            const active = selectedRetailerId === item.id;
            return (
              <TouchableOpacity
                style={[styles.retailerRow, active && styles.retailerRowActive]}
                onPress={() => setSelectedRetailerId(item.id)}
                activeOpacity={0.8}
              >
                <View style={{ flex: 1 }}>
                  <View style={styles.retailerTitleRow}>
                    <Text style={styles.retailerTitle} numberOfLines={1}>{item.business_name || item.name || 'Retailer'}</Text>
                    {item.retailer_code ? (
                      <View style={styles.codeBadge}>
                        <Text style={styles.codeBadgeText}>{item.retailer_code}</Text>
                      </View>
                    ) : null}
                  </View>
                  <Text style={styles.retailerSubtitle}>{item.name || '—'} · {item.phone || '—'}</Text>
                  {item.address ? (
                    <Text style={styles.retailerAddress} numberOfLines={2}>
                      {item.address}
                    </Text>
                  ) : item.city ? (
                    <Text style={styles.retailerAddress} numberOfLines={1}>
                      {[item.city, item.state].filter(Boolean).join(', ')}
                    </Text>
                  ) : null}
                </View>
                <Ionicons
                  name={active ? 'radio-button-on' : 'radio-button-off'}
                  size={20}
                  color={active ? colors.primary : colors.textMuted}
                />
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Text style={styles.emptyText}>
                {debouncedSearch ? 'No retailers match your search.' : 'No retailers found.'}
              </Text>
            </View>
          }
        />
      </View>

      <View style={styles.footer}>
        {selectedRetailer && (
          <Text style={styles.selectedText}>Selected: {selectedRetailer.business_name || selectedRetailer.name}</Text>
        )}
        <TouchableOpacity
          style={[styles.submitBtn, !selectedRetailer && { opacity: 0.6 }]}
          disabled={!selectedRetailer}
          onPress={goToAddItems}
        >
          <Text style={styles.submitText}>OK - Add Items</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function createStyles(c: AppColors, isDark: boolean) {
  return {
  container: { flex: 1, backgroundColor: c.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { flex: 1 },
  section: {
    backgroundColor: c.surface,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    padding: 14,
  },
  sectionTitleRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    marginBottom: 10,
  },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: c.text },
  countBadge: {
    fontSize: 12,
    fontWeight: '600' as const,
    color: c.textSecondary,
    backgroundColor: c.background,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
    overflow: 'hidden' as const,
  },
  searchRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 8,
  },
  searchWrap: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 8,
    backgroundColor: c.background,
    borderRadius: 10,
    paddingHorizontal: 10,
    height: 42,
  },
  searchInput: {
    flex: 1,
    color: c.text,
    fontSize: 14,
  },
  toggleRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    marginTop: 10,
    paddingVertical: 4,
  },
  toggleLabel: {
    fontSize: 12,
    fontWeight: '600' as const,
    color: c.textMuted,
  },
  toggleLabelActive: {
    color: c.primary,
    fontWeight: '700' as const,
  },
  retailerRow: {
    marginTop: 12,
    backgroundColor: c.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.switchTrackOff,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  retailerRowActive: {
    borderColor: c.primary,
    backgroundColor: c.primaryMuted,
  },
  retailerTitleRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 8,
  },
  retailerTitle: { fontSize: 14, fontWeight: '700', color: c.text, flexShrink: 1 },
  codeBadge: {
    backgroundColor: c.primaryMuted,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: c.primary,
  },
  codeBadgeText: {
    fontSize: 11,
    fontWeight: '700' as const,
    color: c.primary,
    letterSpacing: 0.5,
  },
  retailerSubtitle: { marginTop: 2, fontSize: 12, color: c.textSecondary },
  retailerAddress: { marginTop: 2, fontSize: 11, color: c.textSecondary },
  emptyWrap: { marginTop: 40, alignItems: 'center' },
  emptyText: { color: c.textMuted },
  newRetailerBtn: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 6,
    marginTop: 10,
    paddingVertical: 8,
  },
  newRetailerText: {
    color: c.primary,
    fontSize: 14,
    fontWeight: '600' as const,
  },
  footer: {
    backgroundColor: c.surface,
    borderTopWidth: 1,
    borderTopColor: c.border,
    padding: 16,
  },
  selectedText: {
    marginBottom: 10,
    color: c.primary,
    fontWeight: '600',
  },
  submitBtn: {
    height: 52,
    borderRadius: 10,
    backgroundColor: c.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitText: { color: c.surface, fontSize: 16, fontWeight: '700' },
  todayStopsSection: {
    backgroundColor: c.surface,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  todayStopsHeader: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 6,
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  todayStopsTitle: {
    fontSize: 12,
    fontWeight: '700' as const,
    color: c.textSecondary,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
  },
  todayStopsScroll: {
    paddingHorizontal: 16,
    gap: 10,
  },
  todayStopCard: {
    width: 140,
    padding: 10,
    borderRadius: 10,
    backgroundColor: c.background,
    borderWidth: 1,
    borderColor: c.border,
  },
  todayStopCardActive: {
    borderColor: c.primary,
    backgroundColor: c.primaryMuted,
  },
  todayStopName: {
    fontSize: 12,
    fontWeight: '700' as const,
    color: c.text,
  },
  todayStopCode: {
    fontSize: 10,
    fontWeight: '700' as const,
    color: c.primary,
    marginTop: 2,
  },
  todayStopCity: {
    fontSize: 10,
    color: c.textMuted,
    marginTop: 2,
  },
  } as const;
}
