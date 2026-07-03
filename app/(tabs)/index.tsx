import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  Alert,
  Animated,
  Image,
} from 'react-native';
import { TabScreenFrame, useTabHeaderSafePadding } from '../../src/components/TabScreenFrame';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { useAuthStore } from '../../src/store/authStore';
import { useCartStore } from '../../src/store/cartStore';
import { useSettingsStore } from '../../src/store/settingsStore';
import {
  useHomeCache,
  catalogueCacheKey,
  isCatalogueCacheFresh,
  isPersonalizedCacheFresh,
  isRestockCacheFresh,
  isBrandDiscoveryCacheFresh,
  isCohortCacheFresh,
  brandDiscoverySectionTitle,
  PERSONALIZED_CACHE_TTL_MS,
  type RestockRecommendation,
  type BrandDiscoveryRecommendation,
  type CohortRecommendation,
} from '../../src/store/homeStore';

import { CategoryCard } from '../../src/components/CategoryCard';
import { ProductCard } from '../../src/components/ProductCard';

import { Product, shouldShowPrices, canAddToCart, PRODUCT_LIST_SELECT } from '../../src/types';
import { supabase } from '../../src/services/supabase';
import { supabaseErrorMessage } from '../../src/utils/networkErrors';
import { tabScrollBottomPadding } from '../../src/theme/tabBarTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import type { AppColors } from '../../src/theme/colors';

/* ================= TYPES ================= */

interface Category {
  id: string;
  name: string;
}

function restockBadgeMeta(urgency: number): { color: string; status: string } {
  if (urgency >= 1.5) return { color: '#E53935', status: 'Overdue' };
  if (urgency >= 1.0) return { color: '#FB8C00', status: 'Due now' };
  return { color: '#1E88E5', status: 'Due soon' };
}

/* ================= SCREEN ================= */

