import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  Switch,
} from 'react-native';
import { TabScreenFrame, useTabHeaderSafePadding } from '../../../src/components/TabScreenFrame';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../../../src/store/authStore';
import { useSettingsStore } from '../../../src/store/settingsStore';
import { supabase } from '../../../src/services/supabase';
import { tabScrollBottomPadding } from '../../../src/theme/tabBarTheme';
import { useThemedStyles } from '../../../src/theme/useThemedStyles';
import { useAppTheme } from '../../../src/hooks/useAppTheme';
import type { AppColors } from '../../../src/theme/colors';
import type { ThemePreference } from '../../../src/store/themeStore';
import { switchTrackColors, switchThumbColor } from '../../../src/theme/tabScreenStyles';
import i18n from '../../../src/i18n';
import { useTranslation } from 'react-i18next';
import { useDeliveryDuty } from '../../../src/hooks/useDeliveryDuty';

export default function DeliveryProfile() {
  const styles = useThemedStyles(createProfileStyles);
  const { colors, preference, setPreference } = useAppTheme();
  const headerSafePadding = useTabHeaderSafePadding();
  const router = useRouter();
  const { t } = useTranslation();
  const { user, logout, updateProfile, isLoading, fetchUser } = useAuthStore();
  const { isOnDuty, dutyLoading, dutyToggling, loadDutyStatus, toggleOnDuty } = useDeliveryDuty();

  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(true);
  const [pushPermissionDenied, setPushPermissionDenied] = useState(false);
  const [language, setLanguage] = useState('en');

  const [formData, setFormData] = useState({
    name: '',
    email: '',
  });

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([
      fetchUser({ silent: true }),
      loadDutyStatus(),
      useSettingsStore.getState().fetchSettings(true),
    ]);
    setRefreshing(false);
  }, [fetchUser, loadDutyStatus]);

  const fetchProfileExtras = useCallback(async () => {
    if (!user) return;
    try {
      const { data } = await supabase
        .from('profiles')
        .select('push_enabled, push_token, preferred_language')
        .eq('id', user.id)
        .single();
      if (data) {
        setPushEnabled(data.push_enabled ?? true);
        setPushPermissionDenied(!data.push_token && !data.push_enabled);
        if (data.preferred_language) {
          setLanguage(data.preferred_language);
          i18n.changeLanguage(data.preferred_language);
        }
      }
    } catch {}
  }, [user]);

  useEffect(() => {
    if (user) {
      void fetchProfileExtras();
    }
  }, [user, fetchProfileExtras]);

  if (!user) {
    return (
      <TabScreenFrame style={styles.container}>
        <View style={styles.center}>
          <Text style={{ color: colors.textSecondary }}>Please login</Text>
        </View>
      </TabScreenFrame>
    );
  }

  const startEditing = () => {
    setFormData({
      name: user.name || '',
      email: user.email || '',
    });
    setEditing(true);
  };

  const cancelEditing = () => setEditing(false);

  const handleSave = async () => {
    if (!formData.name.trim()) {
      Alert.alert('Error', 'Name is required');
      return;
    }
    const success = await updateProfile({
      name: formData.name.trim(),
      email: formData.email.trim() || null,
    });
    if (success) {
      setEditing(false);
      Alert.alert('Success', 'Profile updated successfully');
    } else {
      Alert.alert('Error', 'Failed to update profile');
    }
  };

  const handleLogout = () => {
    Alert.alert('Logout', 'Are you sure you want to logout?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Logout',
        style: 'destructive',
        onPress: async () => {
          await logout();
          router.replace('/(auth)/login');
        },
      },
    ]);
  };

  const togglePush = async (val: boolean) => {
    setPushEnabled(val);
    try {
      await supabase
        .from('profiles')
        .update({ push_enabled: val })
        .eq('id', user.id);
    } catch {}
  };

  const changeLanguage = async (lang: string) => {
    setLanguage(lang);
    i18n.changeLanguage(lang);
    try {
      await supabase.from('profiles').update({ preferred_language: lang }).eq('id', user!.id);
    } catch {}
  };

  const updateField = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const InfoRow = ({ icon, label, value }: {
    icon: keyof typeof Ionicons.glyphMap;
    label: string;
    value: string | null | undefined;
  }) => (
    <View style={styles.infoRow}>
      <View style={styles.infoIcon}>
        <Ionicons name={icon} size={18} color={colors.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.infoLabel}>{label}</Text>
        <Text style={styles.infoValue}>{value || '—'}</Text>
      </View>
    </View>
  );

  return (
    <TabScreenFrame style={styles.container}>
      <View style={[styles.header, headerSafePadding]}>
        <Text style={styles.title}>Profile</Text>
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={tabScrollBottomPadding(16)}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        >
          {/* Profile Card */}
          <View style={styles.card}>
            <Ionicons name="person-circle" size={72} color={colors.primary} />
            <Text style={styles.name}>{user.name}</Text>
            <Text style={styles.phone}>{user.phone}</Text>
            <View style={styles.badge}>
              <Ionicons name="car" size={14} color={colors.primary} />
              <Text style={{ color: colors.primary, fontWeight: '600', fontSize: 12 }}>
                Delivery Partner
              </Text>
            </View>
          </View>

          {/* Duty Switch Section */}
          <View style={styles.pushCard}>
            <View style={styles.pushRow}>
              <View style={styles.pushLeft}>
                <Ionicons name="navigate-circle-outline" size={20} color={colors.primary} />
                <View style={{ marginLeft: 12 }}>
                  <Text style={styles.pushLabel}>
                    {isOnDuty ? 'On Duty' : 'Off Duty'}
                  </Text>
                  <Text style={{ fontSize: 11, color: colors.textSecondary, marginTop: 2 }}>
                    {isOnDuty ? 'Available for deliveries' : 'Unavailable for deliveries'}
                  </Text>
                </View>
              </View>
              {dutyLoading ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <Switch
                  value={isOnDuty}
                  onValueChange={(v) => void toggleOnDuty(v)}
                  disabled={dutyToggling}
                  trackColor={switchTrackColors(colors)}
                  thumbColor={switchThumbColor(colors, isOnDuty)}
                />
              )}
            </View>
          </View>

          {/* Push Notifications Toggle */}
          <View style={styles.pushCard}>
            <View style={styles.pushRow}>
              <View style={styles.pushLeft}>
                <Ionicons name="notifications-outline" size={20} color={colors.primary} />
                <Text style={[styles.pushLabel, { marginLeft: 12 }]}>Push Notifications</Text>
              </View>
              <Switch
                value={pushEnabled}
                onValueChange={togglePush}
                trackColor={switchTrackColors(colors)}
                thumbColor={switchThumbColor(colors, pushEnabled)}
              />
            </View>
            {pushPermissionDenied && (
              <Text style={styles.pushHint}>
                Permission denied. Re-enable in your device settings.
              </Text>
            )}
          </View>

          {/* Theme appearance picker */}
          <View style={styles.pushCard}>
            <Text style={[styles.pushLabel, { marginBottom: 12 }]}>{t('profile.appearance')}</Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              {(['light', 'dark', 'system'] as ThemePreference[]).map((mode) => (
                <TouchableOpacity
                  key={mode}
                  style={[styles.langBtn, preference === mode && styles.langBtnActive]}
                  onPress={() => void setPreference(mode)}
                >
                  <Text style={[styles.langText, preference === mode && styles.langTextActive]}>
                    {mode === 'light'
                      ? t('profile.themeLight')
                      : mode === 'dark'
                        ? t('profile.themeDark')
                        : t('profile.themeSystem')}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Language selector */}
          <View style={styles.pushCard}>
            <Text style={[styles.pushLabel, { marginBottom: 12 }]}>{t('profile.language')}</Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity
                style={[styles.langBtn, language === 'en' && styles.langBtnActive]}
                onPress={() => changeLanguage('en')}
              >
                <Text style={[styles.langText, language === 'en' && styles.langTextActive]}>
                  {t('profile.english')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.langBtn, language === 'hi' && styles.langBtnActive]}
                onPress={() => changeLanguage('hi')}
              >
                <Text style={[styles.langText, language === 'hi' && styles.langTextActive]}>
                  {t('profile.hindi')}
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* My Details Section */}
          <View style={styles.detailsCard}>
            <View style={styles.detailsHeader}>
              <Text style={styles.detailsTitle}>My Details</Text>
              {!editing ? (
                <TouchableOpacity style={styles.editBtn} onPress={startEditing}>
                  <Ionicons name="create-outline" size={16} color={colors.primary} />
                  <Text style={styles.editBtnText}>Edit</Text>
                </TouchableOpacity>
              ) : (
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TouchableOpacity style={styles.cancelEditBtn} onPress={cancelEditing}>
                    <Text style={styles.cancelEditText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.saveBtn} onPress={handleSave} disabled={isLoading}>
                    {isLoading ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Text style={styles.saveBtnText}>Save</Text>
                    )}
                  </TouchableOpacity>
                </View>
              )}
            </View>

            {!editing ? (
              <View style={styles.infoList}>
                <InfoRow icon="person-outline" label="Name" value={user.name} />
                <InfoRow icon="call-outline" label="Phone" value={user.phone} />
                <InfoRow icon="mail-outline" label="Email" value={user.email} />
              </View>
            ) : (
              <View style={styles.editForm}>
                <Text style={styles.formSection}>Name *</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Full Name *"
                  placeholderTextColor={colors.textMuted}
                  value={formData.name}
                  onChangeText={(v) => updateField('name', v)}
                />
                <Text style={styles.formSection}>Email</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Email Address"
                  placeholderTextColor={colors.textMuted}
                  value={formData.email}
                  onChangeText={(v) => updateField('email', v)}
                  keyboardType="email-address"
                  autoCapitalize="none"
                />
              </View>
            )}
          </View>

          {/* Logout */}
          <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
            <Ionicons name="log-out-outline" size={20} color={colors.error} />
            <Text style={styles.logoutText}>Logout</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </TabScreenFrame>
  );
}

