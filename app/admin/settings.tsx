import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Switch,
  TextInput,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../src/services/supabase';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import type { AppColors } from '../../src/theme/colors';
import { useSettingsStore } from '../../src/store/settingsStore';

type SettingsRow = {
  id: string;
  gst_enabled: boolean;
  gst_percent: number;
  credit_enabled: boolean;
  loyalty_enabled: boolean;
  delivery_enabled: boolean;
  pickup_enabled: boolean;
  pickup_address: string | null;
  pickup_hours: string | null;
  payment_modes_enabled: string[];
  loyalty_redemption_rate: number;
  max_redemption_percent: number;
  support_phone: string | null;
  show_prices_to_unverified: boolean;
};

type SavedField = string | null;

export default function AdminSettings() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const [settings, setSettings] = useState<SettingsRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [savedField, setSavedField] = useState<SavedField>(null);

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      const { data, error } = await supabase.from('settings').select('*').single();
      if (error) throw error;
      setSettings(data as SettingsRow);
    } catch {
      Alert.alert(t('common.error'), t('common.error'));
    } finally {
      setLoading(false);
    }
  };

  const showSaved = useCallback((key: string) => {
    setSavedField(key);
    setTimeout(() => setSavedField(null), 2000);
  }, []);

  const updateSetting = useCallback(async (key: string, value: any) => {
    if (!settings) return;

    try {
      const { error } = await supabase.rpc('update_settings', {
        p_key: key,
        p_value: typeof value === 'object' ? value : JSON.parse(JSON.stringify(value)),
      });

      if (error) throw error;
      showSaved(key);
      // Synchronize client settingsStore
      void useSettingsStore.getState().fetchSettings(true);
    } catch (err: any) {
      Alert.alert(t('common.error'), err.message || t('common.error'));
      fetchSettings();
    }
  }, [settings]);

  const toggleBool = async (key: keyof SettingsRow) => {
    if (!settings) return;
    const newVal = !settings[key];
    setSettings({ ...settings, [key]: newVal } as SettingsRow);
    await updateSetting(key, newVal);
  };

  const updateText = async (key: keyof SettingsRow, value: string) => {
    if (!settings) return;
    setSettings({ ...settings, [key]: value } as any);
    await updateSetting(key, value);
  };

  const updateNumeric = async (key: keyof SettingsRow, value: string) => {
    if (!settings) return;
    const num = parseFloat(value);
    if (isNaN(num)) return;
    setSettings({ ...settings, [key]: num } as any);
    await updateSetting(key, num);
  };

  const togglePaymentMode = async (mode: string) => {
    if (!settings) return;
    const current = Array.isArray(settings.payment_modes_enabled) ? settings.payment_modes_enabled : ['cod'];
    let updated: string[];
    if (current.includes(mode)) {
      updated = current.filter((m) => m !== mode);
      if (updated.length === 0) {
        Alert.alert(t('common.error'), t('admin.settingsScreen.atLeastOnePayment'));
        return;
      }
    } else {
      updated = [...current, mode];
    }
    setSettings({ ...settings, payment_modes_enabled: updated });
    await updateSetting('payment_modes_enabled', updated);
  };

  if (loading || !settings) {
    return (
      <SafeAreaView style={styles.center} edges={['top', 'left', 'right']}>
        <ActivityIndicator size="large" color={colors.primary} />
      </SafeAreaView>
    );
  }

  const paymentModes = Array.isArray(settings.payment_modes_enabled) ? settings.payment_modes_enabled : ['cod'];

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <SettingsGroup title={t('admin.settingsScreen.general')}>
          <ToggleRow
            icon="receipt"
            label={t('admin.settingsScreen.gstEnabled')}
            value={settings.gst_enabled}
            onToggle={() => toggleBool('gst_enabled')}
            saved={savedField === 'gst_enabled'}
          />
          {settings.gst_enabled && (
            <InputRow
              icon="calculator"
              label={t('admin.settingsScreen.gstPercent')}
              value={String(settings.gst_percent ?? 18)}
              onBlur={(v) => updateNumeric('gst_percent', v)}
              keyboardType="numeric"
              saved={savedField === 'gst_percent'}
            />
          )}
          <ToggleRow
            icon="eye"
            label={t('admin.settingsScreen.showPrices')}
            value={settings.show_prices_to_unverified}
            onToggle={() => toggleBool('show_prices_to_unverified')}
            saved={savedField === 'show_prices_to_unverified'}
          />
        </SettingsGroup>

        <SettingsGroup title={t('admin.settingsScreen.ordering')}>
          <ToggleRow
            icon="car"
            label={t('admin.settingsScreen.deliveryEnabled')}
            value={settings.delivery_enabled}
            onToggle={() => toggleBool('delivery_enabled')}
            saved={savedField === 'delivery_enabled'}
          />
          <ToggleRow
            icon="storefront"
            label={t('admin.settingsScreen.pickupEnabled')}
            value={settings.pickup_enabled}
            onToggle={() => toggleBool('pickup_enabled')}
            saved={savedField === 'pickup_enabled'}
          />
          {settings.pickup_enabled && (
            <>
              <InputRow
                icon="location"
                label={t('admin.settingsScreen.pickupAddress')}
                value={settings.pickup_address || ''}
                onBlur={(v) => updateText('pickup_address', v)}
                saved={savedField === 'pickup_address'}
              />
              <InputRow
                icon="time"
                label={t('admin.settingsScreen.pickupHours')}
                value={settings.pickup_hours || ''}
                onBlur={(v) => updateText('pickup_hours', v)}
                placeholder={t('admin.settingsScreen.pickupHoursPlaceholder')}
                saved={savedField === 'pickup_hours'}
              />
            </>
          )}
        </SettingsGroup>

        <SettingsGroup title={t('admin.settingsScreen.payments')}>
          <ToggleRow
            icon="cash"
            label={t('admin.settingsScreen.cod')}
            value={paymentModes.includes('cod')}
            onToggle={() => togglePaymentMode('cod')}
            saved={savedField === 'payment_modes_enabled'}
          />
          <ToggleRow
            icon="wallet"
            label={t('admin.settingsScreen.credit')}
            value={paymentModes.includes('credit')}
            onToggle={() => togglePaymentMode('credit')}
          />
          <ToggleRow
            icon="phone-portrait"
            label={t('admin.settingsScreen.upi')}
            value={paymentModes.includes('upi')}
            onToggle={() => togglePaymentMode('upi')}
          />
        </SettingsGroup>

        <SettingsGroup title={t('admin.settingsScreen.loyalty')}>
          <ToggleRow
            icon="star"
            label={t('admin.settingsScreen.loyaltyPoints')}
            value={settings.loyalty_enabled}
            onToggle={() => toggleBool('loyalty_enabled')}
            saved={savedField === 'loyalty_enabled'}
          />
          <ToggleRow
            icon="wallet"
            label={t('admin.settingsScreen.creditSystem')}
            value={settings.credit_enabled}
            onToggle={() => toggleBool('credit_enabled')}
            saved={savedField === 'credit_enabled'}
          />
          <InputRow
            icon="pricetag"
            label={t('admin.settingsScreen.redemptionRate')}
            value={String(settings.loyalty_redemption_rate ?? 0.5)}
            onBlur={(v) => updateNumeric('loyalty_redemption_rate', v)}
            keyboardType="numeric"
            saved={savedField === 'loyalty_redemption_rate'}
          />
          <InputRow
            icon="pie-chart"
            label={t('admin.settingsScreen.maxRedemption')}
            value={String(settings.max_redemption_percent ?? 20)}
            onBlur={(v) => updateNumeric('max_redemption_percent', v)}
            keyboardType="numeric"
            saved={savedField === 'max_redemption_percent'}
          />
        </SettingsGroup>

        <SettingsGroup title={t('admin.settingsScreen.support')}>
          <InputRow
            icon="call"
            label={t('admin.settingsScreen.supportPhone')}
            value={settings.support_phone || ''}
            onBlur={(v) => updateText('support_phone', v)}
            placeholder={t('admin.settingsScreen.supportPhonePlaceholder')}
            keyboardType="phone-pad"
            saved={savedField === 'support_phone'}
          />
        </SettingsGroup>
      </ScrollView>
    </SafeAreaView>
  );
}

