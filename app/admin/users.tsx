import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  Alert,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { User, UserRole } from '../../src/types';
import api from '../../src/services/api';

const roleFilters: { key: UserRole | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unverified_retailer', label: 'Unverified' },
  { key: 'verified_retailer', label: 'Verified' },
  { key: 'admin', label: 'Admin' },
];

export default function AdminUsers() {
  const [users, setUsers] = useState<User[]>([]);
  const [selectedRole, setSelectedRole] = useState<UserRole | 'all'>('all');
  const [search, setSearch] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchUsers = async () => {
    try {
      setLoading(true);
      let url = '/admin/users?limit=100';
      if (selectedRole !== 'all') url += `&role=${selectedRole}`;
      if (search) url += `&search=${search}`;
      
      const response = await api.get(url);
      setUsers(response.data);
    } catch (error) {
      console.error('Error fetching users:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const debounce = setTimeout(fetchUsers, 300);
    return () => clearTimeout(debounce);
  }, [selectedRole, search]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchUsers();
    setRefreshing(false);
  }, [selectedRole, search]);

  const handleVerify = (user: User) => {
    Alert.alert(
      'Verify User',
      `Are you sure you want to verify ${user.name}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Verify',
          onPress: async () => {
            try {
              await api.post(`/admin/users/${user.id}/verify`);
              Alert.alert('Success', 'User has been verified');
              fetchUsers();
            } catch (error: any) {
              Alert.alert('Error', error.response?.data?.detail || 'Failed to verify user');
            }
          },
        },
      ]
    );
  };

  const handleSetCreditLimit = (user: User) => {
    Alert.prompt(
      'Set Credit Limit',
      `Enter credit limit for ${user.name}:`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Set',
          onPress: async (value) => {
            const amount = parseFloat(value || '0');
            if (isNaN(amount) || amount < 0) {
              Alert.alert('Error', 'Please enter a valid amount');
              return;
            }
            try {
              await api.post(`/admin/users/${user.id}/credit?amount=${amount}&action=set_limit`);
              Alert.alert('Success', 'Credit limit updated');
              fetchUsers();
            } catch (error: any) {
              Alert.alert('Error', error.response?.data?.detail || 'Failed to update credit limit');
            }
          },
        },
      ],
      'plain-text',
      String(user.credit_limit || 0)
    );
  };

  const renderUser = ({ item }: { item: User }) => {
    const isUnverified = item.role === 'unverified_retailer';
    const isVerified = item.role === 'verified_retailer';
    
    return (
      <View style={styles.userCard}>
        <View style={styles.userHeader}>
          <View style={styles.userAvatar}>
            <Ionicons name="person" size={24} color="#1E88E5" />
          </View>
          <View style={styles.userInfo}>
            <Text style={styles.userName}>{item.name}</Text>
            <Text style={styles.userPhone}>{item.phone}</Text>
            {item.business_name && (
              <Text style={styles.userBusiness}>{item.business_name}</Text>
            )}
          </View>
          <View style={[
            styles.roleBadge,
            {
              backgroundColor: isUnverified ? '#FFF3E0' : 
                              isVerified ? '#E8F5E9' : '#E3F2FD'
            }
          ]}>
            <Text style={[
              styles.roleText,
              {
                color: isUnverified ? '#FFA726' : 
                       isVerified ? '#43A047' : '#1E88E5'
              }
            ]}>
              {isUnverified ? 'Unverified' : isVerified ? 'Verified' : 'Admin'}
            </Text>
          </View>
        </View>
        
        <View style={styles.userDetails}>
          <View style={styles.detailItem}>
            <Text style={styles.detailLabel}>Credit Limit</Text>
            <Text style={styles.detailValue}>₹{item.credit_limit?.toFixed(0) || 0}</Text>
          </View>
          <View style={styles.detailItem}>
            <Text style={styles.detailLabel}>Credit Used</Text>
            <Text style={styles.detailValue}>₹{item.credit_used?.toFixed(0) || 0}</Text>
          </View>
          <View style={styles.detailItem}>
            <Text style={styles.detailLabel}>Points</Text>
            <Text style={styles.detailValue}>{item.loyalty_points || 0}</Text>
          </View>
        </View>
        
        <View style={styles.userActions}>
          {isUnverified && (
            <TouchableOpacity 
              style={[styles.actionBtn, { backgroundColor: '#43A047' }]}
              onPress={() => handleVerify(item)}
            >
              <Ionicons name="checkmark" size={16} color="#fff" />
              <Text style={styles.actionBtnText}>Verify</Text>
            </TouchableOpacity>
          )}
          
          {item.role !== 'admin' && (
            <TouchableOpacity 
              style={[styles.actionBtn, { backgroundColor: '#1E88E5' }]}
              onPress={() => handleSetCreditLimit(item)}
            >
              <Ionicons name="wallet" size={16} color="#fff" />
              <Text style={styles.actionBtnText}>Set Credit</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      {/* Search */}
      <View style={styles.searchContainer}>
        <Ionicons name="search" size={20} color="#666" />
        <TextInput
          style={styles.searchInput}
          placeholder="Search by name, phone, or business..."
          value={search}
          onChangeText={setSearch}
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => setSearch('')}>
            <Ionicons name="close-circle" size={20} color="#666" />
          </TouchableOpacity>
        )}
      </View>

      {/* Filter */}
      <View style={styles.filterContainer}>
        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          data={roleFilters}
          keyExtractor={(item) => item.key}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[
                styles.filterChip,
                selectedRole === item.key && styles.filterChipActive,
              ]}
              onPress={() => setSelectedRole(item.key)}
            >
              <Text
                style={[
                  styles.filterChipText,
                  selectedRole === item.key && styles.filterChipTextActive,
                ]}
              >
                {item.label}
              </Text>
            </TouchableOpacity>
          )}
        />
      </View>

      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#1E88E5" />
        </View>
      ) : (
        <FlatList
          data={users}
          keyExtractor={(item) => item.id}
          renderItem={renderUser}
          contentContainerStyle={styles.userList}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Ionicons name="people-outline" size={64} color="#ccc" />
              <Text style={styles.emptyText}>No users found</Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginTop: 16,
    paddingHorizontal: 16,
    borderRadius: 12,
    height: 48,
  },
  searchInput: {
    flex: 1,
    marginLeft: 12,
    fontSize: 16,
    color: '#333',
  },
  filterContainer: {
    paddingVertical: 12,
    paddingLeft: 16,
  },
  filterChip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#fff',
    borderRadius: 20,
    marginRight: 8,
    borderWidth: 1,
    borderColor: '#ddd',
  },
  filterChipActive: {
    backgroundColor: '#1E88E5',
    borderColor: '#1E88E5',
  },
  filterChipText: {
    fontSize: 14,
    color: '#666',
  },
  filterChipTextActive: {
    color: '#fff',
    fontWeight: '600',
  },
  userList: {
    padding: 16,
  },
  userCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  userHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  userAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#e3f2fd',
    alignItems: 'center',
    justifyContent: 'center',
  },
  userInfo: {
    flex: 1,
    marginLeft: 12,
  },
  userName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
  },
  userPhone: {
    fontSize: 13,
    color: '#666',
  },
  userBusiness: {
    fontSize: 12,
    color: '#888',
  },
  roleBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  roleText: {
    fontSize: 12,
    fontWeight: '600',
  },
  userDetails: {
    flexDirection: 'row',
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#eee',
  },
  detailItem: {
    flex: 1,
    alignItems: 'center',
  },
  detailLabel: {
    fontSize: 11,
    color: '#888',
  },
  detailValue: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
    marginTop: 4,
  },
  userActions: {
    flexDirection: 'row',
    marginTop: 12,
    gap: 8,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 4,
  },
  actionBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 60,
  },
  emptyText: {
    fontSize: 16,
    color: '#888',
    marginTop: 16,
  },
});
