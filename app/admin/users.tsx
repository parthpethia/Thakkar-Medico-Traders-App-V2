import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  Alert,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { supabase } from '../../src/services/supabase';
import { User } from '../../src/types';

export default function AdminUsers() {
  const [users, setUsers] = useState<User[]>([]);

  const fetchUsers = async () => {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: false });

    setUsers(data ?? []);
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const toggleApproval = async (id: string, currentlyApproved: boolean) => {
    const { error } = await supabase
      .from('profiles')
      .update({ approved: !currentlyApproved })
      .eq('id', id);

    if (error) {
      Alert.alert('Error', error.message);
      return;
    }

    fetchUsers();
  };

  const setCredit = async (id: string) => {
    Alert.prompt('Set Credit Limit', '', async (value) => {
      const amount = Number(value);
      if (isNaN(amount)) return;

      await supabase
        .from('profiles')
        .update({ credit_limit: amount })
        .eq('id', id);

      fetchUsers();
    });
  };

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        data={users}
        keyExtractor={(i) => i.id}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <View>
                <Text style={styles.name}>{item.name}</Text>
                <Text style={styles.phone}>{item.phone}</Text>
              </View>
              <View style={[styles.badge, item.approved ? styles.badgeVerified : styles.badgeUnverified]}>
                <Text style={[styles.badgeText, item.approved ? styles.badgeTextVerified : styles.badgeTextUnverified]}>
                  {item.approved ? 'Verified' : 'Unverified'}
                </Text>
              </View>
            </View>

            <View style={styles.actions}>
              <TouchableOpacity
                style={[styles.actionBtn, item.approved ? styles.actionBtnDanger : styles.actionBtnSuccess]}
                onPress={() => toggleApproval(item.id, item.approved)}
              >
                <Text style={[styles.actionBtnText, item.approved ? styles.actionBtnTextDanger : styles.actionBtnTextSuccess]}>
                  {item.approved ? 'Unverify' : 'Verify'}
                </Text>
              </TouchableOpacity>

              {item.approved && (
                <TouchableOpacity
                  style={[styles.actionBtn, styles.actionBtnCredit]}
                  onPress={() => setCredit(item.id)}
                >
                  <Text style={[styles.actionBtnText, styles.actionBtnTextCredit]}>Set Credit</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: '#f5f5f5' },
  card: {
    backgroundColor: '#fff',
    padding: 16,
    marginBottom: 12,
    borderRadius: 12,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  name: { fontWeight: '700', fontSize: 16, color: '#333' },
  phone: { fontSize: 13, color: '#888', marginTop: 2 },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
  },
  badgeVerified: { backgroundColor: '#E8F5E9' },
  badgeUnverified: { backgroundColor: '#FFF3E0' },
  badgeText: { fontSize: 12, fontWeight: '600' },
  badgeTextVerified: { color: '#2E7D32' },
  badgeTextUnverified: { color: '#E65100' },
  actions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 14,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
    borderWidth: 1.5,
  },
  actionBtnSuccess: {
    backgroundColor: '#E8F5E9',
    borderColor: '#43A047',
  },
  actionBtnDanger: {
    backgroundColor: '#FFEBEE',
    borderColor: '#e53935',
  },
  actionBtnCredit: {
    backgroundColor: '#ECEDFB',
    borderColor: '#4C51C9',
  },
  actionBtnText: { fontWeight: '600', fontSize: 14 },
  actionBtnTextSuccess: { color: '#2E7D32' },
  actionBtnTextDanger: { color: '#C62828' },
  actionBtnTextCredit: { color: '#1565C0' },
});
