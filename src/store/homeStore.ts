import { create } from 'zustand';
import { Product } from '../types';

/**
 * OPT-8: Increased from 5 → 10 min. Personalized sections (order-again,
 * restock, brand-discovery) don't change within minutes.
 */
export const PERSONALIZED_CACHE_TTL_MS = 10 * 60 * 1000;
/**
 * OPT-8: Increased from 2 → 15 min. Categories and featured products
 * are near-static — no need to refetch every 2 minutes.
 */
export const CATALOGUE_CACHE_TTL_MS = 15 * 60 * 1000;
export const RESTOCK_CACHE_TTL_MS = PERSONALIZED_CACHE_TTL_MS;
export const BRAND_DISCOVERY_CACHE_TTL_MS = PERSONALIZED_CACHE_TTL_MS;
export const COHORT_CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes
export const POPULAR_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

export const catalogueCacheKey = (userId: string | undefined) =>
  userId ?? '_anonymous';

export interface RestockRecommendation {
  product_id: string;
  name: string;
  company: string | null;
  image: string | null;
  selling_price: number;
  stock_quantity: number;
  avg_interval_days: number;
  last_ordered_at: string;
  days_since_last_order: number;
  restock_urgency: number;
}

export interface BrandDiscoveryRecommendation {
  product_id: string;
  name: string;
  image: string | null;
  selling_price: number;
  stock_quantity: number;
  created_at: string;
  company_id: string;
  company_name: string;
  is_new_arrival: boolean;
}

export interface BrandDiscoveryCacheEntry {
  items: BrandDiscoveryRecommendation[];
  sectionTitle: string;
}

export interface CohortRecommendation {
  product_id: string;
  name: string;
  image: string | null;
  selling_price: number;
  stock_quantity: number;
  cohort_score: number;
}

export interface PopularProduct {
  product_id: string;
  name: string;
  company: string | null;
  category: string | null;
  pack_size: string | null;
  image: string | null;
  mrp: number;
  selling_price: number;
  gst_percent: number;
  stock_quantity: number;
  is_active: boolean;
  created_at: string;
  order_count: number;
  total_qty: number;
}

export interface HomeCache {
  orderAgain: Product[];
  fetchedAt: number | null;
}

export interface CatalogueCacheEntry {
  categories: { id: string; name: string }[];
  featuredProducts: Product[];
}

interface HomeCacheState {
  homeCache: HomeCache;
  cachedUserId: string | null;
  catalogueCachedAt: Record<string, number>;
  catalogueData: Record<string, CatalogueCacheEntry>;
  restockCachedAt: Record<string, number>;
  restockData: Record<string, RestockRecommendation[]>;
  brandDiscoveryCachedAt: Record<string, number>;
  brandDiscoveryData: Record<string, BrandDiscoveryCacheEntry>;
  cohortCachedAt: Record<string, number>;
  cohortData: Record<string, CohortRecommendation[]>;
  popularCachedAt: number | null;
  popularData: PopularProduct[];
  setHomeCache: (orderAgain: Product[], userId: string | null) => void;
  setCatalogueCache: (
    userId: string,
    categories: CatalogueCacheEntry['categories'],
    featuredProducts: Product[],
  ) => void;
  setRestockCache: (userId: string, items: RestockRecommendation[]) => void;
  setBrandDiscoveryCache: (
    userId: string,
    entry: BrandDiscoveryCacheEntry,
  ) => void;
  setCohortCache: (userId: string, items: CohortRecommendation[]) => void;
  setPopularCache: (items: PopularProduct[]) => void;
  clearHomeCache: () => void;
}

export const useHomeCache = create<HomeCacheState>((set) => ({
  homeCache: {
    orderAgain: [],
    fetchedAt: null,
  },
  cachedUserId: null,
  catalogueCachedAt: {},
  catalogueData: {},
  restockCachedAt: {},
  restockData: {},
  brandDiscoveryCachedAt: {},
  brandDiscoveryData: {},
  cohortCachedAt: {},
  cohortData: {},
  popularCachedAt: null,
  popularData: [],
  setHomeCache: (orderAgain, userId) =>
    set({
      homeCache: {
        orderAgain,
        fetchedAt: Date.now(),
      },
      cachedUserId: userId,
    }),
  setCatalogueCache: (userId, categories, featuredProducts) =>
    set((state) => ({
      catalogueCachedAt: {
        ...state.catalogueCachedAt,
        [userId]: Date.now(),
      },
      catalogueData: {
        ...state.catalogueData,
        [userId]: { categories, featuredProducts },
      },
    })),
  setRestockCache: (userId, items) =>
    set((state) => ({
      restockCachedAt: {
        ...state.restockCachedAt,
        [userId]: Date.now(),
      },
      restockData: {
        ...state.restockData,
        [userId]: items,
      },
    })),
  setBrandDiscoveryCache: (userId, entry) =>
    set((state) => ({
      brandDiscoveryCachedAt: {
        ...state.brandDiscoveryCachedAt,
        [userId]: Date.now(),
      },
      brandDiscoveryData: {
        ...state.brandDiscoveryData,
        [userId]: entry,
      },
    })),
  setCohortCache: (userId, items) =>
    set((state) => ({
      cohortCachedAt: {
        ...state.cohortCachedAt,
        [userId]: Date.now(),
      },
      cohortData: {
        ...state.cohortData,
        [userId]: items,
      },
    })),
  setPopularCache: (items) =>
    set({
      popularCachedAt: Date.now(),
      popularData: items,
    }),
  clearHomeCache: () =>
    set({
      homeCache: {
        orderAgain: [],
        fetchedAt: null,
      },
      cachedUserId: null,
      catalogueCachedAt: {},
      catalogueData: {},
      restockCachedAt: {},
      restockData: {},
      brandDiscoveryCachedAt: {},
      brandDiscoveryData: {},
      cohortCachedAt: {},
      cohortData: {},
      popularCachedAt: null,
      popularData: [],
    }),
}));