function SettingsGroup({ title, children }: { title: string; children: React.ReactNode }) {
  const styles = useThemedStyles(createStyles);
  const validChildren = React.Children.toArray(children).filter(Boolean);

  if (validChildren.length === 0) return null;

  return (
    <View style={styles.groupContainer}>
      <Text style={styles.groupTitle}>{title}</Text>
      <View style={styles.groupCard}>
        {validChildren.map((child, index) => (
          <React.Fragment key={index}>
            {child}
            {index < validChildren.length - 1 && <View style={styles.rowDivider} />}
          </React.Fragment>
        ))}
      </View>
    </View>
  );
}

function ToggleRow({ icon, label, value, onToggle, saved }: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: boolean;
  onToggle: () => void;
  saved?: boolean;
}) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const { t } = useTranslation();

  return (
    <View style={styles.row}>
      <View style={styles.rowLeft}>
        <Ionicons name={icon} size={20} color={colors.primary} />
        <Text style={styles.label}>{label}</Text>
        {saved && <Text style={styles.savedTag}>{t('admin.settingsScreen.saved')}</Text>}
      </View>
      <Switch
        value={value}
        onValueChange={onToggle}
        trackColor={{ false: colors.switchTrackOff, true: colors.switchTrackOn }}
        thumbColor={value ? colors.switchThumbOn : colors.switchThumbOff}
      />
    </View>
  );
}

