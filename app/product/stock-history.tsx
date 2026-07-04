import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, Stack } from 'expo-router';
import { supabase } from '../../src/services/supabase';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import type { AppColors } from '../../src/theme/colors';

type StockHistoryItem = {
  id: string;
  product_id: string;
  change: number;
  reason: string | null;
  created_at: string;
};

export default function StockHistory() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [history, setHistory] = useState<StockHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    fetchHistory();
  }, [id]);

  const fetchHistory = async () => {
    try {
      setLoading(true);

      /**
       * EXPECTED TABLE (OPTIONAL):
       * stock_history
       * - id uuid
       * - product_id uuid
       * - change int
       * - reason text
       * - created_at timestamptz
       */

      const { data, error } = await supabase
        .from('stock_history')
        .select('*')
        .eq('product_id', id)
        .order('created_at', { ascending: false });

      if (error) {
        console.warn('Stock history table not found or empty');
        setHistory([]);
        return;
      }

      setHistory(data || []);
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <Stack.Screen options={{ title: 'Stock History' }} />

      {loading ? (
        <ActivityIndicator size="large" color={colors.primary} />
      ) : history.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No stock history available</Text>
        </View>
      ) : (
        <FlatList
          data={history}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: 16 }}
          renderItem={({ item }) => (
            <View style={styles.card}>
              <Text style={styles.change}>
                {item.change > 0 ? '+' : ''}
                {item.change} units
              </Text>
              {item.reason && (
                <Text style={styles.reason}>{item.reason}</Text>
              )}
              <Text style={styles.date}>
                {new Date(item.created_at).toLocaleString()}
              </Text>
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}

function createStyles(c: AppColors, isDark: boolean) {
  return {
  container: {
    flex: 1,
    backgroundColor: c.background,
  },
  card: {
    backgroundColor: c.surface,
    padding: 16,
    borderRadius: 12,
    marginBottom: 12,
  },
  change: {
    fontSize: 16,
    fontWeight: '700',
    color: c.primary,
  },
  reason: {
    marginTop: 4,
    color: c.textSecondary,
  },
  date: {
    marginTop: 6,
    fontSize: 12,
    color: c.textMuted,
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyText: {
    color: c.textMuted,
    fontSize: 16,
  },
  } as const;
}
