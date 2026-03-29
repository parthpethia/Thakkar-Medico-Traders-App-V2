import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
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

      // Debug: first fetch ALL profiles to see what the delivery user can access
      const debugRes = await supabase
        .from('profiles')
        .select('id, name, phone, role, approved');

      console.log('DEBUG all profiles visible to current user:', JSON.stringify(debugRes.data?.length), debugRes.error?.message);
      if (debugRes.data) {
        debugRes.data.forEach((p: any) => {
          console.log(`  -> ${p.name || 'no-name'} | role=${p.role} | approved=${p.approved} | id=${p.id}`);
        });
      }

      // Fetch all profiles (no role filter) so we can see everything the user has access to
      const retailerRes = await supabase
        .from('profiles')
        .select('id, name, phone, business_name, address, city, state, pincode, role, approved')
        .order('name', { ascending: true });

      if (retailerRes.error) {
        console.log('DEBUG retailerRes error:', retailerRes.error);
        throw retailerRes.error;
      }

      console.log('DEBUG retailerRes count:', retailerRes.data?.length);

      setRetailers(retailerRes.data || []);

      if (retailerRes.data?.length) {
        setSelectedRetailerId(retailerRes.data[0].id);
      }
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
          <ActivityIndicator size="large" color="#4C51C9" />
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
            <Ionicons name="search" size={16} color="#888" />
            <TextInput
              style={styles.searchInput}
              placeholder="Search retailer by name, business or phone"
              placeholderTextColor="#999"
              value={search}
              onChangeText={setSearch}
            />
          </View>
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
                  <Text style={{ fontSize: 11, color: item.approved ? '#43A047' : '#e53935', marginTop: 2 }}>
                    {item.role || 'no role'} · {item.approved ? 'Approved' : 'Not Approved'}
                  </Text>
                </View>
                <Ionicons
                  name={active ? 'radio-button-on' : 'radio-button-off'}
                  size={20}
                  color={active ? '#4C51C9' : '#aaa'}
                />
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Text style={styles.emptyText}>No retailers found.</Text>
              <Text style={{ fontSize: 12, color: '#888', marginTop: 8, textAlign: 'center' }}>
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { flex: 1 },
  section: {
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
    padding: 14,
  },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: '#333', marginBottom: 10 },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#f5f5f5',
    borderRadius: 10,
    paddingHorizontal: 10,
    height: 42,
  },
  searchInput: {
    flex: 1,
    color: '#333',
    fontSize: 14,
  },
  retailerRow: {
    marginTop: 12,
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#ddd',
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  retailerRowActive: {
    borderColor: '#4C51C9',
    backgroundColor: '#EEF0FF',
  },
  retailerTitle: { fontSize: 14, fontWeight: '700', color: '#333' },
  retailerSubtitle: { marginTop: 2, fontSize: 12, color: '#777' },
  emptyWrap: { marginTop: 40, alignItems: 'center' },
  emptyText: { color: '#888' },
  footer: {
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#eee',
    padding: 16,
  },
  selectedText: {
    marginBottom: 10,
    color: '#4C51C9',
    fontWeight: '600',
  },
  submitBtn: {
    height: 52,
    borderRadius: 10,
    backgroundColor: '#4C51C9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
