import { useQuery } from '@tanstack/react-query';
import { supabase } from '../services/supabase';
import { Product } from '../types';
import {
  RestockRecommendation,
  BrandDiscoveryRecommendation,
  CohortRecommendation,
  PopularProduct,
} from '../store/homeStore';
import { executeSupabaseQuery } from '../utils/supabaseQuery';

export interface HomeDashboardData {
  categories: { id: string; name: string }[];
  featured: Product[];
  popular: PopularProduct[];
  restock: RestockRecommendation[];
  brand_discovery: BrandDiscoveryRecommendation[];
  company_summary: { company_name: string; order_count: number }[];
  cohort: CohortRecommendation[];
}

export function useHomeDashboardQuery(userId: string | undefined) {
  return useQuery<HomeDashboardData>({
    queryKey: ['home-dashboard', userId ?? 'anonymous'],
    queryFn: async () => {
      const { data, error } = await executeSupabaseQuery(() =>
        supabase.rpc('get_home_dashboard_data', {
          p_user_id: userId || null,
        })
      );

      if (error) {
        throw error;
      }

      const res = (data as any) || {};
      return {
        categories: Array.isArray(res.categories) ? res.categories : [],
        featured: Array.isArray(res.featured) ? res.featured : [],
        popular: Array.isArray(res.popular) ? res.popular : [],
        restock: Array.isArray(res.restock) ? res.restock : [],
        brand_discovery: Array.isArray(res.brand_discovery) ? res.brand_discovery : [],
        company_summary: Array.isArray(res.company_summary) ? res.company_summary : [],
        cohort: Array.isArray(res.cohort) ? res.cohort : [],
      };
    },
    staleTime: 10 * 60 * 1000, // 10 minutes fresh
  });
}
