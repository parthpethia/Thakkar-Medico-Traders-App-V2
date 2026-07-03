import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { supabase } from '../../src/services/supabase';
import { User } from '../../src/types';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import type { AppColors } from '../../src/theme/colors';

export default function AdminUsers() {
  const styles = useThemedStyles(createStyles);
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
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
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

function createStyles(c: AppColors, _isDark: boolean) {
  return {
    container: { flex: 1, padding: 16, backgroundColor: c.background },
    card: {
      backgroundColor: c.surface,
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
      flexDirection: 'row' as const,
      justifyContent: 'space-between' as const,
      alignItems: 'center' as const,
    },
    name: { fontWeight: '700' as const, fontSize: 16, color: c.text },
    phone: { fontSize: 13, color: c.textMuted, marginTop: 2 },
    badge: {
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 20,
    },
    badgeVerified: { backgroundColor: c.successMuted },
    badgeUnverified: { backgroundColor: c.warningBg },
    badgeText: { fontSize: 12, fontWeight: '600' as const },
    badgeTextVerified: { color: c.success },
    badgeTextUnverified: { color: c.warning },
    actions: {
      flexDirection: 'row' as const,
      gap: 12,
      marginTop: 14,
    },
    actionBtn: {
      flex: 1,
      paddingVertical: 10,
      borderRadius: 8,
      alignItems: 'center' as const,
      borderWidth: 1.5,
    },
    actionBtnSuccess: {
      backgroundColor: c.successMuted,
      borderColor: c.success,
    },
    actionBtnDanger: {
      backgroundColor: '#FFEBEE',
      borderColor: c.error,
    },
    actionBtnCredit: {
      backgroundColor: c.primaryMuted,
      borderColor: c.primary,
    },
    actionBtnText: { fontWeight: '600' as const, fontSize: 14 },
    actionBtnTextSuccess: { color: c.success },
    actionBtnTextDanger: { color: c.error },
    actionBtnTextCredit: { color: c.primary },
  };
}
