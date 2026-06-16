import { create } from 'zustand';
import { Product } from '../types';

export interface HomeCache {
  orderAgain: Product[];
  highlyOrdered: Product[];
  fetchedAt: number | null;
}

interface HomeCacheState {
  homeCache: HomeCache;
  cachedUserId: string | null;
  setHomeCache: (orderAgain: Product[], highlyOrdered: Product[], userId: string | null) => void;
  clearHomeCache: () => void;
}

export const useHomeCache = create<HomeCacheState>((set) => ({
  homeCache: {
    orderAgain: [],
    highlyOrdered: [],
    fetchedAt: null,
  },
  cachedUserId: null,
  setHomeCache: (orderAgain, highlyOrdered, userId) =>
    set({
      homeCache: {
        orderAgain,
        highlyOrdered,
        fetchedAt: Date.now(),
      },
      cachedUserId: userId,
    }),
  clearHomeCache: () =>
    set({
      homeCache: {
        orderAgain: [],
        highlyOrdered: [],
        fetchedAt: null,
      },
      cachedUserId: null,
    }),
}));
