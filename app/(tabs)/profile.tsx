import React, { useState, useCallback, useEffect } from 'react';
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
  RefreshControl,
  Switch,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../../src/store/authStore';
import { useSettingsStore } from '../../src/store/settingsStore';
import { supabase } from '../../src/services/supabase';
import { format } from 'date-fns';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { tabScrollBottomPadding } from '../../src/theme/tabBarTheme';
import i18n from '../../src/i18n';
import { useTranslation } from 'react-i18next';

type LoyaltyTransaction = {
  id: string;
  order_id: string | null;
  points: number;
  reason: string;
  type?: string;         // CHANGED: FIX B — earned/redeemed
  created_at: string;
};

type RetailerStats = {
  total_orders: number;
  total_value: number;
  avg_order_value: number;
  pending_count: number;
  credit_limit: number;
  credit_used: number;
  loyalty_points: number;
};

export default function Profile() {
  const router = useRouter();
  const { t } = useTranslation();
  const { user, logout, updateProfile, isLoading, fetchUser } = useAuthStore();
  const [refreshing, setRefreshing] = useState(false);

  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [biometricType, setBiometricType] = useState('');
  const [loginAudit, setLoginAudit] = useState<
    { id: string; event: string; created_at: string }[]
  >([]);
  const [language, setLanguage] = useState('en');

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchUser({ silent: true });
    if (user) {
      fetchLoyaltyHistory();
      fetchStats();
    }
    setRefreshing(false);
  }, [fetchUser, user]);
  const { settings, fetchSettings } = useSettingsStore();
  const [editing, setEditing] = useState(false);

  // Loyalty transaction history
  const [loyaltyTxns, setLoyaltyTxns] = useState<LoyaltyTransaction[]>([]);
  const [loyaltyLoading, setLoyaltyLoading] = useState(false);

  // CHANGED: FIX E — Order stats
  const [stats, setStats] = useState<RetailerStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  // CHANGED: FIX F — Push notification toggle
  const [pushEnabled, setPushEnabled] = useState(true);
  const [pushPermissionDenied, setPushPermissionDenied] = useState(false);

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

  const fetchLoyaltyHistory = useCallback(async () => {
    if (!user) return;
    try {
      setLoyaltyLoading(true);
      const { data, error } = await supabase
        .from('loyalty_transactions')
        .select('id, order_id, points, reason, type, created_at')   // CHANGED: include type
        .eq('retailer_id', user.id)
        .order('created_at', { ascending: false })
        .limit(10);

      if (!error && data) {
        setLoyaltyTxns(data as LoyaltyTransaction[]);
      }
    } catch {} finally {
      setLoyaltyLoading(false);
    }
  }, [user]);

  // CHANGED: FIX E — Fetch retailer stats
  const fetchStats = useCallback(async () => {
    if (!user) return;
    try {
      setStatsLoading(true);
      const { data, error } = await supabase.rpc('get_retailer_stats', {
        p_retailer_id: user.id,
      });
      if (!error && data && Array.isArray(data) && data.length > 0) {
        setStats(data[0] as RetailerStats);
      }
    } catch {} finally {
      setStatsLoading(false);
    }
  }, [user]);

  const supportPhone = settings?.branding?.phone?.trim() || null;

  const fetchLoginAudit = useCallback(async () => {
    if (!user) return;
    try {
      const { data } = await supabase
        .from('login_audit')
        .select('id, event, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(5);
      if (data) setLoginAudit(data);
    } catch {}
  }, [user]);

  useEffect(() => {
    (async () => {
      try {
        const compatible = await LocalAuthentication.hasHardwareAsync();
        const enrolled = await LocalAuthentication.isEnrolledAsync();
        setBiometricAvailable(compatible && enrolled);
        const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
        if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) {
          setBiometricType('Face ID');
        } else if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
          setBiometricType('Fingerprint');
        }
        const stored = await SecureStore.getItemAsync('biometric_enabled');
        setBiometricEnabled(stored === 'true');
      } catch {}
    })();
  }, []);

  useEffect(() => {
    if (user && settings?.features?.loyalty_enabled) {
      fetchLoyaltyHistory();
    }
    if (user) {
      fetchStats();
      fetchProfileExtras();
      fetchLoginAudit();
      void fetchSettings();
    }
  }, [user, settings?.features?.loyalty_enabled, fetchLoyaltyHistory, fetchStats, fetchProfileExtras, fetchLoginAudit, fetchSettings]);

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
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.center}>
          <Text>Please login</Text>
        </View>
      </SafeAreaView>
    );
  }

  const isAdmin = user.role === 'admin';
  const isVerified = isAdmin || user.approved === true;
  const availableCredit = (user.credit_limit || 0) - (user.credit_used || 0);
  const creditLimit = user.credit_limit || 0;
  const creditUsed = user.credit_used || 0;
  const creditPct = creditLimit > 0 ? Math.min((creditUsed / creditLimit) * 100, 100) : 0;
  const barColor = creditPct > 80 ? '#EF5350' : creditPct > 60 ? '#FFA726' : '#4C51C9';

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

  const cancelEditing = () => setEditing(false);

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

  // CHANGED: FIX F — Toggle push notifications
  const togglePush = async (val: boolean) => {
    setPushEnabled(val);
    try {
      await supabase
        .from('profiles')
        .update({ push_enabled: val })
        .eq('id', user.id);
    } catch {}
  };

  const toggleBiometric = async (val: boolean) => {
    if (val) {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: `Enable ${biometricType || 'Biometric'} Login`,
      });
      if (!result.success) return;
      await SecureStore.setItemAsync('biometric_enabled', 'true');
      setBiometricEnabled(true);
      Alert.alert('Enabled', `${biometricType || 'Biometric'} login enabled`);
    } else {
      await SecureStore.deleteItemAsync('biometric_enabled');
      await SecureStore.deleteItemAsync('biometric_credentials');
      setBiometricEnabled(false);
    }
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
        <Ionicons name={icon} size={18} color="#4C51C9" />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.infoLabel}>{label}</Text>
        <Text style={styles.infoValue}>{value || '—'}</Text>
      </View>
    </View>
  );

  // CHANGED: FIX B — map reason labels
  const getReasonLabel = (txn: LoyaltyTransaction) => {
    if (txn.type === 'redeemed') return 'Redeemed at Checkout';
    if (txn.reason === 'order_delivered') return 'Order Delivered';
    return txn.reason || 'Points';
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Profile</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {isAdmin && (
            <TouchableOpacity style={styles.adminBtn} onPress={() => router.push('/admin')}>
              <Ionicons name="settings" size={18} color="#fff" />
              <Text style={styles.adminText}>Admin</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={tabScrollBottomPadding()}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        >
          {/* Profile Card */}
          <View style={styles.card}>
            <Ionicons name="person-circle" size={72} color="#4C51C9" />
            <Text style={styles.name}>{user.name}</Text>
            <Text style={styles.phone}>{user.phone}</Text>
            <View
              style={[styles.badge, { backgroundColor: isVerified ? '#E8F5E9' : '#FFF3E0' }]}
            >
              <Ionicons
                name={isVerified ? 'checkmark-circle' : 'time'}
                size={14}
                color={isVerified ? '#43A047' : '#FFA726'}
              />
              <Text style={{ color: isVerified ? '#43A047' : '#FFA726', fontWeight: '600', fontSize: 12 }}>
                {isAdmin ? 'Admin' : isVerified ? 'Verified Retailer' : 'Pending Verification'}
              </Text>
            </View>
          </View>

          {/* CHANGED: FIX E — Credit Limit Bar (same as cart.tsx) */}
          {isVerified && creditLimit > 0 && settings?.features?.credit_enabled && (
            <View style={styles.creditBar}>
              <View style={styles.creditBarHeader}>
                <Ionicons name="wallet-outline" size={16} color="#4C51C9" />
                <Text style={styles.creditBarLabel}>
                  Credit: ₹{creditUsed.toFixed(0)} of ₹{creditLimit.toFixed(0)} used
                </Text>
              </View>
              <View style={styles.creditTrack}>
                <View style={[styles.creditFill, { width: `${creditPct}%` as any, backgroundColor: barColor }]} />
              </View>
              <Text style={styles.creditRemaining}>₹{availableCredit.toFixed(0)} remaining</Text>
            </View>
          )}

          {/* Loyalty & Credit Quick Stats */}
          {isVerified && settings?.features?.loyalty_enabled && (
            <View style={styles.statsRow}>
              <View style={styles.stat}>
                <Ionicons name="star" size={24} color="#FFA726" />
                <Text style={styles.statValue}>{user.loyalty_points || 0}</Text>
                <Text style={styles.statLabel}>Points</Text>
              </View>
              {settings?.features.credit_enabled && (
                <View style={styles.stat}>
                  <Ionicons name="wallet" size={24} color="#43A047" />
                  <Text style={styles.statValue}>₹{availableCredit.toFixed(0)}</Text>
                  <Text style={styles.statLabel}>Credit Available</Text>
                </View>
              )}
            </View>
          )}

          {/* CHANGED: FIX E — Order Statistics */}
          {isVerified && stats && (
            <View style={styles.orderStatsCard}>
              <Text style={styles.orderStatsTitle}>Order Statistics</Text>
              <View style={styles.orderStatsGrid}>
                <View style={styles.orderStatItem}>
                  <Text style={styles.orderStatNum}>{stats.total_orders}</Text>
                  <Text style={styles.orderStatLabel}>Total Orders</Text>
                </View>
                <View style={styles.orderStatItem}>
                  <Text style={styles.orderStatNum}>₹{(stats.total_value || 0).toFixed(0)}</Text>
                  <Text style={styles.orderStatLabel}>Total Value</Text>
                </View>
                <View style={styles.orderStatItem}>
                  <Text style={styles.orderStatNum}>₹{(stats.avg_order_value || 0).toFixed(0)}</Text>
                  <Text style={styles.orderStatLabel}>Avg Order</Text>
                </View>
                <View style={styles.orderStatItem}>
                  <Text style={[styles.orderStatNum, { color: '#FFA726' }]}>{stats.pending_count}</Text>
                  <Text style={styles.orderStatLabel}>Pending</Text>
                </View>
              </View>
            </View>
          )}

          {/* Loyalty Points Section — CHANGED: FIX B — Shows earned + redeemed */}
          {isVerified && settings?.features?.loyalty_enabled && (
            <View style={styles.loyaltyCard}>
              <View style={styles.loyaltyHeader}>
                <Ionicons name="star" size={20} color="#FFA726" />
                <Text style={styles.loyaltyTitle}>
                  {user.loyalty_points || 0} Loyalty Points
                </Text>
              </View>

              {/* CHANGED: FIX B — Redeem hint */}
              {(user.loyalty_points ?? 0) > 0 && (
                <View style={styles.loyaltyInfoRow}>
                  <Ionicons name="gift-outline" size={16} color="#4C51C9" />
                  <Text style={styles.loyaltyInfoText}>
                    Redeem at checkout for discounts on your orders
                  </Text>
                </View>
              )}

              <View style={styles.loyaltyInfoRow}>
                <Ionicons name="information-circle-outline" size={16} color="#888" />
                <Text style={styles.loyaltyInfoText}>Earn 1 point for every ₹100 ordered</Text>
              </View>

              {loyaltyLoading ? (
                <ActivityIndicator size="small" color="#4C51C9" style={{ marginTop: 8 }} />
              ) : loyaltyTxns.length > 0 ? (
                <View style={styles.loyaltyList}>
                  <Text style={styles.loyaltyListTitle}>Recent Activity</Text>
                  {loyaltyTxns.map((txn) => (
                    <View key={txn.id} style={styles.loyaltyTxnRow}>
                      <View style={styles.loyaltyTxnLeft}>
                        <Ionicons
                          name={txn.points > 0 ? 'add-circle' : 'remove-circle'}
                          size={16}
                          color={txn.points > 0 ? '#43A047' : '#EF5350'}
                        />
                        <View>
                          <Text style={styles.loyaltyTxnReason}>{getReasonLabel(txn)}</Text>
                          <Text style={styles.loyaltyTxnDate}>
                            {format(new Date(txn.created_at), 'dd MMM yyyy')}
                          </Text>
                        </View>
                      </View>
                      {/* CHANGED: FIX B — Redeemed rows show negative in red */}
                      <Text style={[
                        styles.loyaltyTxnPoints,
                        { color: txn.points > 0 ? '#43A047' : '#EF5350' },
                      ]}>
                        {txn.points > 0 ? '+' : ''}{txn.points}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : (
                <Text style={styles.loyaltyEmpty}>No transactions yet</Text>
              )}
            </View>
          )}

          {/* CHANGED: FIX F — Push Notifications Toggle */}
          <View style={styles.pushCard}>
            <View style={styles.pushRow}>
              <View style={styles.pushLeft}>
                <Ionicons name="notifications-outline" size={20} color="#4C51C9" />
                <Text style={styles.pushLabel}>Push Notifications</Text>
              </View>
              <Switch
                value={pushEnabled}
                onValueChange={togglePush}
                trackColor={{ false: '#ddd', true: '#A5D6A7' }}
                thumbColor={pushEnabled ? '#43A047' : '#ccc'}
              />
            </View>
            {pushPermissionDenied && (
              <Text style={styles.pushHint}>
                Permission denied. Re-enable in your device settings.
              </Text>
            )}
          </View>

          {biometricAvailable && (
            <View style={styles.pushCard}>
              <View style={styles.pushRow}>
                <View style={styles.pushLeft}>
                  <Ionicons name="finger-print-outline" size={20} color="#4C51C9" />
                  <Text style={styles.pushLabel}>
                    {t('profile.enableBiometric', { defaultValue: `${biometricType || 'Biometric'} Login` })}
                  </Text>
                </View>
                <Switch
                  value={biometricEnabled}
                  onValueChange={toggleBiometric}
                  trackColor={{ false: '#ddd', true: '#A5D6A7' }}
                  thumbColor={biometricEnabled ? '#43A047' : '#ccc'}
                />
              </View>
            </View>
          )}

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

          {loginAudit.length > 0 && (
            <View style={styles.pushCard}>
              <Text style={[styles.pushLabel, { marginBottom: 12 }]}>
                {t('profile.recentLogins')}
              </Text>
              {loginAudit.map((evt) => (
                <View key={evt.id} style={styles.auditRow}>
                  <Ionicons
                    name={
                      evt.event === 'login'
                        ? 'log-in-outline'
                        : evt.event === 'logout'
                          ? 'log-out-outline'
                          : 'key-outline'
                    }
                    size={16}
                    color="#888"
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.auditEvent}>
                      {evt.event === 'login'
                        ? t('profile.loggedIn')
                        : evt.event === 'logout'
                          ? t('profile.loggedOut')
                          : evt.event === 'password_reset'
                            ? t('profile.passwordReset')
                            : t('profile.failedLogin')}
                    </Text>
                    <Text style={styles.auditDate}>
                      {format(new Date(evt.created_at), 'dd MMM yyyy, hh:mm a')}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          )}

          {/* User Details Section */}
          <View style={styles.detailsCard}>
            <View style={styles.detailsHeader}>
              <Text style={styles.detailsTitle}>My Details</Text>
              {!editing ? (
                <TouchableOpacity style={styles.editBtn} onPress={startEditing}>
                  <Ionicons name="create-outline" size={16} color="#4C51C9" />
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
                <View style={styles.sectionDivider}>
                  <Text style={styles.sectionLabel}>Business</Text>
                </View>
                <InfoRow icon="business-outline" label="Business Name" value={user.business_name} />
                <InfoRow icon="document-text-outline" label="GSTIN" value={user.gstin} />
                <View style={styles.sectionDivider}>
                  <Text style={styles.sectionLabel}>Address</Text>
                </View>
                <InfoRow icon="location-outline" label="Address" value={user.address} />
                <InfoRow icon="map-outline" label="City" value={user.city} />
                <InfoRow icon="flag-outline" label="State" value={user.state} />
                <InfoRow icon="navigate-outline" label="Pincode" value={user.pincode} />
              </View>
            ) : (
              <View style={styles.editForm}>
                <Text style={styles.formSection}>Account Details</Text>
                <TextInput style={styles.input} placeholder="Full Name *" placeholderTextColor="#999" value={formData.name} onChangeText={(v) => updateField('name', v)} />
                <TextInput style={styles.input} placeholder="Email" placeholderTextColor="#999" value={formData.email} onChangeText={(v) => updateField('email', v)} keyboardType="email-address" autoCapitalize="none" />
                <Text style={styles.formSection}>Business Details</Text>
                <TextInput style={styles.input} placeholder="Business Name" placeholderTextColor="#999" value={formData.business_name} onChangeText={(v) => updateField('business_name', v)} />
                <TextInput style={styles.input} placeholder="GSTIN" placeholderTextColor="#999" value={formData.gstin} onChangeText={(v) => updateField('gstin', v)} autoCapitalize="characters" maxLength={15} />
                <Text style={styles.formSection}>Address</Text>
                <TextInput style={[styles.input, styles.multilineInput]} placeholder="Address" placeholderTextColor="#999" value={formData.address} onChangeText={(v) => updateField('address', v)} multiline numberOfLines={2} />
                <View style={styles.row}>
                  <TextInput style={[styles.input, styles.halfInput]} placeholder="City" placeholderTextColor="#999" value={formData.city} onChangeText={(v) => updateField('city', v)} />
                  <TextInput style={[styles.input, styles.halfInput]} placeholder="State" placeholderTextColor="#999" value={formData.state} onChangeText={(v) => updateField('state', v)} />
                </View>
                <TextInput style={styles.input} placeholder="Pincode" placeholderTextColor="#999" value={formData.pincode} onChangeText={(v) => updateField('pincode', v)} keyboardType="number-pad" maxLength={6} />
              </View>
            )}
          </View>

          {/* CHANGED: FIX E — Contact Support */}
          {supportPhone && (
            <TouchableOpacity
              style={styles.supportBtn}
              onPress={() => {
                const url = `https://wa.me/${supportPhone.replace(/[^0-9]/g, '')}`;
                Linking.openURL(url).catch(() => {
                  Linking.openURL(`tel:${supportPhone}`).catch(() => {});
                });
              }}
            >
              <Ionicons name="chatbubble-ellipses-outline" size={20} color="#43A047" />
              <Text style={styles.supportText}>Contact Support</Text>
            </TouchableOpacity>
          )}

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
  header: { padding: 16, backgroundColor: '#fff', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#eee' },
  title: { fontSize: 22, fontWeight: '700' },
  adminBtn: { flexDirection: 'row', backgroundColor: '#4C51C9', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, gap: 6 },
  adminText: { color: '#fff', fontWeight: '600' },
  card: { backgroundColor: '#fff', margin: 16, padding: 20, borderRadius: 16, alignItems: 'center' },
  name: { fontSize: 20, fontWeight: '700', marginTop: 8 },
  phone: { fontSize: 14, color: '#666', marginBottom: 12 },
  badge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, gap: 6 },
  statsRow: { flexDirection: 'row', paddingHorizontal: 16, gap: 12 },
  stat: { flex: 1, backgroundColor: '#fff', borderRadius: 12, padding: 16, alignItems: 'center' },
  statValue: { fontSize: 20, fontWeight: '700', marginTop: 6 },
  statLabel: { fontSize: 12, color: '#666', marginTop: 2 },
  detailsCard: { backgroundColor: '#fff', marginHorizontal: 16, marginTop: 16, borderRadius: 16, padding: 16 },
  detailsHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  detailsTitle: { fontSize: 17, fontWeight: '700', color: '#333' },
  editBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: '#ECEDFB' },
  editBtnText: { color: '#4C51C9', fontSize: 13, fontWeight: '600' },
  cancelEditBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: '#ddd' },
  cancelEditText: { color: '#666', fontSize: 13, fontWeight: '600' },
  saveBtn: { paddingHorizontal: 16, paddingVertical: 6, borderRadius: 8, backgroundColor: '#4C51C9', minWidth: 60, alignItems: 'center' },
  saveBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  infoList: { gap: 0 },
  infoRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#f5f5f5' },
  infoIcon: { width: 36, height: 36, borderRadius: 10, backgroundColor: '#ECEDFB', alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  infoLabel: { fontSize: 11, color: '#999', marginBottom: 1 },
  infoValue: { fontSize: 14, color: '#333', fontWeight: '500' },
  sectionDivider: { marginTop: 12, marginBottom: 4 },
  sectionLabel: { fontSize: 12, fontWeight: '600', color: '#4C51C9', textTransform: 'uppercase', letterSpacing: 0.5 },
  editForm: { gap: 10 },
  formSection: { fontSize: 13, fontWeight: '600', color: '#4C51C9', marginTop: 8, marginBottom: 2 },
  input: { backgroundColor: '#f5f5f5', borderRadius: 10, paddingHorizontal: 14, height: 48, fontSize: 15, color: '#333' },
  multilineInput: { height: 72, paddingTop: 12, textAlignVertical: 'top' },
  row: { flexDirection: 'row', gap: 10 },
  halfInput: { flex: 1 },
  logoutBtn: { margin: 16, backgroundColor: '#fff', padding: 16, borderRadius: 12, flexDirection: 'row', justifyContent: 'center', gap: 8 },
  logoutText: { fontSize: 16, fontWeight: '600', color: '#e53935' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  /* Credit bar */
  creditBar: { backgroundColor: '#fff', marginHorizontal: 16, marginBottom: 12, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12 },
  creditBarHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  creditBarLabel: { fontSize: 13, fontWeight: '600', color: '#333' },
  creditTrack: { height: 6, backgroundColor: '#E8E8E8', borderRadius: 3, overflow: 'hidden' },
  creditFill: { height: '100%', borderRadius: 3 },
  creditRemaining: { fontSize: 11, color: '#888', marginTop: 4 },

  /* Loyalty card */
  loyaltyCard: { backgroundColor: '#fff', marginHorizontal: 16, marginTop: 16, borderRadius: 16, padding: 16 },
  loyaltyHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  loyaltyTitle: { fontSize: 17, fontWeight: '700', color: '#333' },
  loyaltyInfoRow: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#FFF8E1', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, marginBottom: 8 },
  loyaltyInfoText: { fontSize: 12, color: '#8D6E63' },
  loyaltyList: { borderTopWidth: 1, borderTopColor: '#f0f0f0', paddingTop: 10 },
  loyaltyListTitle: { fontSize: 13, fontWeight: '600', color: '#888', marginBottom: 8 },
  loyaltyTxnRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f5f5f5' },
  loyaltyTxnLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  loyaltyTxnReason: { fontSize: 13, fontWeight: '500', color: '#333' },
  loyaltyTxnDate: { fontSize: 11, color: '#aaa', marginTop: 1 },
  loyaltyTxnPoints: { fontSize: 15, fontWeight: '700' },
  loyaltyEmpty: { fontSize: 13, color: '#999', fontStyle: 'italic', textAlign: 'center', marginTop: 8 },

  /* Order stats */
  orderStatsCard: { backgroundColor: '#fff', marginHorizontal: 16, marginTop: 16, borderRadius: 16, padding: 16 },
  orderStatsTitle: { fontSize: 16, fontWeight: '700', color: '#333', marginBottom: 12 },
  orderStatsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  orderStatItem: { width: '47%', backgroundColor: '#f9f9f9', borderRadius: 10, padding: 12, alignItems: 'center' },
  orderStatNum: { fontSize: 18, fontWeight: '700', color: '#333' },
  orderStatLabel: { fontSize: 11, color: '#888', marginTop: 2 },

  /* Push notifications */
  pushCard: { backgroundColor: '#fff', marginHorizontal: 16, marginTop: 16, borderRadius: 16, padding: 16 },
  pushRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  pushLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  pushLabel: { fontSize: 15, fontWeight: '600', color: '#333' },
  pushHint: { fontSize: 12, color: '#999', marginTop: 8, fontStyle: 'italic' },

  /* Support */
  supportBtn: { marginHorizontal: 16, marginTop: 16, backgroundColor: '#E8F5E9', padding: 16, borderRadius: 12, flexDirection: 'row', justifyContent: 'center', gap: 8 },
  supportText: { fontSize: 15, fontWeight: '600', color: '#43A047' },
  langBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#f5f5f5',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  langBtnActive: { backgroundColor: '#4C51C9', borderColor: '#4C51C9' },
  langText: { fontSize: 14, fontWeight: '600', color: '#666' },
  langTextActive: { color: '#fff' },
  auditRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f5f5f5',
  },
  auditEvent: { fontSize: 13, fontWeight: '500', color: '#333' },
  auditDate: { fontSize: 11, color: '#aaa', marginTop: 1 },
});
