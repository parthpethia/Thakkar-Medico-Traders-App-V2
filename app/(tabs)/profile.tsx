import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../../src/store/authStore';
import { useSettingsStore } from '../../src/store/settingsStore';

export default function Profile() {
  const router = useRouter();
  const { user, logout, updateProfile, isLoading } = useAuthStore();
  const { settings } = useSettingsStore();
  const [editing, setEditing] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    business_name: '',
    gstin: '',
    address: '',
    city: '',
    state: '',
    pincode: '',
  });

  if (!user) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Text>Please login</Text>
        </View>
      </SafeAreaView>
    );
  }

  const isAdmin = user.role === 'admin';
  const isVerified = isAdmin || user.approved === true;
  const availableCredit =
    (user.credit_limit || 0) - (user.credit_used || 0);

  const startEditing = () => {
    setFormData({
      name: user.name || '',
      email: user.email || '',
      business_name: user.business_name || '',
      gstin: user.gstin || '',
      address: user.address || '',
      city: user.city || '',
      state: user.state || '',
      pincode: user.pincode || '',
    });
    setEditing(true);
  };

  const cancelEditing = () => {
    setEditing(false);
  };

  const handleSave = async () => {
    if (!formData.name.trim()) {
      Alert.alert('Error', 'Name is required');
      return;
    }

    const success = await updateProfile({
      name: formData.name.trim(),
      email: formData.email.trim() || null,
      business_name: formData.business_name.trim() || null,
      gstin: formData.gstin.trim() || null,
      address: formData.address.trim() || null,
      city: formData.city.trim() || null,
      state: formData.state.trim() || null,
      pincode: formData.pincode.trim() || null,
    });

    if (success) {
      setEditing(false);
      Alert.alert('Success', 'Profile updated successfully');
    } else {
      Alert.alert('Error', 'Failed to update profile');
    }
  };

  const handleLogout = () => {
    Alert.alert('Logout', 'Are you sure?', [
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

  const updateField = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const InfoRow = ({
    icon,
    label,
    value,
  }: {
    icon: keyof typeof Ionicons.glyphMap;
    label: string;
    value: string | null | undefined;
  }) => (
    <View style={styles.infoRow}>
      <View style={styles.infoIcon}>
        <Ionicons name={icon} size={18} color="#4C51C9" />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.infoLabel}>{label}</Text>
        <Text style={styles.infoValue}>{value || '—'}</Text>
      </View>
    </View>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Profile</Text>

        <View style={{ flexDirection: 'row', gap: 8 }}>
          {isAdmin && (
            <TouchableOpacity
              style={styles.adminBtn}
              onPress={() => router.push('/admin')}
            >
              <Ionicons name="settings" size={18} color="#fff" />
              <Text style={styles.adminText}>Admin</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView showsVerticalScrollIndicator={false}>
          {/* Profile Card */}
          <View style={styles.card}>
            <Ionicons name="person-circle" size={72} color="#4C51C9" />
            <Text style={styles.name}>{user.name}</Text>
            <Text style={styles.phone}>{user.phone}</Text>

            <View
              style={[
                styles.badge,
                {
                  backgroundColor: isVerified ? '#E8F5E9' : '#FFF3E0',
                },
              ]}
            >
              <Ionicons
                name={isVerified ? 'checkmark-circle' : 'time'}
                size={14}
                color={isVerified ? '#43A047' : '#FFA726'}
              />
              <Text
                style={{
                  color: isVerified ? '#43A047' : '#FFA726',
                  fontWeight: '600',
                  fontSize: 12,
                }}
              >
                {isAdmin
                  ? 'Admin'
                  : isVerified
                  ? 'Verified Retailer'
                  : 'Pending Verification'}
              </Text>
            </View>
          </View>

          {/* Loyalty & Credit */}
          {isVerified && settings?.features.loyalty_enabled && (
            <View style={styles.statsRow}>
              <View style={styles.stat}>
                <Ionicons name="star" size={24} color="#FFA726" />
                <Text style={styles.statValue}>
                  {user.loyalty_points || 0}
                </Text>
                <Text style={styles.statLabel}>Points</Text>
              </View>

              {settings?.features.credit_enabled && (
                <View style={styles.stat}>
                  <Ionicons name="wallet" size={24} color="#43A047" />
                  <Text style={styles.statValue}>
                    ₹{availableCredit.toFixed(0)}
                  </Text>
                  <Text style={styles.statLabel}>Credit Available</Text>
                </View>
              )}
            </View>
          )}

          {/* User Details Section */}
          <View style={styles.detailsCard}>
            <View style={styles.detailsHeader}>
              <Text style={styles.detailsTitle}>My Details</Text>
              {!editing ? (
                <TouchableOpacity
                  style={styles.editBtn}
                  onPress={startEditing}
                >
                  <Ionicons name="create-outline" size={16} color="#4C51C9" />
                  <Text style={styles.editBtnText}>Edit</Text>
                </TouchableOpacity>
              ) : (
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TouchableOpacity
                    style={styles.cancelEditBtn}
                    onPress={cancelEditing}
                  >
                    <Text style={styles.cancelEditText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.saveBtn}
                    onPress={handleSave}
                    disabled={isLoading}
                  >
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
              /* --- View Mode --- */
              <View style={styles.infoList}>
                <InfoRow icon="person-outline" label="Name" value={user.name} />
                <InfoRow icon="call-outline" label="Phone" value={user.phone} />
                <InfoRow icon="mail-outline" label="Email" value={user.email} />

                <View style={styles.sectionDivider}>
                  <Text style={styles.sectionLabel}>Business</Text>
                </View>
                <InfoRow
                  icon="business-outline"
                  label="Business Name"
                  value={user.business_name}
                />
                <InfoRow
                  icon="document-text-outline"
                  label="GSTIN"
                  value={user.gstin}
                />

                <View style={styles.sectionDivider}>
                  <Text style={styles.sectionLabel}>Address</Text>
                </View>
                <InfoRow
                  icon="location-outline"
                  label="Address"
                  value={user.address}
                />
                <InfoRow icon="map-outline" label="City" value={user.city} />
                <InfoRow icon="flag-outline" label="State" value={user.state} />
                <InfoRow
                  icon="navigate-outline"
                  label="Pincode"
                  value={user.pincode}
                />
              </View>
            ) : (
              /* --- Edit Mode --- */
              <View style={styles.editForm}>
                <Text style={styles.formSection}>Account Details</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Full Name *"
                  placeholderTextColor="#999"
                  value={formData.name}
                  onChangeText={(v) => updateField('name', v)}
                />
                <TextInput
                  style={styles.input}
                  placeholder="Email"
                  placeholderTextColor="#999"
                  value={formData.email}
                  onChangeText={(v) => updateField('email', v)}
                  keyboardType="email-address"
                  autoCapitalize="none"
                />

                <Text style={styles.formSection}>Business Details</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Business Name"
                  placeholderTextColor="#999"
                  value={formData.business_name}
                  onChangeText={(v) => updateField('business_name', v)}
                />
                <TextInput
                  style={styles.input}
                  placeholder="GSTIN"
                  placeholderTextColor="#999"
                  value={formData.gstin}
                  onChangeText={(v) => updateField('gstin', v)}
                  autoCapitalize="characters"
                  maxLength={15}
                />

                <Text style={styles.formSection}>Address</Text>
                <TextInput
                  style={[styles.input, styles.multilineInput]}
                  placeholder="Address"
                  placeholderTextColor="#999"
                  value={formData.address}
                  onChangeText={(v) => updateField('address', v)}
                  multiline
                  numberOfLines={2}
                />
                <View style={styles.row}>
                  <TextInput
                    style={[styles.input, styles.halfInput]}
                    placeholder="City"
                    placeholderTextColor="#999"
                    value={formData.city}
                    onChangeText={(v) => updateField('city', v)}
                  />
                  <TextInput
                    style={[styles.input, styles.halfInput]}
                    placeholder="State"
                    placeholderTextColor="#999"
                    value={formData.state}
                    onChangeText={(v) => updateField('state', v)}
                  />
                </View>
                <TextInput
                  style={styles.input}
                  placeholder="Pincode"
                  placeholderTextColor="#999"
                  value={formData.pincode}
                  onChangeText={(v) => updateField('pincode', v)}
                  keyboardType="number-pad"
                  maxLength={6}
                />
              </View>
            )}
          </View>

          {/* Logout */}
          <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
            <Ionicons name="log-out-outline" size={20} color="#e53935" />
            <Text style={styles.logoutText}>Logout</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/* ================= STYLES ================= */

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },

  header: {
    padding: 16,
    backgroundColor: '#fff',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },

  title: {
    fontSize: 22,
    fontWeight: '700',
  },

  adminBtn: {
    flexDirection: 'row',
    backgroundColor: '#4C51C9',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    gap: 6,
  },

  adminText: {
    color: '#fff',
    fontWeight: '600',
  },

  card: {
    backgroundColor: '#fff',
    margin: 16,
    padding: 20,
    borderRadius: 16,
    alignItems: 'center',
  },

  name: {
    fontSize: 20,
    fontWeight: '700',
    marginTop: 8,
  },

  phone: {
    fontSize: 14,
    color: '#666',
    marginBottom: 12,
  },

  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    gap: 6,
  },

  statsRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    gap: 12,
  },

  stat: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },

  statValue: {
    fontSize: 20,
    fontWeight: '700',
    marginTop: 6,
  },

  statLabel: {
    fontSize: 12,
    color: '#666',
    marginTop: 2,
  },

  /* Details Card */
  detailsCard: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginTop: 16,
    borderRadius: 16,
    padding: 16,
  },

  detailsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },

  detailsTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#333',
  },

  editBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#ECEDFB',
  },

  editBtnText: {
    color: '#4C51C9',
    fontSize: 13,
    fontWeight: '600',
  },

  cancelEditBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ddd',
  },

  cancelEditText: {
    color: '#666',
    fontSize: 13,
    fontWeight: '600',
  },

  saveBtn: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#4C51C9',
    minWidth: 60,
    alignItems: 'center',
  },

  saveBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },

  /* Info rows (view mode) */
  infoList: {
    gap: 0,
  },

  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f5f5f5',
  },

  infoIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#ECEDFB',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },

  infoLabel: {
    fontSize: 11,
    color: '#999',
    marginBottom: 1,
  },

  infoValue: {
    fontSize: 14,
    color: '#333',
    fontWeight: '500',
  },

  sectionDivider: {
    marginTop: 12,
    marginBottom: 4,
  },

  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#4C51C9',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  /* Edit form */
  editForm: {
    gap: 10,
  },

  formSection: {
    fontSize: 13,
    fontWeight: '600',
    color: '#4C51C9',
    marginTop: 8,
    marginBottom: 2,
  },

  input: {
    backgroundColor: '#f5f5f5',
    borderRadius: 10,
    paddingHorizontal: 14,
    height: 48,
    fontSize: 15,
    color: '#333',
  },

  multilineInput: {
    height: 72,
    paddingTop: 12,
    textAlignVertical: 'top',
  },

  row: {
    flexDirection: 'row',
    gap: 10,
  },

  halfInput: {
    flex: 1,
  },

  logoutBtn: {
    margin: 16,
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 12,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
  },

  logoutText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#e53935',
  },

  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
