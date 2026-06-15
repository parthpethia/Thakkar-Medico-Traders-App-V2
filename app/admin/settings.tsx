import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
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

    const jsonValue = typeof value === 'object' ? value : JSON.stringify(value);

    try {
      const { error } = await supabase.rpc('update_settings', {
        p_key: key,
        p_value: typeof value === 'object' ? value : JSON.parse(JSON.stringify(value)),
      });

      if (error) throw error;
      showSaved(key);
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
      <SafeAreaView style={styles.center}>
        <ActivityIndicator size="large" color="#4C51C9" />
      </SafeAreaView>
    );
  }

  const paymentModes = Array.isArray(settings.payment_modes_enabled) ? settings.payment_modes_enabled : ['cod'];

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <Text style={styles.title}>{t('admin.settingsScreen.title')}</Text>

        {/* General */}
        <Text style={styles.groupTitle}>{t('admin.settingsScreen.general')}</Text>
        <ToggleRow
          icon="receipt"
          label={t('admin.settingsScreen.gstEnabled')}
          value={settings.gst_enabled}
          onToggle={() => toggleBool('gst_enabled')}
          saved={savedField === 'gst_enabled' ? t('admin.settingsScreen.saved') : undefined}
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

        {/* Ordering */}
        <Text style={styles.groupTitle}>{t('admin.settingsScreen.ordering')}</Text>
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

        {/* Payments */}
        <Text style={styles.groupTitle}>{t('admin.settingsScreen.payments')}</Text>
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

        {/* Loyalty */}
        <Text style={styles.groupTitle}>{t('admin.settingsScreen.loyalty')}</Text>
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

        {/* Support */}
        <Text style={styles.groupTitle}>{t('admin.settingsScreen.support')}</Text>
        <InputRow
          icon="call"
          label={t('admin.settingsScreen.supportPhone')}
          value={settings.support_phone || ''}
          onBlur={(v) => updateText('support_phone', v)}
          placeholder={t('admin.settingsScreen.supportPhonePlaceholder')}
          keyboardType="phone-pad"
          saved={savedField === 'support_phone'}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

/* ================= COMPONENTS ================= */

function ToggleRow({ icon, label, value, onToggle, saved }: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: boolean;
  onToggle: () => void;
  saved?: boolean;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowLeft}>
        <Ionicons name={icon} size={20} color="#4C51C9" />
        <Text style={styles.label}>{label}</Text>
        {saved && <Text style={styles.savedTag}>Saved</Text>}
      </View>
      <Switch value={value} onValueChange={onToggle} />
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
  const [localValue, setLocalValue] = useState(value);

  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  return (
    <View style={styles.row}>
      <View style={[styles.rowLeft, { flex: 1 }]}>
        <Ionicons name={icon} size={20} color="#4C51C9" />
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>{label}</Text>
          <TextInput
            style={styles.inlineInput}
            value={localValue}
            onChangeText={setLocalValue}
            onBlur={() => {
              if (localValue !== value) {
                onBlur(localValue);
              }
            }}
            placeholder={placeholder}
            placeholderTextColor="#bbb"
            keyboardType={keyboardType || 'default'}
          />
        </View>
        {saved && <Text style={styles.savedTag}>Saved</Text>}
      </View>
    </View>
  );
}

/* ================= STYLES ================= */

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  title: { fontSize: 22, fontWeight: '700', marginBottom: 8 },

  groupTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#4C51C9',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 20,
    marginBottom: 8,
  },

  row: {
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  rowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  label: { fontSize: 15, color: '#333' },

  inlineInput: {
    fontSize: 14,
    color: '#4C51C9',
    fontWeight: '600',
    paddingVertical: 4,
    paddingHorizontal: 0,
    marginTop: 2,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },

  savedTag: {
    fontSize: 11,
    color: '#43A047',
    fontWeight: '700',
    backgroundColor: '#E8F5E9',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
    overflow: 'hidden',
  },
});