function createProfileStyles(c: AppColors) {
  return {
    container: { flex: 1, backgroundColor: c.background },
    center: { flex: 1, justifyContent: 'center' as const, alignItems: 'center' as const },
    header: {
      backgroundColor: c.surface,
      flexDirection: 'row' as const,
      justifyContent: 'space-between' as const,
      alignItems: 'center' as const,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    title: { fontSize: 22, fontWeight: '700' as const, color: c.text },
    card: {
      backgroundColor: c.surface,
      margin: 16,
      padding: 20,
      borderRadius: 16,
      alignItems: 'center' as const,
      borderWidth: 1,
      borderColor: c.border,
    },
    name: { fontSize: 20, fontWeight: '700' as const, marginTop: 8, color: c.text },
    phone: { fontSize: 14, color: c.textSecondary, marginBottom: 12 },
    badge: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 12,
      gap: 6,
      backgroundColor: c.primaryMuted,
    },
    pushCard: {
      backgroundColor: c.surface,
      marginHorizontal: 16,
      marginBottom: 12,
      padding: 16,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.border,
    },
    pushRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'space-between' as const,
    },
    pushLeft: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      flex: 1,
    },
    pushLabel: { fontSize: 15, fontWeight: '600' as const, color: c.text },
    pushHint: { fontSize: 12, color: c.error, marginTop: 8 },
    langBtn: {
      flex: 1,
      paddingVertical: 10,
      borderRadius: 10,
      backgroundColor: c.background,
      alignItems: 'center' as const,
      borderWidth: 1,
      borderColor: c.border,
    },
    langBtnActive: {
      backgroundColor: c.primary,
      borderColor: c.primary,
    },
    langText: { fontSize: 14, fontWeight: '500' as const, color: c.textSecondary },
    langTextActive: { color: c.onPrimary, fontWeight: '700' as const },
    detailsCard: {
      backgroundColor: c.surface,
      marginHorizontal: 16,
      marginBottom: 16,
      borderRadius: 16,
      padding: 16,
      borderWidth: 1,
      borderColor: c.border,
    },
    detailsHeader: {
      flexDirection: 'row' as const,
      justifyContent: 'space-between' as const,
      alignItems: 'center' as const,
      marginBottom: 16,
    },
    detailsTitle: { fontSize: 17, fontWeight: '700' as const, color: c.text },
    editBtn: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 4,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 8,
      backgroundColor: c.primaryMuted,
    },
    editBtnText: { color: c.primary, fontSize: 13, fontWeight: '600' as const },
    cancelEditBtn: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: c.border,
    },
    cancelEditText: { color: c.textSecondary, fontSize: 13, fontWeight: '600' as const },
    saveBtn: {
      paddingHorizontal: 16,
      paddingVertical: 6,
      borderRadius: 8,
      backgroundColor: c.primary,
      minWidth: 60,
      alignItems: 'center' as const,
    },
    saveBtnText: { color: c.onPrimary, fontSize: 13, fontWeight: '600' as const },
    infoList: { gap: 0 },
    infoRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: c.borderLight,
    },
    infoIcon: {
      width: 36,
      height: 36,
      borderRadius: 10,
      backgroundColor: c.primaryMuted,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      marginRight: 12,
    },
    infoLabel: { fontSize: 11, color: c.textMuted, marginBottom: 1 },
    infoValue: { fontSize: 14, color: c.text, fontWeight: '500' as const },
    editForm: { gap: 8 },
    formSection: { fontSize: 12, fontWeight: '600' as const, color: c.primary, marginTop: 4 },
    input: {
      backgroundColor: c.background,
      borderRadius: 10,
      paddingHorizontal: 14,
      height: 48,
      fontSize: 15,
      color: c.text,
      borderWidth: 1,
      borderColor: c.border,
    },
    logoutBtn: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      gap: 8,
      backgroundColor: c.surface,
      marginHorizontal: 16,
      marginBottom: 20,
      paddingVertical: 14,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: c.error,
    },
    logoutText: { color: c.error, fontSize: 16, fontWeight: '700' as const },
  };
}
