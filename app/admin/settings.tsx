import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Switch,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../src/services/supabase';

type SettingsRow = {
  id: string;
  gst_enabled: boolean;
  credit_enabled: boolean;
  loyalty_enabled: boolean;
  delivery_enabled: boolean;
  show_prices_to_unverified: boolean;
};

export default function AdminSettings() {
  const [settings, setSettings] = useState<SettingsRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      const { data, error } = await supabase
        .from('settings')
        .select('*')
        .single();

      if (error) throw error;
      setSettings(data);
    } catch (err) {
      Alert.alert('Error', 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  const toggle = (key: keyof SettingsRow) => {
    if (!settings) return;
    setSettings({ ...settings, [key]: !settings[key] });
  };

  const save = async () => {
    if (!settings) return;
    setSaving(true);

    const { error } = await supabase
      .from('settings')
      .update({
        gst_enabled: settings.gst_enabled,
        credit_enabled: settings.credit_enabled,
        loyalty_enabled: settings.loyalty_enabled,
        delivery_enabled: settings.delivery_enabled,
        show_prices_to_unverified: settings.show_prices_to_unverified,
      })
      .eq('id', settings.id);

    setSaving(false);

    if (error) {
      Alert.alert('Error', error.message);
    } else {
      Alert.alert('Saved', 'Settings updated successfully');
    }
  };

  if (loading || !settings) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator size="large" color="#4C51C9" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <Text style={styles.title}>System Settings</Text>

        <Toggle
          icon="receipt"
          label="Enable GST"
          value={settings.gst_enabled}
          onToggle={() => toggle('gst_enabled')}
        />

        <Toggle
          icon="wallet"
          label="Enable Credit System"
          value={settings.credit_enabled}
          onToggle={() => toggle('credit_enabled')}
        />

        <Toggle
          icon="star"
          label="Enable Loyalty Points"
          value={settings.loyalty_enabled}
          onToggle={() => toggle('loyalty_enabled')}
        />

        <Toggle
          icon="car"
          label="Enable Delivery"
          value={settings.delivery_enabled}
          onToggle={() => toggle('delivery_enabled')}
        />

        <Toggle
          icon="eye"
          label="Show Prices to Unverified Users"
          value={settings.show_prices_to_unverified}
          onToggle={() => toggle('show_prices_to_unverified')}
        />
      </ScrollView>

      <View style={styles.footer}>
        <TouchableOpacity
          style={styles.saveBtn}
          onPress={save}
          disabled={saving}
        >
          {saving ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Ionicons name="save" size={18} color="#fff" />
              <Text style={styles.saveText}>Save Settings</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

/* ================= COMPONENT ================= */

function Toggle({
  icon,
  label,
  value,
  onToggle,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: boolean;
  onToggle: () => void;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowLeft}>
        <Ionicons name={icon} size={20} color="#4C51C9" />
        <Text style={styles.label}>{label}</Text>
      </View>
      <Switch value={value} onValueChange={onToggle} />
    </View>
  );
}

/* ================= STYLES ================= */

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  title: {
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 16,
  },

  row: {
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },

  rowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },

  label: {
    fontSize: 15,
    color: '#333',
  },

  footer: {
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: '#eee',
    backgroundColor: '#fff',
  },

  saveBtn: {
    backgroundColor: '#4C51C9',
    height: 52,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },

  saveText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
