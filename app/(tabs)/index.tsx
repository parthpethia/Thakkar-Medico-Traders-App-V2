import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  Alert,
  Animated,
} from 'react-native';
import { TabScreenFrame, useTabHeaderSafePadding } from '../../src/components/TabScreenFrame';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { useAuthStore } from '../../src/store/authStore';
import { useCartStore } from '../../src/store/cartStore';
import { useSettingsStore } from '../../src/store/settingsStore';
import { useHomeCache } from '../../src/store/homeStore';

import { CategoryCard } from '../../src/components/CategoryCard';
import { ProductCard } from '../../src/components/ProductCard';

import { Product, shouldShowPrices } from '../../src/types';
import { supabase } from '../../src/services/supabase';
import { tabScrollBottomPadding } from '../../src/theme/tabBarTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import type { AppColors } from '../../src/theme/colors';

/* ================= TYPES ================= */

interface Category {
  id: string;
  name: string;
}

/* ================= SCREEN ================= */

export default function Home() {
  const styles = useThemedStyles(createTabStyles);
  const headerSafePadding = useTabHeaderSafePadding();
  const router = useRouter();
  const { user, fetchUser } = useAuthStore();
  const { addToCart } = useCartStore();
  const { settings } = useSettingsStore();
  const { homeCache, cachedUserId, setHomeCache } = useHomeCache();

  const [categories, setCategories] = useState<Category[]>([]);
  const [featuredProducts, setFeaturedProducts] = useState<Product[]>([]);
  const [reorderProducts, setReorderProducts] = useState<Product[]>(() => {
    const fresh =
      useHomeCache.getState().homeCache.fetchedAt !== null &&
      useHomeCache.getState().cachedUserId === useAuthStore.getState().user?.id &&
      Date.now() - (useHomeCache.getState().homeCache.fetchedAt || 0) < 5 * 60 * 1000;
    return fresh ? useHomeCache.getState().homeCache.orderAgain : [];
  });
  const [highlyOrderedProducts, setHighlyOrderedProducts] = useState<
    (Product & { total_ordered: number })[]
  >(() => {
    const fresh =
      useHomeCache.getState().homeCache.fetchedAt !== null &&
      useHomeCache.getState().cachedUserId === useAuthStore.getState().user?.id &&
      Date.now() - (useHomeCache.getState().homeCache.fetchedAt || 0) < 5 * 60 * 1000;
    return fresh ? (useHomeCache.getState().homeCache.highlyOrdered as (Product & { total_ordered: number })[]) : [];
  });
  const [refreshing, setRefreshing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const fadeAnim = React.useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    let animation: Animated.CompositeAnimation | null = null;
    if (isLoading) {
      animation = Animated.loop(
        Animated.sequence([
          Animated.timing(fadeAnim, {
            toValue: 1.0,
            duration: 1000,
            useNativeDriver: true,
          }),
          Animated.timing(fadeAnim, {
            toValue: 0.3,
            duration: 1000,
            useNativeDriver: true,
          }),
        ])
      );
      animation.start();
    } else {
      fadeAnim.setValue(0.3);
    }
    return () => {
      if (animation) {
        animation.stop();
      }
    };
  }, [isLoading, fadeAnim]);

  const isVerified =
    user?.role === 'admin' || user?.approved === true;

  const showPrices = shouldShowPrices(user, settings);

  /* ================= FETCH ================= */

  const fetchData = async (forceRefetch = false) => {
    try {
      const isCacheFresh =
        homeCache.fetchedAt !== null &&
        cachedUserId === user?.id &&
        Date.now() - homeCache.fetchedAt < 5 * 60 * 1000;

      const shouldFetchOrders = user && (forceRefetch || !isCacheFresh);

      if (shouldFetchOrders) {
        setIsLoading(true);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const promises: any[] = [
        supabase
          .from('categories')
          .select('id, name')
          .order('name'),

        supabase
          .from('products')
          .select('*')
          .eq('is_active', true)
          .order('created_at', { ascending: false })
          .limit(6),
      ];

      if (shouldFetchOrders) {
        promises.push(
          supabase
            .from('orders')
            .select('items')
            .eq('user_id', user.id)
            .neq('status', 'cancelled')
            .order('created_at', { ascending: false })
            .limit(100),
        );
      }

      const results = await Promise.all(promises);

      setCategories(results[0].data || []);
      setFeaturedProducts(results[1].data || []);

      if (shouldFetchOrders) {
        if (results[2]?.data) {
          const reorderProductIds: string[] = [];
          for (const order of results[2].data.slice(0, 10)) {
            if (Array.isArray(order.items)) {
              for (const item of order.items) {
                if (item.product_id && !reorderProductIds.includes(item.product_id)) {
                  reorderProductIds.push(item.product_id);
                }
              }
            }
          }
          const slicedReorderIds = reorderProductIds.slice(0, 10);

          const qtyMap: Record<string, number> = {};
          for (const order of results[2].data) {
            if (Array.isArray(order.items)) {
              for (const item of order.items) {
                if (item.product_id) {
                  qtyMap[item.product_id] =
                    (qtyMap[item.product_id] || 0) + (item.quantity || 1);
                }
              }
            }
          }

          const sorted = Object.entries(qtyMap)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 10);
          const highlyOrderedProductIds = sorted.map(([id]) => id);

          const combinedIds = Array.from(new Set([...slicedReorderIds, ...highlyOrderedProductIds]));

          if (combinedIds.length > 0) {
            const { data: prods } = await supabase
              .from('products')
              .select('*')
              .in('id', combinedIds)
              .eq('is_active', true);

            const prodsList = prods || [];

            const reorderProds = slicedReorderIds
              .map(id => prodsList.find(p => p.id === id))
              .filter((p): p is Product => !!p);
            
            const highlyOrderedProds = highlyOrderedProductIds
              .map(id => {
                const product = prodsList.find(p => p.id === id);
                if (product) {
                  return { ...product, total_ordered: qtyMap[id] || 0 };
                }
                return null;
              })
              .filter((p): p is (Product & { total_ordered: number }) => !!p)
              .sort((a, b) => b.total_ordered - a.total_ordered);

            setReorderProducts(reorderProds);
            setHighlyOrderedProducts(highlyOrderedProds);
            setHomeCache(reorderProds, highlyOrderedProds, user.id);
          } else {
            setReorderProducts([]);
            setHighlyOrderedProducts([]);
            setHomeCache([], [], user.id);
          }
        } else {
          setReorderProducts([]);
          setHighlyOrderedProducts([]);
          setHomeCache([], [], user.id);
        }
      }
    } catch (error) {
      console.error('Error fetching home data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    const fresh =
      homeCache.fetchedAt !== null &&
      cachedUserId === user?.id &&
      Date.now() - homeCache.fetchedAt < 5 * 60 * 1000;

    if (fresh) {
      setReorderProducts(homeCache.orderAgain);
      setHighlyOrderedProducts(homeCache.highlyOrdered as (Product & { total_ordered: number })[]);
      fetchData(false);
    } else {
      setReorderProducts([]);
      setHighlyOrderedProducts([]);
      fetchData(true);
    }
  }, [user]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    const promises: Promise<any>[] = [fetchData(true)];
    if (user) {
      promises.push(fetchUser({ silent: true }));
    }
    await Promise.all(promises);
    setRefreshing(false);
  }, [user, fetchUser]);

  /* ================= ACTIONS ================= */

  const handleAddToCart = async (product: Product) => {
    if (!user) {
      Alert.alert('Login Required', 'Please login to add items to cart');
      return;
    }

    await addToCart(product.id, 1);

    Alert.alert('Added to Cart', `${product.name} added to your cart`);
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

        {user &&
          user.role !== 'admin' &&
          !user.approved && (
            <View style={styles.verificationBadge}>
              <Ionicons name="time" size={14} color="#FFA726" />
              <Text style={styles.verificationText}>
                Pending Verification
              </Text>
            </View>
        )}

      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={tabScrollBottomPadding()}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      >
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
                ₹
                {(
                  (user?.credit_limit || 0) -
                  (user?.credit_used || 0)
                ).toFixed(0)}
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
                You can browse products but need admin approval to place orders.
              </Text>
            </View>
          </View>
        )}

        {/* Order Again */}
        {user && (reorderProducts.length > 0 || isLoading) && (
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
              {isLoading
                ? [1, 2, 3].map((idx) => (
                    <Animated.View
                      key={idx}
                      style={[styles.reorderCard, { opacity: fadeAnim }]}
                    >
                      <View style={[styles.reorderIcon, { backgroundColor: '#e0e0e0' }]} />
                      <View style={{ minHeight: 34, justifyContent: 'center', alignItems: 'center', marginBottom: 4 }}>
                        <View style={[styles.skeletonText, { width: 80, height: 10, borderRadius: 4, marginBottom: 4 }]} />
                        <View style={[styles.skeletonText, { width: 60, height: 10, borderRadius: 4 }]} />
                      </View>
                      <View style={[styles.skeletonText, { width: 50, height: 11, marginTop: 2, borderRadius: 4 }]} />
                      {showPrices && (
                        <View style={[styles.skeletonText, { width: 60, height: 14, marginTop: 4, borderRadius: 4 }]} />
                      )}
                      <View style={[styles.reorderBtn, { backgroundColor: '#e0e0e0' }]}>
                        <View style={{ width: 16, height: 16 }} />
                        <View style={{ width: 24, height: 12 }} />
                      </View>
                    </Animated.View>
                  ))
                : reorderProducts.map((p) => (
                    <TouchableOpacity
                      key={p.id}
                      style={styles.reorderCard}
                      activeOpacity={0.7}
                      onPress={() => router.push(`/product/${p.id}`)}
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
                      <TouchableOpacity
                        style={styles.reorderBtn}
                        onPress={() => handleAddToCart(p)}
                      >
                        <Ionicons name="add" size={16} color="#fff" />
                        <Text style={styles.reorderBtnText}>Add</Text>
                      </TouchableOpacity>
                    </TouchableOpacity>
                  ))}
            </ScrollView>
          </View>
        )}

        {/* Highly Ordered */}
        {user && (highlyOrderedProducts.length > 0 || isLoading) && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Highly Ordered</Text>
              <TouchableOpacity
                onPress={() => router.push('/(tabs)/orders')}
              >
                <Text style={styles.seeAll}>View Orders</Text>
              </TouchableOpacity>
            </View>

            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              {isLoading
                ? [1, 2, 3].map((idx) => (
                    <Animated.View
                      key={idx}
                      style={[styles.highlyOrderedCard, { opacity: fadeAnim }]}
                    >
                      <View style={[styles.highlyOrderedRank, { backgroundColor: '#e0e0e0' }]} />
                      <View style={[styles.highlyOrderedIcon, { backgroundColor: '#e0e0e0' }]} />
                      <View style={{ minHeight: 34, justifyContent: 'center', alignItems: 'center', marginBottom: 4 }}>
                        <View style={[styles.skeletonText, { width: 85, height: 10, borderRadius: 4, marginBottom: 4 }]} />
                        <View style={[styles.skeletonText, { width: 65, height: 10, borderRadius: 4 }]} />
                      </View>
                      <View style={[styles.skeletonText, { width: 50, height: 11, marginTop: 2, borderRadius: 4 }]} />
                      <View style={[styles.skeletonText, { width: 75, height: 11, marginTop: 4, borderRadius: 4 }]} />
                      {showPrices && (
                        <View style={[styles.skeletonText, { width: 60, height: 14, marginTop: 4, borderRadius: 4 }]} />
                      )}
                      <View style={[styles.highlyOrderedBtn, { backgroundColor: '#e0e0e0' }]}>
                        <View style={{ width: 16, height: 16 }} />
                        <View style={{ width: 24, height: 12 }} />
                      </View>
                    </Animated.View>
                  ))
                : highlyOrderedProducts.map((p, idx) => (
                    <TouchableOpacity
                      key={p.id}
                      style={styles.highlyOrderedCard}
                      activeOpacity={0.7}
                      onPress={() => router.push(`/product/${p.id}`)}
                    >
                      <View style={styles.highlyOrderedRank}>
                        <Text style={styles.highlyOrderedRankText}>
                          #{idx + 1}
                        </Text>
                      </View>
                      <View style={styles.highlyOrderedIcon}>
                        <Ionicons name="trending-up" size={24} color="#4C51C9" />
                      </View>
                      <Text style={styles.highlyOrderedName} numberOfLines={2}>
                        {p.name}
                      </Text>
                      {p.pack_size && (
                        <Text style={styles.highlyOrderedPack}>
                          {p.pack_size}
                        </Text>
                      )}
                      <Text style={styles.highlyOrderedQty}>
                        Ordered {p.total_ordered}x
                      </Text>
                      {showPrices && (
                        <Text style={styles.highlyOrderedPrice}>
                          ₹{p.selling_price}
                        </Text>
                      )}
                      <TouchableOpacity
                        style={styles.highlyOrderedBtn}
                        onPress={() => handleAddToCart(p)}
                      >
                        <Ionicons name="add" size={16} color="#fff" />
                        <Text style={styles.highlyOrderedBtnText}>Add</Text>
                      </TouchableOpacity>
                    </TouchableOpacity>
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
                  router.push(`/(tabs)/products?category=${c.id}`)
                }
              />
            ))}
          </ScrollView>
        </View>

        {/* Featured Products */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Featured Products</Text>
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
                  showPrices ? () => handleAddToCart(p) : undefined
                }
              />
            ))}
          </View>
        </View>
      </ScrollView>
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

  /* Highly Ordered section */
  highlyOrderedCard: {
    width: 150,
    backgroundColor: c.surface,
    borderRadius: 12,
    padding: 12,
    marginRight: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: c.cardBorder,
  },

  highlyOrderedRank: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: '#4C51C9',
    borderRadius: 10,
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },

  highlyOrderedRankText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },

  highlyOrderedIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: c.primaryMuted,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },

  highlyOrderedName: {
    fontSize: 13,
    fontWeight: '600',
    color: c.text,
    textAlign: 'center',
    minHeight: 34,
  },

  highlyOrderedPack: {
    fontSize: 11,
    color: '#4C51C9',
    marginTop: 2,
  },

  highlyOrderedQty: {
    fontSize: 11,
    color: c.textMuted,
    marginTop: 4,
    fontWeight: '600',
  },

  highlyOrderedPrice: {
    fontSize: 14,
    fontWeight: '700',
    color: '#4C51C9',
    marginTop: 4,
  },

  highlyOrderedBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#4C51C9',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    marginTop: 8,
  },

  highlyOrderedBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
};
}
