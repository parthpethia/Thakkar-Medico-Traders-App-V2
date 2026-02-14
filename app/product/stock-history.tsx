import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, Stack } from 'expo-router';
import { supabase } from '../../src/services/supabase';

type StockHistoryItem = {
  id: string;
  product_id: string;
  change: number;
  reason: string | null;
  created_at: string;
};

export default function StockHistory() {
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
    <SafeAreaView style={styles.container}>
      <Stack.Screen options={{ title: 'Stock History' }} />

      {loading ? (
        <ActivityIndicator size="large" />
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  card: {
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 12,
    marginBottom: 12,
  },
  change: {
    fontSize: 16,
    fontWeight: '700',
    color: '#4C51C9',
  },
  reason: {
    marginTop: 4,
    color: '#555',
  },
  date: {
    marginTop: 6,
    fontSize: 12,
    color: '#888',
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyText: {
    color: '#888',
    fontSize: 16,
  },
});
