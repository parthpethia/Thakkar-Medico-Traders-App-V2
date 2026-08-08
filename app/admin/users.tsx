import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  Alert,
  Platform,
  Modal,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { supabase } from '../../src/services/supabase';
import { User } from '../../src/types';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import type { AppColors } from '../../src/theme/colors';

export default function AdminUsers() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const [users, setUsers] = useState<User[]>([]);

  // Modal states for Android prompt fallback
  const [creditModalVisible, setCreditModalVisible] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [creditLimitInput, setCreditLimitInput] = useState('');
  const [savingCredit, setSavingCredit] = useState(false);

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

  const setCredit = (user: User) => {
    if (Platform.OS === 'ios' && Alert.prompt) {
      Alert.prompt(
        'Set Credit Limit',
        `Current limit: ₹${user.credit_limit || 0}`,
        async (value) => {
          const amount = Number(value);
          if (isNaN(amount) || amount < 0) {
            Alert.alert('Error', 'Please enter a valid positive number');
            return;
          }
          const { error } = await supabase
            .from('profiles')
            .update({ credit_limit: amount })
            .eq('id', user.id);
          if (error) {
            Alert.alert('Error', error.message);
          } else {
            fetchUsers();
          }
        },
        'plain-text',
        String(user.credit_limit || '')
      );
    } else {
      setSelectedUserId(user.id);
      setCreditLimitInput(String(user.credit_limit || ''));
      setCreditModalVisible(true);
    }
  };

  const handleSaveCredit = async () => {
    const amount = Number(creditLimitInput);
    if (isNaN(amount) || amount < 0) {
      Alert.alert('Error', 'Please enter a valid positive number');
      return;
    }
    if (!selectedUserId) return;

    setSavingCredit(true);
    const { error } = await supabase
      .from('profiles')
      .update({ credit_limit: amount })
      .eq('id', selectedUserId);

    setSavingCredit(false);
    if (error) {
      Alert.alert('Error', error.message);
    } else {
      setCreditModalVisible(false);
      fetchUsers();
    }
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
                  onPress={() => setCredit(item)}
                >
                  <Text style={[styles.actionBtnText, styles.actionBtnTextCredit]}>Set Credit</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        )}
      />

      <Modal
        visible={creditModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setCreditModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Set Credit Limit</Text>
            <Text style={styles.modalSub}>Enter the maximum credit allowed for this retailer.</Text>

            <TextInput
              style={styles.modalInput}
              placeholder="e.g. 5000"
              placeholderTextColor={colors.textMuted}
              keyboardType="numeric"
              value={creditLimitInput}
              onChangeText={setCreditLimitInput}
              autoFocus
            />

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.modalCancel}
                onPress={() => setCreditModalVisible(false)}
                disabled={savingCredit}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalSubmit, savingCredit && { opacity: 0.6 }]}
                onPress={handleSaveCredit}
                disabled={savingCredit}
              >
                {savingCredit ? (
                  <ActivityIndicator size="small" color={colors.onPrimary} />
                ) : (
                  <Text style={styles.modalSubmitText}>Save</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
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

    // Modal Styles
    modalOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'center' as const,
      alignItems: 'center' as const,
      padding: 24,
    },
    modalContent: {
      backgroundColor: c.surface,
      borderRadius: 16,
      padding: 24,
      width: '100%' as const,
      maxWidth: 400,
    },
    modalTitle: { fontSize: 18, fontWeight: '700' as const, color: c.text, marginBottom: 4 },
    modalSub: { fontSize: 13, color: c.textMuted, marginBottom: 16 },
    modalInput: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 10,
      padding: 12,
      fontSize: 15,
      color: c.text,
      marginBottom: 16,
      backgroundColor: c.background,
    },
    modalActions: { flexDirection: 'row' as const, gap: 10 },
    modalCancel: {
      flex: 1,
      paddingVertical: 12,
      borderRadius: 10,
      backgroundColor: c.background,
      alignItems: 'center' as const,
      borderWidth: 1,
      borderColor: c.border,
    },
    modalCancelText: { color: c.textSecondary, fontSize: 14, fontWeight: '600' as const },
    modalSubmit: {
      flex: 1,
      paddingVertical: 12,
      borderRadius: 10,
      backgroundColor: c.primary,
      alignItems: 'center' as const,
    },
    modalSubmitText: { color: c.onPrimary, fontSize: 14, fontWeight: '600' as const },
  };
}