export default function Home() {
  const styles = useThemedStyles(createTabStyles);
  const headerSafePadding = useTabHeaderSafePadding();
  const router = useRouter();
  const { user, fetchUser } = useAuthStore();
  const { addToCart } = useCartStore();
  const { settings } = useSettingsStore();
  const { setHomeCache, setCatalogueCache, setRestockCache, setBrandDiscoveryCache, setCohortCache } =
    useHomeCache();

  const [categories, setCategories] = useState<Category[]>(() => {
    const userId = useAuthStore.getState().user?.id;
    if (!isCatalogueCacheFresh(userId, false)) return [];
    const entry =
      useHomeCache.getState().catalogueData[catalogueCacheKey(userId)];
    return entry?.categories ?? [];
  });
  const [featuredProducts, setFeaturedProducts] = useState<Product[]>(() => {
    const userId = useAuthStore.getState().user?.id;
    if (!isCatalogueCacheFresh(userId, false)) return [];
    const entry =
      useHomeCache.getState().catalogueData[catalogueCacheKey(userId)];
    return entry?.featuredProducts ?? [];
  });
  const [reorderProducts, setReorderProducts] = useState<Product[]>(() => {
    const fresh =
      useHomeCache.getState().homeCache.fetchedAt !== null &&
      useHomeCache.getState().cachedUserId === useAuthStore.getState().user?.id &&
      Date.now() - (useHomeCache.getState().homeCache.fetchedAt || 0) <
        PERSONALIZED_CACHE_TTL_MS;
    return fresh ? useHomeCache.getState().homeCache.orderAgain : [];
  });
  const [restockProducts, setRestockProducts] = useState<
    RestockRecommendation[]
  >(() => {
    const userId = useAuthStore.getState().user?.id;
    if (!userId || !isRestockCacheFresh(userId, false)) return [];
    return useHomeCache.getState().restockData[userId] ?? [];
  });
  const [brandDiscoveryProducts, setBrandDiscoveryProducts] = useState<
    BrandDiscoveryRecommendation[]
  >(() => {
    const userId = useAuthStore.getState().user?.id;
    if (!userId || !isBrandDiscoveryCacheFresh(userId, false)) return [];
    return useHomeCache.getState().brandDiscoveryData[userId]?.items ?? [];
  });
  const [cohortProducts, setCohortProducts] = useState<
    CohortRecommendation[]
  >(() => {
    const userId = useAuthStore.getState().user?.id;
    if (!userId || !isCohortCacheFresh(userId, false)) return [];
    return useHomeCache.getState().cohortData[userId] ?? [];
  });
  const [brandDiscoveryTitle, setBrandDiscoveryTitle] = useState(() => {
    const userId = useAuthStore.getState().user?.id;
    if (!userId || !isBrandDiscoveryCacheFresh(userId, false)) {
      return 'New from brands you buy';
    }
    return (
      useHomeCache.getState().brandDiscoveryData[userId]?.sectionTitle ??
      'New from brands you buy'
    );
  });
  const [refreshing, setRefreshing] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const fetchGenerationRef = useRef(0);
  const [toast, setToast] = useState<string | null>(null);
  const toastOpacity = useRef(new Animated.Value(0)).current;

  const showToast = useCallback((message: string) => {
    setToast(message);
    Animated.sequence([
      Animated.timing(toastOpacity, { toValue: 1, duration: 300, useNativeDriver: true }),
      Animated.delay(2500),
      Animated.timing(toastOpacity, { toValue: 0, duration: 300, useNativeDriver: true }),
    ]).start(() => setToast(null));
  }, [toastOpacity]);

  const isVerified =
    user?.role === 'admin' || user?.approved === true;

  const showPrices = shouldShowPrices(user, settings);
  const allowAddToCart = canAddToCart(user);

  const creditAvailable = Math.max(
    0,
    (user?.credit_limit || 0) - (user?.credit_used || 0),
  );

  /* ================= FETCH ================= */

  const fetchData = useCallback(
    async (forceRefetch = false) => {
      const generation = ++fetchGenerationRef.current;
      const isStale = () => generation !== fetchGenerationRef.current;
      const userId = user?.id;

      try {
        const catKey = catalogueCacheKey(userId);
        const isCacheFresh = isPersonalizedCacheFresh(userId, forceRefetch);
        const isCatalogueFresh = isCatalogueCacheFresh(userId, forceRefetch);
        const isRestockFresh = isRestockCacheFresh(userId, forceRefetch);
        const isBrandDiscoveryFresh = isBrandDiscoveryCacheFresh(
          userId,
          forceRefetch,
        );
        const isCohortFresh = isCohortCacheFresh(userId, forceRefetch);

        const shouldFetchCatalogue = !isCatalogueFresh;
        const shouldFetchOrders = !!userId && !isCacheFresh;
        const shouldFetchRestock = !!userId && !isRestockFresh;
        const shouldFetchBrandDiscovery = !!userId && !isBrandDiscoveryFresh;
        const shouldFetchCohort = !!userId && !isCohortFresh;

        if (!isStale()) {
          setFetchError(null);
        }

        if (isCatalogueFresh) {
          const entry = useHomeCache.getState().catalogueData[catKey];
          if (entry && !isStale()) {
            setCategories(entry.categories);
            setFeaturedProducts(entry.featuredProducts);
          }
        }

        if (isRestockFresh && userId && !isStale()) {
          setRestockProducts(
            useHomeCache.getState().restockData[userId] ?? [],
          );
        }

        if (isBrandDiscoveryFresh && userId && !isStale()) {
          const entry = useHomeCache.getState().brandDiscoveryData[userId];
          if (entry) {
            setBrandDiscoveryProducts(entry.items);
            setBrandDiscoveryTitle(entry.sectionTitle);
          }
        }

        if (isCohortFresh && userId && !isStale()) {
          setCohortProducts(
            useHomeCache.getState().cohortData[userId] ?? [],
          );
        }

        type FetchTask = {
          kind:
            | 'categories'
            | 'featured'
            | 'orders'
            | 'restock'
            | 'brandDiscovery'
            | 'companySummary'
            | 'cohort';
          promise: PromiseLike<unknown>;
        };
        const tasks: FetchTask[] = [];

        if (shouldFetchCatalogue) {
          tasks.push(
            {
              kind: 'categories',
              promise: supabase
                .from('categories')
                .select('id, name')
                .eq('is_active', true)
                .order('name'),
            },
            {
              kind: 'featured',
              promise: supabase
                .from('products')
                .select(PRODUCT_LIST_SELECT)
                .eq('is_active', true)
                .order('created_at', { ascending: false })
                .limit(6),
            },
          );
        }

        if (shouldFetchOrders && userId) {
          tasks.push({
            kind: 'orders',
            promise: supabase
              .from('orders')
              .select('items')
              .eq('user_id', userId)
              .neq('status', 'cancelled')
              .order('created_at', { ascending: false })
              .limit(100),
          });
        }

        if (shouldFetchRestock && userId) {
          tasks.push({
            kind: 'restock',
            promise: supabase.rpc('get_restock_recommendations'),
          });
        }

        if (shouldFetchBrandDiscovery && userId) {
          tasks.push(
            {
              kind: 'brandDiscovery',
              promise: supabase.rpc('get_brand_discovery_recommendations'),
            },
            {
              kind: 'companySummary',
              promise: supabase.rpc('get_company_purchase_summary'),
            },
          );
        }

        if (shouldFetchCohort && userId) {
          tasks.push({
            kind: 'cohort',
            promise: supabase.rpc('get_cohort_recommendations'),
          });
        }

        if (tasks.length === 0) {
          return;
        }

        const results = await Promise.all(tasks.map((t) => t.promise));
        if (isStale()) return;

        for (let i = 0; i < tasks.length; i++) {
          const task = tasks[i];
          const result = results[i] as {
            data: unknown;
            error: unknown;
          };

          if (
            task.kind === 'categories' ||
            task.kind === 'featured' ||
            task.kind === 'companySummary'
          ) {
            continue;
          }

          if (task.kind === 'brandDiscovery') {
            const summaryIdx = tasks.findIndex(
              (t) => t.kind === 'companySummary',
            );
            const summaryResult =
              summaryIdx >= 0
                ? (results[summaryIdx] as {
                    data: { company_name: string; order_count: number }[] | null;
                    error: unknown;
                  })
                : null;

            if (result.error) {
              setFetchError(supabaseErrorMessage(result.error));
              setBrandDiscoveryProducts([]);
              setBrandDiscoveryTitle('New from brands you buy');
              if (userId) {
                setBrandDiscoveryCache(userId, {
                  items: [],
                  sectionTitle: 'New from brands you buy',
                });
              }
            } else {
              const rows =
                (result.data as BrandDiscoveryRecommendation[] | null) ?? [];
              const sectionTitle =
                summaryResult && !summaryResult.error && summaryResult.data
                  ? brandDiscoverySectionTitle(summaryResult.data)
                  : 'New from brands you buy';
              setBrandDiscoveryProducts(rows);
              setBrandDiscoveryTitle(sectionTitle);
              if (userId) {
                setBrandDiscoveryCache(userId, {
                  items: rows,
                  sectionTitle,
                });
              }
            }
            continue;
          }

          if (task.kind === 'restock') {
            if (result.error) {
              setFetchError(supabaseErrorMessage(result.error));
              setRestockProducts([]);
              if (userId) setRestockCache(userId, []);
            } else {
              const rows = (result.data as RestockRecommendation[] | null) ?? [];
              setRestockProducts(rows);
              if (userId) setRestockCache(userId, rows);
            }
            continue;
          }

          if (task.kind === 'cohort') {
            if (result.error) {
              setFetchError(supabaseErrorMessage(result.error));
              setCohortProducts([]);
              if (userId) setCohortCache(userId, []);
            } else {
              const rows = (result.data as CohortRecommendation[] | null) ?? [];
              setCohortProducts(rows);
              if (userId) setCohortCache(userId, rows);
            }
            continue;
          }

          if (task.kind === 'orders' && userId) {
            const ordersResult = result as {
              data: { items: unknown }[] | null;
              error: unknown;
            };

            if (ordersResult.error) {
              setFetchError(supabaseErrorMessage(ordersResult.error));
              setReorderProducts([]);
              setHomeCache([], userId);
            } else if (ordersResult.data) {
              const reorderProductIds: string[] = [];
              for (const order of ordersResult.data) {
                if (Array.isArray(order.items)) {
                  for (const item of order.items) {
                    const row = item as { product_id?: string };
                    if (
                      row.product_id &&
                      !reorderProductIds.includes(row.product_id)
                    ) {
                      reorderProductIds.push(row.product_id);
                      if (reorderProductIds.length >= 10) break;
                    }
                  }
                }
                if (reorderProductIds.length >= 10) break;
              }

              if (reorderProductIds.length > 0) {
                const { data: prods, error: prodsError } = await supabase
                  .from('products')
                  .select(PRODUCT_LIST_SELECT)
                  .in('id', reorderProductIds)
                  .eq('is_active', true)
                  .gt('stock_quantity', 0);

                if (isStale()) return;

                if (prodsError) {
                  setFetchError(supabaseErrorMessage(prodsError));
                  setReorderProducts([]);
                  setHomeCache([], userId);
                } else {
                  const prodsList = prods || [];
                  const reorderProds = reorderProductIds
                    .map((id) => prodsList.find((p) => p.id === id))
                    .filter((p): p is Product => !!p);

                  setReorderProducts(reorderProds);
                  setHomeCache(reorderProds, userId);
                }
              } else {
                setReorderProducts([]);
                setHomeCache([], userId);
              }
            } else {
              setReorderProducts([]);
              setHomeCache([], userId);
            }
          }
        }

        if (shouldFetchCatalogue) {
          const catIdx = tasks.findIndex((t) => t.kind === 'categories');
          const featIdx = tasks.findIndex((t) => t.kind === 'featured');
          const catResult = results[catIdx] as {
            data: Category[] | null;
            error: unknown;
          };
          const featuredResult = results[featIdx] as {
            data: Product[] | null;
            error: unknown;
          };

          if (catResult.error || featuredResult.error) {
            const msg = supabaseErrorMessage(
              catResult.error || featuredResult.error,
            );
            setFetchError(msg);
          }

          const nextCategories = catResult.data || [];
          const nextFeatured = featuredResult.data || [];
          setCategories(nextCategories);
          setFeaturedProducts(nextFeatured);
          setCatalogueCache(catKey, nextCategories, nextFeatured);
        }
      } catch (error) {
        if (!isStale()) {
          console.error('Error fetching home data:', error);
          setFetchError(supabaseErrorMessage(error));
        }
      }
    },
    [
      user?.id,
      setHomeCache,
      setCatalogueCache,
      setRestockCache,
      setBrandDiscoveryCache,
    ],
  );

  useEffect(() => {
    const userId = user?.id;
    if (!userId) {
      setRestockProducts([]);
      setBrandDiscoveryProducts([]);
      setBrandDiscoveryTitle('New from brands you buy');
      setCohortProducts([]);
      void fetchData(false);
      return;
    }

    const { homeCache: cache } = useHomeCache.getState();
    if (isPersonalizedCacheFresh(userId, false)) {
      setReorderProducts(cache.orderAgain);
    } else {
      setReorderProducts([]);
    }

    if (isRestockCacheFresh(userId, false)) {
      setRestockProducts(
        useHomeCache.getState().restockData[userId] ?? [],
      );
    } else {
      setRestockProducts([]);
    }

    if (isBrandDiscoveryCacheFresh(userId, false)) {
      const entry = useHomeCache.getState().brandDiscoveryData[userId];
      if (entry) {
        setBrandDiscoveryProducts(entry.items);
        setBrandDiscoveryTitle(entry.sectionTitle);
      }
    } else {
      setBrandDiscoveryProducts([]);
      setBrandDiscoveryTitle('New from brands you buy');
    }

    if (isCohortCacheFresh(userId, false)) {
      setCohortProducts(
        useHomeCache.getState().cohortData[userId] ?? [],
      );
    } else {
      setCohortProducts([]);
    }

    void fetchData(false);
  }, [user?.id, fetchData]);

  useFocusEffect(
    useCallback(() => {
      void fetchData(false);
    }, [user?.id, fetchData]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchData(true);
    if (user?.id) {
      await fetchUser({ silent: true });
    }
    setRefreshing(false);
  }, [user?.id, fetchUser, fetchData]);

  /* ================= ACTIONS ================= */

  const handleAddToCart = async (product: Product) => {
    if (!user) {
      Alert.alert('Login Required', 'Please login to add items to cart');
      return;
    }
    if (!allowAddToCart) {
      Alert.alert(
        'Approval Required',
        'Your account must be approved before you can add items to cart.',
      );
      return;
    }

    const result = await addToCart(product.id, 1);
    if (result === true) {
      Alert.alert('Added to Cart', `${product.name} added to your cart`);
    } else if (typeof result === 'object' && 'error' in result) {
      showToast(result.error);
    } else {
      Alert.alert('Error', 'Failed to add to cart. Please try again.');
    }
  };

  const handleAddBrandDiscoveryToCart = async (
    item: BrandDiscoveryRecommendation,
  ) => {
    if (!user) {
      Alert.alert('Login Required', 'Please login to add items to cart');
      return;
    }
    if (!allowAddToCart) {
      Alert.alert(
        'Approval Required',
        'Your account must be approved before you can add items to cart.',
      );
      return;
    }

    const result = await addToCart(item.product_id, 1);
    if (result === true) {
      Alert.alert('Added to Cart', `${item.name} added to your cart`);
    } else if (typeof result === 'object' && 'error' in result) {
      showToast(result.error);
    } else {
      Alert.alert('Error', 'Failed to add to cart. Please try again.');
    }
  };

  const handleAddCohortToCart = async (
    item: CohortRecommendation,
  ) => {
    if (!user) {
      Alert.alert('Login Required', 'Please login to add items to cart');
      return;
    }
    if (!allowAddToCart) {
      Alert.alert(
        'Approval Required',
        'Your account must be approved before you can add items to cart.',
      );
      return;
    }

    const result = await addToCart(item.product_id, 1);
    if (result === true) {
      Alert.alert('Added to Cart', `${item.name} added to your cart`);
    } else if (typeof result === 'object' && 'error' in result) {
      showToast(result.error);
    } else {
      Alert.alert('Error', 'Failed to add to cart. Please try again.');
    }
  };

  const handleAddRestockToCart = async (item: RestockRecommendation) => {
    if (!user) {
      Alert.alert('Login Required', 'Please login to add items to cart');
      return;
    }
    if (!allowAddToCart) {
      Alert.alert(
        'Approval Required',
        'Your account must be approved before you can add items to cart.',
      );
      return;
    }

    const result = await addToCart(item.product_id, 1);
    if (result === true) {
      Alert.alert('Added to Cart', `${item.name} added to your cart`);
    } else if (typeof result === 'object' && 'error' in result) {
      showToast(result.error);
    } else {
      Alert.alert('Error', 'Failed to add to cart. Please try again.');
    }
  };

  /* ================= UI ================= */

  return (
    <TabScreenFrame style={styles.container}>
      {/* Header */}
      <View style={[styles.header, headerSafePadding]}>
        <View>
          <Text style={styles.greeting}>
            Hello, {user?.name || 'Guest'}
          </Text>
          <Text style={styles.businessName}>
            {user?.business_name || 'Welcome'}
          </Text>
        </View>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={tabScrollBottomPadding()}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      >
        {fetchError ? (
          <Text style={styles.fetchErrorText}>{fetchError}</Text>
        ) : null}

        {/* Stats */}
        {isVerified && (
          <View style={styles.statsContainer}>
            <View style={styles.statCard}>
              <Ionicons name="star" size={24} color="#FFA726" />
              <Text style={styles.statValue}>
                {user?.loyalty_points || 0}
              </Text>
              <Text style={styles.statLabel}>Points</Text>
            </View>

            <View style={styles.statCard}>
              <Ionicons name="wallet" size={24} color="#43A047" />
              <Text style={styles.statValue}>
                ₹{creditAvailable.toFixed(0)}
              </Text>
              <Text style={styles.statLabel}>Credit Available</Text>
            </View>
          </View>
        )}

        {/* Scan Product Quick Action */}
        <TouchableOpacity
          style={styles.scanCard}
          activeOpacity={0.7}
          onPress={() => router.push('/product/scan')}
        >
          <View style={styles.scanIconWrap}>
            <Ionicons name="scan" size={28} color="#fff" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.scanTitle}>Scan &amp; Identify Product</Text>
            <Text style={styles.scanSubtitle}>
              Take a photo of a box or strip to find it instantly
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color="#fff" />
        </TouchableOpacity>

        {/* Unverified Notice */}
        {user && !user.approved && (
          <View style={styles.unverifiedBox}>
            <Ionicons
              name="information-circle"
              size={24}
              color="#4C51C9"
            />
            <View style={{ flex: 1 }}>
              <Text style={styles.unverifiedTitle}>
                Account Pending Verification
              </Text>
              <Text style={styles.unverifiedText}>
                You can browse products; admin approval is required to add items to cart and place orders.
              </Text>
            </View>
          </View>
        )}

        {/* Time to restock */}
        {user && restockProducts.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Time to restock</Text>
            </View>

            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              {restockProducts.map((item) => {
                const days = Math.round(item.days_since_last_order);
                const badge = restockBadgeMeta(item.restock_urgency);
                return (
                  <View key={item.product_id} style={styles.restockCard}>
                    <TouchableOpacity
                      activeOpacity={0.7}
                      onPress={() =>
                        router.push(`/product/${item.product_id}`)
                      }
                      style={styles.restockCardBody}
                    >
                      <View style={styles.restockImageWrap}>
                        {item.image ? (
                          <Image
                            source={{ uri: item.image }}
                            style={styles.restockImage}
                          />
                        ) : (
                          <View style={styles.restockImagePlaceholder}>
                            <Ionicons
                              name="medical"
                              size={24}
                              color="#4C51C9"
                            />
                          </View>
                        )}
                      </View>
                      <View
                        style={[
                          styles.restockBadge,
                          { backgroundColor: badge.color },
                        ]}
                      >
                        <Text style={styles.restockBadgeStatus}>
                          {badge.status}
                        </Text>
                        <Text style={styles.restockBadgeDays}>
                          {days} days since last order
                        </Text>
                      </View>
                      <Text style={styles.restockName} numberOfLines={2}>
                        {item.name}
                      </Text>
                      {showPrices && (
                        <Text style={styles.restockPrice}>
                          ₹{item.selling_price}
                        </Text>
                      )}
                    </TouchableOpacity>
                    {allowAddToCart &&
                      (item.stock_quantity <= 0 ? (
                        <Text style={styles.miniCardOutOfStock}>
                          Out of Stock
                        </Text>
                      ) : (
                        <TouchableOpacity
                          style={styles.reorderBtn}
                          onPress={() => handleAddRestockToCart(item)}
                        >
                          <Ionicons name="add" size={16} color="#fff" />
                          <Text style={styles.reorderBtnText}>Add</Text>
                        </TouchableOpacity>
                      ))}
                  </View>
                );
              })}
            </ScrollView>
          </View>
        )}

        {/* Order Again */}
        {user && reorderProducts.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Order Again</Text>
              <TouchableOpacity
                onPress={() => router.push('/(tabs)/orders')}
              >
                <Text style={styles.seeAll}>View Orders</Text>
              </TouchableOpacity>
            </View>

            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              {reorderProducts.map((p) => (
                <View key={p.id} style={styles.reorderCard}>
                  <TouchableOpacity
                    activeOpacity={0.7}
                    onPress={() => router.push(`/product/${p.id}`)}
                    style={styles.reorderCardBody}
                  >
                    <View style={styles.reorderIcon}>
                      <Ionicons name="medical" size={24} color="#4C51C9" />
                    </View>
                    <Text style={styles.reorderName} numberOfLines={2}>
                      {p.name}
                    </Text>
                    {p.pack_size && (
                      <Text style={styles.reorderPack}>{p.pack_size}</Text>
                    )}
                    {showPrices && (
                      <Text style={styles.reorderPrice}>
                        ₹{p.selling_price}
                      </Text>
                    )}
                  </TouchableOpacity>
                  {allowAddToCart &&
                    (p.stock_quantity <= 0 ? (
                      <Text style={styles.miniCardOutOfStock}>Out of Stock</Text>
                    ) : (
                      <TouchableOpacity
                        style={styles.reorderBtn}
                        onPress={() => handleAddToCart(p)}
                      >
                        <Ionicons name="add" size={16} color="#fff" />
                        <Text style={styles.reorderBtnText}>Add</Text>
                      </TouchableOpacity>
                    ))}
                </View>
              ))}
            </ScrollView>
          </View>
        )}

        {/* New from brands you buy */}
        {user && brandDiscoveryProducts.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>{brandDiscoveryTitle}</Text>
            </View>

            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              {brandDiscoveryProducts.map((item) => (
                <View key={item.product_id} style={styles.brandDiscoveryCard}>
                  <TouchableOpacity
                    activeOpacity={0.7}
                    onPress={() =>
                      router.push(`/product/${item.product_id}`)
                    }
                    style={styles.brandDiscoveryCardBody}
                  >
                    <View style={styles.brandDiscoveryImageWrap}>
                      {item.image ? (
                        <Image
                          source={{ uri: item.image }}
                          style={styles.brandDiscoveryImage}
                        />
                      ) : (
                        <View style={styles.brandDiscoveryImagePlaceholder}>
                          <Ionicons
                            name="medical"
                            size={24}
                            color="#4C51C9"
                          />
                        </View>
                      )}
                      {item.is_new_arrival ? (
                        <View style={styles.brandDiscoveryNewBadge}>
                          <Text style={styles.brandDiscoveryNewBadgeText}>
                            NEW
                          </Text>
                        </View>
                      ) : null}
                    </View>
                    <Text style={styles.brandDiscoveryName} numberOfLines={2}>
                      {item.name}
                    </Text>
                    <Text style={styles.brandDiscoveryCompany} numberOfLines={1}>
                      by {item.company_name}
                    </Text>
                    {showPrices && (
                      <Text style={styles.brandDiscoveryPrice}>
                        ₹{item.selling_price}
                      </Text>
                    )}
                  </TouchableOpacity>
                  {allowAddToCart &&
                    (item.stock_quantity <= 0 ? (
                      <Text style={styles.miniCardOutOfStock}>
                        Out of Stock
                      </Text>
                    ) : (
                      <TouchableOpacity
                        style={styles.reorderBtn}
                        onPress={() => handleAddBrandDiscoveryToCart(item)}
                      >
                        <Ionicons name="add" size={16} color="#fff" />
                        <Text style={styles.reorderBtnText}>Add</Text>
                      </TouchableOpacity>
                    ))}
                </View>
              ))}
            </ScrollView>
          </View>
        )}

        {/* Popular in your area */}
        {user && cohortProducts.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Popular in your area</Text>
            </View>

            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              {cohortProducts.map((item) => (
                <View key={item.product_id} style={styles.cohortCard}>
                  <TouchableOpacity
                    activeOpacity={0.7}
                    onPress={() =>
                      router.push(`/product/${item.product_id}`)
                    }
                    style={styles.cohortCardBody}
                  >
                    <View style={styles.cohortImageWrap}>
                      {item.image ? (
                        <Image
                          source={{ uri: item.image }}
                          style={styles.cohortImage}
                        />
                      ) : (
                        <View style={styles.cohortImagePlaceholder}>
                          <Ionicons
                            name="medical"
                            size={24}
                            color="#4C51C9"
                          />
                        </View>
                      )}
                    </View>
                    <Text style={styles.cohortName} numberOfLines={2}>
                      {item.name}
                    </Text>
                    {showPrices && (
                      <Text style={styles.cohortPrice}>
                        ₹{item.selling_price}
                      </Text>
                    )}
                  </TouchableOpacity>
                  {allowAddToCart &&
                    (item.stock_quantity <= 0 ? (
                      <Text style={styles.miniCardOutOfStock}>
                        Out of Stock
                      </Text>
                    ) : (
                      <TouchableOpacity
                        style={styles.reorderBtn}
                        onPress={() => handleAddCohortToCart(item)}
                      >
                        <Ionicons name="add" size={16} color="#fff" />
                        <Text style={styles.reorderBtnText}>Add</Text>
                      </TouchableOpacity>
                    ))}
                </View>
              ))}
            </ScrollView>
          </View>
        )}

        {/* Categories */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Categories</Text>
            <TouchableOpacity
              onPress={() => router.push('/(tabs)/products')}
            >
              <Text style={styles.seeAll}>See All</Text>
            </TouchableOpacity>
          </View>

          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {categories.map((c) => (
              <CategoryCard
                key={c.id}
                category={c}
                onPress={() =>
                  router.push(
                    `/(tabs)/products?category=${encodeURIComponent(c.name)}`,
                  )
                }
              />
            ))}
          </ScrollView>
        </View>

        {/* Featured Products */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>New Arrivals</Text>
            <TouchableOpacity
              onPress={() => router.push('/(tabs)/products')}
            >
              <Text style={styles.seeAll}>See All</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.productGrid}>
            {featuredProducts.map((p) => (
              <ProductCard
                key={p.id}
                product={p}
                showPrices={showPrices}
                onPress={() => router.push(`/product/${p.id}`)}
                onAddToCart={
                  allowAddToCart ? () => handleAddToCart(p) : undefined
                }
              />
            ))}
          </View>
        </View>
      </ScrollView>

      {toast ? (
        <Animated.View style={[styles.toast, { opacity: toastOpacity }]} pointerEvents="none">
          <Text style={styles.toastText}>{toast}</Text>
        </Animated.View>
      ) : null}
    </TabScreenFrame>
  );
}

