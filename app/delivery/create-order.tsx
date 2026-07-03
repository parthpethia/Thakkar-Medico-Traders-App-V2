import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../../src/services/supabase';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import type { AppColors } from '../../src/theme/colors';

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
};

export default function DeliveryCreateOrder() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [retailers, setRetailers] = useState<Retailer[]>([]);
  const [search, setSearch] = useState('');
  const [selectedRetailerId, setSelectedRetailerId] = useState<string | null>(null);

  const selectedRetailer = useMemo(() => {
    return retailers.find((r) => r.id === selectedRetailerId) || null;
  }, [retailers, selectedRetailerId]);

  const filteredRetailers = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return retailers;

    return retailers.filter((retailer) => {
      const target = `${retailer.business_name || ''} ${retailer.name || ''} ${retailer.phone || ''}`.toLowerCase();
      return target.includes(query);
    });
  }, [retailers, search]);

  const fetchData = async () => {
    try {
      setLoading(true);

      const retailerRes = await supabase
        .from('profiles')
        .select('id, name, phone, business_name, address, city, state, pincode, role, approved')
        .in('role', ['retailer', 'verified_retailer', 'unverified_retailer'])
        .order('name', { ascending: true });

      if (retailerRes.error) throw retailerRes.error;

      setRetailers(retailerRes.data || []);
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  // Re-fetch every time the screen gains focus (e.g. after creating a retailer)
  useFocusEffect(
    useCallback(() => {
      fetchData();
    }, [])
  );

  const goToAddItems = async () => {
    if (!selectedRetailer) {
      Alert.alert('Select Retailer', 'Please select a retailer first.');
      return;
    }

    router.push(`/delivery/create-order-items?retailerId=${selectedRetailer.id}`);
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <Stack.Screen options={{ title: 'Select Retailer' }} />

      <View style={styles.content}>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>All Retailers</Text>
          <View style={styles.searchWrap}>
            <Ionicons name="search" size={16} color={colors.textMuted} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search retailer by name, business or phone"
              placeholderTextColor={colors.textMuted}
              value={search}
              onChangeText={setSearch}
            />
          </View>
          <TouchableOpacity
            style={styles.newRetailerBtn}
            onPress={() => router.push('/delivery/create-retailer')}
          >
            <Ionicons name="add-circle-outline" size={18} color={colors.primary} />
            <Text style={styles.newRetailerText}>Create New Retailer</Text>
          </TouchableOpacity>
        </View>

        <FlatList
          data={filteredRetailers}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 120 }}
          renderItem={({ item }) => {
            const active = selectedRetailerId === item.id;
            return (
              <TouchableOpacity
                style={[styles.retailerRow, active && styles.retailerRowActive]}
                onPress={() => setSelectedRetailerId(item.id)}
                activeOpacity={0.8}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.retailerTitle}>{item.business_name || item.name || 'Retailer'}</Text>
                  <Text style={styles.retailerSubtitle}>{item.name || '—'} · {item.phone || '—'}</Text>
                  {item.city ? (
                    <Text style={{ fontSize: 11, color: colors.textSecondary, marginTop: 2 }}>
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
              <Text style={styles.emptyText}>No retailers found.</Text>
              <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: 8, textAlign: 'center' }}>
                This likely means RLS policies on the profiles table are blocking read access for delivery users. Check the Metro console logs for debug output.
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
    </SafeAreaView>
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
  sectionTitle: { fontSize: 15, fontWeight: '700', color: c.text, marginBottom: 10 },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
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
  retailerTitle: { fontSize: 14, fontWeight: '700', color: c.text },
  retailerSubtitle: { marginTop: 2, fontSize: 12, color: c.textSecondary },
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
};
}