function InputRow({ icon, label, value, onBlur, placeholder, keyboardType, saved }: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
  onBlur: (value: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'numeric' | 'phone-pad';
  saved?: boolean;
}) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const [localValue, setLocalValue] = useState(value);

  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  return (
    <View style={styles.row}>
      <View style={[styles.rowLeft, { flex: 1 }]}>
        <Ionicons name={icon} size={20} color={colors.primary} style={{ marginTop: 2 }} />
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>{label}</Text>
          <TextInput
            style={styles.inlineInput}
            value={localValue}
            onChangeText={setLocalValue}
            onBlur={() => {
              if (localValue !== value) {
                if (keyboardType === 'numeric') {
                  const num = parseFloat(localValue);
                  if (isNaN(num)) {
                    // Revert input instantly
                    setLocalValue(value);
                    return;
                  }
                }
                onBlur(localValue);
              }
            }}
            placeholder={placeholder}
            placeholderTextColor={colors.textMuted}
            keyboardType={keyboardType || 'default'}
          />
        </View>
        {saved && <Text style={styles.savedTag}>{t('admin.settingsScreen.saved')}</Text>}
      </View>
    </View>
  );
}

function createStyles(c: AppColors, _isDark: boolean) {
  return {
    container: { flex: 1, backgroundColor: c.background },
    center: { flex: 1, justifyContent: 'center' as const, alignItems: 'center' as const, backgroundColor: c.background },

    groupContainer: {
      marginBottom: 16,
    },

    groupTitle: {
      fontSize: 12,
      fontWeight: '700' as const,
      color: c.textSecondary,
      textTransform: 'uppercase' as const,
      letterSpacing: 1,
      marginLeft: 4,
      marginBottom: 8,
    },

    groupCard: {
      backgroundColor: c.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.cardBorder,
      overflow: 'hidden' as const,
      elevation: 2,
      shadowColor: c.shadow,
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.05,
      shadowRadius: 8,
    },

    row: {
      padding: 16,
      flexDirection: 'row' as const,
      justifyContent: 'space-between' as const,
      alignItems: 'center' as const,
    },

    rowDivider: {
      height: 1,
      backgroundColor: c.borderLight,
      marginLeft: 48,
    },

    rowLeft: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 12,
    },

    label: {
      fontSize: 15,
      color: c.text,
      fontWeight: '500' as const,
    },

    inlineInput: {
      fontSize: 14,
      color: c.text,
      fontWeight: '500' as const,
      paddingVertical: 8,
      paddingHorizontal: 12,
      marginTop: 6,
      borderRadius: 8,
      backgroundColor: c.inputBackground,
      borderWidth: 1,
      borderColor: c.border,
    },

    savedTag: {
      fontSize: 11,
      color: c.success,
      fontWeight: '700' as const,
      backgroundColor: c.successMuted,
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 8,
      overflow: 'hidden' as const,
    },
  } as const;
}