/* ================= STYLES ================= */

function createTabStyles(c: AppColors) {
  return {
  container: { flex: 1, backgroundColor: c.background },

  skeletonText: {
    backgroundColor: c.skeleton,
  },

  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: c.surface,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },

  greeting: { fontSize: 14, color: c.textSecondary },
  businessName: { fontSize: 18, fontWeight: '700', color: c.text },

  verificationBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFF3E0',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
    gap: 4,
  },

  verificationText: {
    fontSize: 11,
    color: '#FFA726',
    fontWeight: '600',
  },

  statsContainer: {
    flexDirection: 'row',
    padding: 16,
    gap: 12,
  },

  statCard: {
    flex: 1,
    backgroundColor: c.surface,
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },

  statValue: { fontSize: 20, fontWeight: '700', marginTop: 8 },
  statLabel: { fontSize: 12, color: c.textSecondary },

  /* Scan card */
  scanCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#4C51C9',
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 16,
    borderRadius: 14,
    gap: 14,
    shadowColor: '#4C51C9',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 6,
  },
  scanIconWrap: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.2)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  scanTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#fff',
  },
  scanSubtitle: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.8)',
    marginTop: 2,
  },

  unverifiedBox: {
    flexDirection: 'row',
    backgroundColor: c.primaryMuted,
    marginHorizontal: 16,
    marginTop: 16,
    padding: 16,
    borderRadius: 12,
    gap: 12,
  },

  unverifiedTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#4C51C9',
  },

  unverifiedText: { fontSize: 13, color: c.textSecondary, marginTop: 4 },

  section: { padding: 16 },

  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16,
  },

  sectionTitle: { fontSize: 18, fontWeight: '700' },

  seeAll: {
    fontSize: 14,
    color: '#4C51C9',
    fontWeight: '600',
  },

  fetchErrorText: {
    marginHorizontal: 16,
    marginTop: 12,
    fontSize: 13,
    color: c.error,
    textAlign: 'center',
  },

  productGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },

  /* Reorder section */
  reorderCard: {
    width: 140,
    backgroundColor: c.surface,
    borderRadius: 12,
    padding: 12,
    marginRight: 12,
    alignItems: 'center',
  },

  reorderCardBody: {
    alignItems: 'center',
    width: '100%',
  },

  reorderIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: c.primaryMuted,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },

  reorderName: {
    fontSize: 13,
    fontWeight: '600',
    color: c.text,
    textAlign: 'center',
    minHeight: 34,
  },

  reorderPack: {
    fontSize: 11,
    color: '#4C51C9',
    marginTop: 2,
  },

  reorderPrice: {
    fontSize: 14,
    fontWeight: '700',
    color: '#4C51C9',
    marginTop: 4,
  },

  reorderBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#4C51C9',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    marginTop: 8,
  },

  reorderBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },

  miniCardOutOfStock: {
    fontSize: 12,
    fontWeight: '700',
    color: c.textMuted,
    marginTop: 8,
    textAlign: 'center',
  },

  restockCard: {
    width: 160,
    backgroundColor: c.surface,
    borderRadius: 12,
    padding: 12,
    marginRight: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: c.cardBorder,
  },

  restockCardBody: {
    alignItems: 'center',
    width: '100%',
  },

  restockImageWrap: {
    width: 72,
    height: 72,
    borderRadius: 8,
    overflow: 'hidden',
    marginBottom: 8,
    backgroundColor: c.primaryMuted,
  },

  restockImage: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },

  restockImagePlaceholder: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },

  restockBadge: {
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginBottom: 8,
    width: '100%',
  },

  restockBadgeStatus: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'center',
  },

  restockBadgeDays: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '500',
    textAlign: 'center',
    marginTop: 2,
    opacity: 0.95,
  },

  restockName: {
    fontSize: 13,
    fontWeight: '600',
    color: c.text,
    textAlign: 'center',
    minHeight: 34,
  },

  restockPrice: {
    fontSize: 14,
    fontWeight: '700',
    color: '#4C51C9',
    marginTop: 4,
  },

  brandDiscoveryCard: {
    width: 160,
    backgroundColor: c.surface,
    borderRadius: 12,
    padding: 12,
    marginRight: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: c.cardBorder,
  },

  brandDiscoveryCardBody: {
    alignItems: 'center',
    width: '100%',
  },

  brandDiscoveryImageWrap: {
    width: 72,
    height: 72,
    borderRadius: 8,
    overflow: 'hidden',
    marginBottom: 8,
    backgroundColor: c.primaryMuted,
    position: 'relative',
  },

  brandDiscoveryImage: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },

  brandDiscoveryImagePlaceholder: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },

  brandDiscoveryNewBadge: {
    position: 'absolute',
    top: 4,
    right: 4,
    backgroundColor: '#43A047',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },

  brandDiscoveryNewBadgeText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '800',
  },

  brandDiscoveryName: {
    fontSize: 13,
    fontWeight: '600',
    color: c.text,
    textAlign: 'center',
    minHeight: 34,
  },

  cohortCard: {
    width: 160,
    backgroundColor: c.surface,
    borderRadius: 12,
    padding: 12,
    marginRight: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: c.cardBorder,
  },

  cohortCardBody: {
    alignItems: 'center',
    width: '100%',
  },

  cohortImageWrap: {
    width: 72,
    height: 72,
    borderRadius: 8,
    overflow: 'hidden',
    marginBottom: 8,
    backgroundColor: c.primaryMuted,
    position: 'relative',
  },

  cohortImage: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },

  cohortImagePlaceholder: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },

  cohortName: {
    fontSize: 13,
    fontWeight: '600',
    color: c.text,
    textAlign: 'center',
    minHeight: 34,
  },

  cohortPrice: {
    fontSize: 14,
    fontWeight: '700',
    color: '#4C51C9',
    marginTop: 4,
  },

  brandDiscoveryCompany: {
    fontSize: 11,
    color: c.textSecondary,
    textAlign: 'center',
    marginTop: 2,
  },

  brandDiscoveryPrice: {
    fontSize: 14,
    fontWeight: '700',
    color: '#4C51C9',
    marginTop: 4,
  },

  toast: {
    position: 'absolute',
    bottom: 24,
    left: 24,
    right: 24,
    backgroundColor: '#333',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    elevation: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
  },
  toastText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
    textAlign: 'center',
  },
};
}
