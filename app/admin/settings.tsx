import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Switch,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useSettingsStore } from '../../src/store/settingsStore';
import { AppSettings } from '../../src/types';

export default function AdminSettings() {
  const { settings, fetchSettings, updateSettings, isLoading } = useSettingsStore();
  const [localSettings, setLocalSettings] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchSettings();
  }, []);

  useEffect(() => {
    if (settings) {
      setLocalSettings({ ...settings });
    }
  }, [settings]);

  const updateFeature = (key: keyof AppSettings['features'], value: boolean) => {
    if (localSettings) {
      setLocalSettings({
        ...localSettings,
        features: { ...localSettings.features, [key]: value },
      });
    }
  };

  const updateBusiness = (key: keyof AppSettings['business'], value: number) => {
    if (localSettings) {
      setLocalSettings({
        ...localSettings,
        business: { ...localSettings.business, [key]: value },
      });
    }
  };

  const updateBranding = (key: keyof AppSettings['branding'], value: string) => {
    if (localSettings) {
      setLocalSettings({
        ...localSettings,
        branding: { ...localSettings.branding, [key]: value },
      });
    }
  };

  const handleSave = async () => {
    if (!localSettings) return;
    
    setSaving(true);
    const success = await updateSettings(localSettings);
    setSaving(false);
    
    if (success) {
      Alert.alert('Success', 'Settings saved successfully');
    } else {
      Alert.alert('Error', 'Failed to save settings');
    }
  };

  if (isLoading || !localSettings) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#1E88E5" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
        {/* Feature Toggles */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Feature Toggles</Text>
          
          <View style={styles.toggleRow}>
            <View style={styles.toggleInfo}>
              <Ionicons name="receipt" size={20} color="#1E88E5" />
              <Text style={styles.toggleLabel}>GST/Tax System</Text>
            </View>
            <Switch
              value={localSettings.features.gst_enabled}
              onValueChange={(v) => updateFeature('gst_enabled', v)}
              trackColor={{ true: '#1E88E5' }}
            />
          </View>
          
          <View style={styles.toggleRow}>
            <View style={styles.toggleInfo}>
              <Ionicons name="wallet" size={20} color="#43A047" />
              <Text style={styles.toggleLabel}>Credit System</Text>
            </View>
            <Switch
              value={localSettings.features.credit_enabled}
              onValueChange={(v) => updateFeature('credit_enabled', v)}
              trackColor={{ true: '#1E88E5' }}
            />
          </View>
          
          <View style={styles.toggleRow}>
            <View style={styles.toggleInfo}>
              <Ionicons name="star" size={20} color="#FFA726" />
              <Text style={styles.toggleLabel}>Loyalty Points</Text>
            </View>
            <Switch
              value={localSettings.features.loyalty_enabled}
              onValueChange={(v) => updateFeature('loyalty_enabled', v)}
              trackColor={{ true: '#1E88E5' }}
            />
          </View>
          
          <View style={styles.toggleRow}>
            <View style={styles.toggleInfo}>
              <Ionicons name="car" size={20} color="#7E57C2" />
              <Text style={styles.toggleLabel}>Delivery Option</Text>
            </View>
            <Switch
              value={localSettings.features.delivery_enabled}
              onValueChange={(v) => updateFeature('delivery_enabled', v)}
              trackColor={{ true: '#1E88E5' }}
            />
          </View>
          
          <View style={styles.toggleRow}>
            <View style={styles.toggleInfo}>
              <Ionicons name="eye" size={20} color="#00ACC1" />
              <Text style={styles.toggleLabel}>Show Prices to Unverified</Text>
            </View>
            <Switch
              value={localSettings.features.show_prices_to_unverified}
              onValueChange={(v) => updateFeature('show_prices_to_unverified', v)}
              trackColor={{ true: '#1E88E5' }}
            />
          </View>
        </View>

        {/* Business Settings */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Business Settings</Text>
          
          <View style={styles.inputRow}>
            <Text style={styles.inputLabel}>Minimum Order Value (₹)</Text>
            <TextInput
              style={styles.input}
              value={String(localSettings.business.min_order_value)}
              onChangeText={(v) => updateBusiness('min_order_value', parseFloat(v) || 0)}
              keyboardType="numeric"
            />
          </View>
          
          <View style={styles.inputRow}>
            <Text style={styles.inputLabel}>Delivery Charge (₹)</Text>
            <TextInput
              style={styles.input}
              value={String(localSettings.business.delivery_charge)}
              onChangeText={(v) => updateBusiness('delivery_charge', parseFloat(v) || 0)}
              keyboardType="numeric"
            />
          </View>
          
          <View style={styles.inputRow}>
            <Text style={styles.inputLabel}>Free Delivery Above (₹)</Text>
            <TextInput
              style={styles.input}
              value={String(localSettings.business.free_delivery_above)}
              onChangeText={(v) => updateBusiness('free_delivery_above', parseFloat(v) || 0)}
              keyboardType="numeric"
            />
          </View>
          
          <View style={styles.inputRow}>
            <Text style={styles.inputLabel}>Points per ₹1</Text>
            <TextInput
              style={styles.input}
              value={String(localSettings.business.points_per_rupee)}
              onChangeText={(v) => updateBusiness('points_per_rupee', parseFloat(v) || 0)}
              keyboardType="numeric"
            />
          </View>
          
          <View style={styles.inputRow}>
            <Text style={styles.inputLabel}>Point Value (₹)</Text>
            <TextInput
              style={styles.input}
              value={String(localSettings.business.point_value_in_rupees)}
              onChangeText={(v) => updateBusiness('point_value_in_rupees', parseFloat(v) || 0)}
              keyboardType="numeric"
            />
          </View>
          
          <View style={styles.inputRow}>
            <Text style={styles.inputLabel}>Max Points Redemption (%)</Text>
            <TextInput
              style={styles.input}
              value={String(localSettings.business.max_points_redemption_percent)}
              onChangeText={(v) => updateBusiness('max_points_redemption_percent', parseFloat(v) || 0)}
              keyboardType="numeric"
            />
          </View>
        </View>

        {/* Branding */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Branding & Company Info</Text>
          
          <View style={styles.inputRow}>
            <Text style={styles.inputLabel}>Company Name</Text>
            <TextInput
              style={styles.inputFull}
              value={localSettings.branding.company_name}
              onChangeText={(v) => updateBranding('company_name', v)}
            />
          </View>
          
          <View style={styles.inputRow}>
            <Text style={styles.inputLabel}>Tagline</Text>
            <TextInput
              style={styles.inputFull}
              value={localSettings.branding.tagline}
              onChangeText={(v) => updateBranding('tagline', v)}
            />
          </View>
          
          <View style={styles.inputRow}>
            <Text style={styles.inputLabel}>GSTIN</Text>
            <TextInput
              style={styles.inputFull}
              value={localSettings.branding.gstin}
              onChangeText={(v) => updateBranding('gstin', v)}
              autoCapitalize="characters"
              maxLength={15}
            />
          </View>
          
          <View style={styles.inputRow}>
            <Text style={styles.inputLabel}>PAN</Text>
            <TextInput
              style={styles.inputFull}
              value={localSettings.branding.pan}
              onChangeText={(v) => updateBranding('pan', v)}
              autoCapitalize="characters"
              maxLength={10}
            />
          </View>
          
          <View style={styles.inputRow}>
            <Text style={styles.inputLabel}>Phone</Text>
            <TextInput
              style={styles.inputFull}
              value={localSettings.branding.phone}
              onChangeText={(v) => updateBranding('phone', v)}
              keyboardType="phone-pad"
            />
          </View>
          
          <View style={styles.inputRow}>
            <Text style={styles.inputLabel}>Email</Text>
            <TextInput
              style={styles.inputFull}
              value={localSettings.branding.email}
              onChangeText={(v) => updateBranding('email', v)}
              keyboardType="email-address"
              autoCapitalize="none"
            />
          </View>
          
          <View style={styles.inputRow}>
            <Text style={styles.inputLabel}>Address</Text>
            <TextInput
              style={[styles.inputFull, { minHeight: 60 }]}
              value={localSettings.branding.address}
              onChangeText={(v) => updateBranding('address', v)}
              multiline
            />
          </View>
        </View>

        <View style={styles.bottomPadding} />
      </ScrollView>

      {/* Save Button */}
      <View style={styles.footer}>
        <TouchableOpacity
          style={[styles.saveButton, saving && styles.saveButtonDisabled]}
          onPress={handleSave}
          disabled={saving}
        >
          {saving ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <>
              <Ionicons name="save" size={20} color="#fff" />
              <Text style={styles.saveButtonText}>Save Settings</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  scrollView: {
    flex: 1,
  },
  section: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginTop: 16,
    padding: 16,
    borderRadius: 12,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#333',
    marginBottom: 16,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  toggleInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  toggleLabel: {
    fontSize: 15,
    color: '#333',
  },
  inputRow: {
    marginBottom: 16,
  },
  inputLabel: {
    fontSize: 13,
    color: '#666',
    marginBottom: 8,
  },
  input: {
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    color: '#333',
  },
  inputFull: {
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    color: '#333',
  },
  bottomPadding: {
    height: 20,
  },
  footer: {
    padding: 16,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#eee',
  },
  saveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1E88E5',
    height: 56,
    borderRadius: 12,
    gap: 8,
  },
  saveButtonDisabled: {
    opacity: 0.7,
  },
  saveButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
});