export function invalidateHomeCache(userId: string) {
  const state = useHomeCache.getState();
  const nextCatalogueAt = { ...state.catalogueCachedAt };
  const nextCatalogueData = { ...state.catalogueData };
  delete nextCatalogueAt[userId];
  delete nextCatalogueData[userId];

  const nextRestockAt = { ...state.restockCachedAt };
  const nextRestockData = { ...state.restockData };
  delete nextRestockAt[userId];
  delete nextRestockData[userId];

  const nextBrandDiscoveryAt = { ...state.brandDiscoveryCachedAt };
  const nextBrandDiscoveryData = { ...state.brandDiscoveryData };
  delete nextBrandDiscoveryAt[userId];
  delete nextBrandDiscoveryData[userId];

  const nextCohortAt = { ...state.cohortCachedAt };
  const nextCohortData = { ...state.cohortData };
  delete nextCohortAt[userId];
  delete nextCohortData[userId];

  const patch: Partial<HomeCacheState> = {
    catalogueCachedAt: nextCatalogueAt,
    catalogueData: nextCatalogueData,
    restockCachedAt: nextRestockAt,
    restockData: nextRestockData,
    brandDiscoveryCachedAt: nextBrandDiscoveryAt,
    brandDiscoveryData: nextBrandDiscoveryData,
    cohortCachedAt: nextCohortAt,
    cohortData: nextCohortData,
    popularCachedAt: null,
    popularData: [],
  };

  if (state.cachedUserId === userId) {
    patch.homeCache = {
      ...state.homeCache,
      fetchedAt: null,
    };
  }

  useHomeCache.setState(patch);
}

export function isPersonalizedCacheFresh(
  userId: string | undefined,
  forceRefetch: boolean,
): boolean {
  if (forceRefetch || !userId) return false;
  const { homeCache, cachedUserId } = useHomeCache.getState();
  return (
    homeCache.fetchedAt !== null &&
    cachedUserId === userId &&
    Date.now() - homeCache.fetchedAt < PERSONALIZED_CACHE_TTL_MS
  );
}

export function isRestockCacheFresh(
  userId: string | undefined,
  forceRefetch: boolean,
): boolean {
  if (forceRefetch || !userId) return false;
  const { restockCachedAt, restockData } = useHomeCache.getState();
  const fetchedAt = restockCachedAt[userId];
  return (
    fetchedAt != null &&
    restockData[userId] != null &&
    Date.now() - fetchedAt < RESTOCK_CACHE_TTL_MS
  );
}

export function isBrandDiscoveryCacheFresh(
  userId: string | undefined,
  forceRefetch: boolean,
): boolean {
  if (forceRefetch || !userId) return false;
  const { brandDiscoveryCachedAt, brandDiscoveryData } =
    useHomeCache.getState();
  const fetchedAt = brandDiscoveryCachedAt[userId];
  return (
    fetchedAt != null &&
    brandDiscoveryData[userId] != null &&
    Date.now() - fetchedAt < BRAND_DISCOVERY_CACHE_TTL_MS
  );
}

export function isCohortCacheFresh(
  userId: string | undefined,
  forceRefetch: boolean,
): boolean {
  if (forceRefetch || !userId) return false;
  const { cohortCachedAt, cohortData } = useHomeCache.getState();
  const fetchedAt = cohortCachedAt[userId];
  return (
    fetchedAt != null &&
    cohortData[userId] != null &&
    Date.now() - fetchedAt < COHORT_CACHE_TTL_MS
  );
}

export function brandDiscoverySectionTitle(
  summary: { company_name: string; order_count: number }[],
): string {
  if (summary.length === 0) {
    return 'New from brands you buy';
  }
  const total = summary.reduce((sum, row) => sum + row.order_count, 0);
  if (total <= 0) {
    return 'New from brands you buy';
  }
  const top = summary[0];
  if (top.order_count / total > 0.5) {
    return `New from ${top.company_name}`;
  }
  return 'New from brands you buy';
}

export function isCatalogueCacheFresh(
  userId: string | undefined,
  forceRefetch: boolean,
): boolean {
  if (forceRefetch) return false;
  const key = catalogueCacheKey(userId);
  const { catalogueCachedAt, catalogueData } = useHomeCache.getState();
  const fetchedAt = catalogueCachedAt[key];
  return (
    fetchedAt != null &&
    catalogueData[key] != null &&
    Date.now() - fetchedAt < CATALOGUE_CACHE_TTL_MS
  );
}

export function isPopularCacheFresh(forceRefetch: boolean): boolean {
  if (forceRefetch) return false;
  const { popularCachedAt, popularData } = useHomeCache.getState();
  return (
    popularCachedAt != null &&
    popularData.length > 0 &&
    Date.now() - popularCachedAt < POPULAR_CACHE_TTL_MS
  );
}
