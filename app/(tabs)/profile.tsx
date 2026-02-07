import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../../src/store/authStore';
import { useSettingsStore } from '../../src/store/settingsStore';

export default function Profile() {
  const router = useRouter();
  const { user, logout } = useAuthStore();
  const { settings } = useSettingsStore();

  const handleLogout = () => {
    Alert.alert(
      'Logout',
      'Are you sure you want to logout?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Logout',
          style: 'destructive',
          onPress: async () => {
            await logout();
            router.replace('/(auth)/login');
          },
        },
      ]
    );
  };

  if (!user) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.header}>
          <Text style={styles.title}>Profile</Text>
        </View>
        <View style={styles.emptyContainer}>
          <Ionicons name="person-outline" size={64} color="#ccc" />
          <Text style={styles.emptyText}>Please login to view your profile</Text>
          <TouchableOpacity
            style={styles.loginButton}
            onPress={() => router.push('/(auth)/login')}
          >
            <Text style={styles.loginButtonText}>Login</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const isVerified = user.role === 'verified_retailer' || user.role === 'admin';
  const availableCredit = (user.credit_limit || 0) - (user.credit_used || 0);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Profile</Text>
        {user.role === 'admin' && (
          <TouchableOpacity 
            style={styles.adminButton}
            onPress={() => router.push('/admin')}
          >
            <Ionicons name="settings" size={20} color="#fff" />
            <Text style={styles.adminButtonText}>Admin</Text>
          </TouchableOpacity>
        )}
      </View>

      <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
        {/* Profile Card */}
        <View style={styles.profileCard}>
          <View style={styles.avatarContainer}>
            <Ionicons name="person" size={40} color="#1E88E5" />
          </View>
          <View style={styles.profileInfo}>
            <Text style={styles.name}>{user.name}</Text>
            <Text style={styles.phone}>{user.phone}</Text>
            <View style={[
              styles.roleBadge,
              { backgroundColor: isVerified ? '#E8F5E9' : '#FFF3E0' }
            ]}>
              <Ionicons 
                name={isVerified ? 'checkmark-circle' : 'time'} 
                size={14} 
                color={isVerified ? '#43A047' : '#FFA726'} 
              />
              <Text style={[
                styles.roleText,
                { color: isVerified ? '#43A047' : '#FFA726' }
              ]}>
                {user.role === 'admin' ? 'Admin' : 
                 user.role === 'verified_retailer' ? 'Verified Retailer' : 
                 'Pending Verification'}
              </Text>
            </View>
          </View>
        </View>

        {/* Stats Cards */}
        {isVerified && settings?.features.loyalty_enabled && (
          <View style={styles.statsRow}>
            <View style={styles.statCard}>
              <Ionicons name="star" size={28} color="#FFA726" />
              <Text style={styles.statValue}>{user.loyalty_points || 0}</Text>
              <Text style={styles.statLabel}>Loyalty Points</Text>
            </View>
            {settings?.features.credit_enabled && (
              <View style={styles.statCard}>
                <Ionicons name="wallet" size={28} color="#43A047" />
                <Text style={styles.statValue}>₹{availableCredit.toFixed(0)}</Text>
                <Text style={styles.statLabel}>Credit Available</Text>
              </View>
            )}
          </View>
        )}

        {/* Business Info */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Business Information</Text>
          
          <View style={styles.infoItem}>
            <Ionicons name="business-outline" size={20} color="#666" />
            <View style={styles.infoContent}>
              <Text style={styles.infoLabel}>Business Name</Text>
              <Text style={styles.infoValue}>{user.business_name || 'Not provided'}</Text>
            </View>
          </View>
          
          <View style={styles.infoItem}>
            <Ionicons name="document-text-outline" size={20} color="#666" />
            <View style={styles.infoContent}>
              <Text style={styles.infoLabel}>GSTIN</Text>
              <Text style={styles.infoValue}>{user.gstin || 'Not provided'}</Text>
            </View>
          </View>
          
          <View style={styles.infoItem}>
            <Ionicons name="mail-outline" size={20} color="#666" />
            <View style={styles.infoContent}>
              <Text style={styles.infoLabel}>Email</Text>
              <Text style={styles.infoValue}>{user.email || 'Not provided'}</Text>
            </View>
          </View>
        </View>

        {/* Address */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Address</Text>
          
          <View style={styles.infoItem}>
            <Ionicons name="location-outline" size={20} color="#666" />
            <View style={styles.infoContent}>
              <Text style={styles.infoValue}>
                {user.address || 'No address provided'}
                {user.city && `, ${user.city}`}
                {user.state && `, ${user.state}`}
                {user.pincode && ` - ${user.pincode}`}
              </Text>
            </View>
          </View>
        </View>

        {/* Credit Info (if enabled) */}
        {isVerified && settings?.features.credit_enabled && user.credit_limit > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Credit Details</Text>
            
            <View style={styles.creditBar}>
              <View style={styles.creditBarFill} />
              <View 
                style={[
                  styles.creditBarUsed, 
                  { width: `${(user.credit_used / user.credit_limit) * 100}%` }
                ]} 
              />
            </View>
            
            <View style={styles.creditDetails}>
              <View>
                <Text style={styles.creditLabel}>Used</Text>
                <Text style={styles.creditValue}>₹{user.credit_used?.toFixed(0) || 0}</Text>
              </View>
              <View style={styles.creditDivider} />
              <View>
                <Text style={styles.creditLabel}>Limit</Text>
                <Text style={styles.creditValue}>₹{user.credit_limit?.toFixed(0) || 0}</Text>
              </View>
            </View>
          </View>
        )}

        {/* Logout Button */}
        <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
          <Ionicons name="log-out-outline" size={20} color="#e53935" />
          <Text style={styles.logoutText}>Logout</Text>
        </TouchableOpacity>

        <View style={styles.bottomPadding} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#333',
  },
  adminButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1E88E5',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    gap: 4,
  },
  adminButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  scrollView: {
    flex: 1,
  },
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    margin: 16,
    padding: 20,
    borderRadius: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  avatarContainer: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#e3f2fd',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 16,
  },
  profileInfo: {
    flex: 1,
  },
  name: {
    fontSize: 20,
    fontWeight: '700',
    color: '#333',
  },
  phone: {
    fontSize: 14,
    color: '#666',
    marginTop: 4,
  },
  roleBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    marginTop: 8,
    gap: 4,
  },
  roleText: {
    fontSize: 12,
    fontWeight: '600',
  },
  statsRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    gap: 12,
    marginBottom: 16,
  },
  statCard: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  statValue: {
    fontSize: 24,
    fontWeight: '700',
    color: '#333',
    marginTop: 8,
  },
  statLabel: {
    fontSize: 12,
    color: '#666',
    marginTop: 4,
  },
  section: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginBottom: 16,
    padding: 16,
    borderRadius: 12,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#333',
    marginBottom: 16,
  },
  infoItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 16,
  },
  infoContent: {
    flex: 1,
    marginLeft: 12,
  },
  infoLabel: {
    fontSize: 12,
    color: '#888',
  },
  infoValue: {
    fontSize: 14,
    color: '#333',
    marginTop: 2,
  },
  creditBar: {
    height: 8,
    backgroundColor: '#e0e0e0',
    borderRadius: 4,
    overflow: 'hidden',
    position: 'relative',
  },
  creditBarFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    right: 0,
    backgroundColor: '#43A047',
    borderRadius: 4,
  },
  creditBarUsed: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: '#FFA726',
    borderRadius: 4,
  },
  creditDetails: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 16,
  },
  creditDivider: {
    width: 1,
    height: 30,
    backgroundColor: '#ddd',
    marginHorizontal: 32,
  },
  creditLabel: {
    fontSize: 12,
    color: '#888',
    textAlign: 'center',
  },
  creditValue: {
    fontSize: 18,
    fontWeight: '700',
    color: '#333',
    textAlign: 'center',
    marginTop: 4,
  },
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
    marginHorizontal: 16,
    padding: 16,
    borderRadius: 12,
    gap: 8,
  },
  logoutText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#e53935',
  },
  bottomPadding: {
    height: 40,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 16,
    color: '#888',
    marginTop: 16,
  },
  loginButton: {
    marginTop: 20,
    backgroundColor: '#1E88E5',
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 8,
  },
  loginButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
