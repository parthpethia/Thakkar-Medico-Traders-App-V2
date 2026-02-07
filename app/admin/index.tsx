// import React, { useEffect, useState, useCallback } from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   ScrollView,
//   TouchableOpacity,
//   RefreshControl,
//   ActivityIndicator,
// } from 'react-native';
// import { SafeAreaView } from 'react-native-safe-area-context';
// import { useRouter } from 'expo-router';
// import { Ionicons } from '@expo/vector-icons';
// import { useAuthStore } from '../../src/store/authStore';
// import { AdminDashboard } from '../../src/types';
// import api from '../../src/services/api';

// export default function AdminHome() {
//   const router = useRouter();
//   const { user, logout } = useAuthStore();
  
//   const [dashboard, setDashboard] = useState<AdminDashboard | null>(null);
//   const [refreshing, setRefreshing] = useState(false);
//   const [loading, setLoading] = useState(true);

//   const fetchDashboard = async () => {
//     try {
//       const response = await api.get('/admin/dashboard');
//       setDashboard(response.data);
//     } catch (error) {
//       console.error('Error fetching dashboard:', error);
//     } finally {
//       setLoading(false);
//     }
//   };

//   useEffect(() => {
//     if (user?.role === 'admin') {
//       fetchDashboard();
//     } else {
//       router.replace('/');
//     }
//   }, [user]);

//   const onRefresh = useCallback(async () => {
//     setRefreshing(true);
//     await fetchDashboard();
//     setRefreshing(false);
//   }, []);

//   const handleLogout = async () => {
//     await logout();
//     router.replace('/(auth)/login');
//   };

//   if (loading) {
//     return (
//       <SafeAreaView style={styles.container}>
//         <View style={styles.loadingContainer}>
//           <ActivityIndicator size="large" color="#1E88E5" />
//         </View>
//       </SafeAreaView>
//     );
//   }

//   return (
//     <SafeAreaView style={styles.container} edges={['bottom']}>
//       <ScrollView
//         style={styles.scrollView}
//         showsVerticalScrollIndicator={false}
//         refreshControl={
//           <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
//         }
//       >
//         {/* Header */}
//         <View style={styles.header}>
//           <View>
//             <Text style={styles.welcomeText}>Welcome, Admin</Text>
//             <Text style={styles.userName}>{user?.name}</Text>
//           </View>
//           <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
//             <Ionicons name="log-out-outline" size={24} color="#e53935" />
//           </TouchableOpacity>
//         </View>

//         {/* Stats Grid */}
//         <View style={styles.statsGrid}>
//           <View style={[styles.statCard, { backgroundColor: '#E3F2FD' }]}>
//             <Ionicons name="cart" size={32} color="#1E88E5" />
//             <Text style={styles.statValue}>{dashboard?.today_orders || 0}</Text>
//             <Text style={styles.statLabel}>Today's Orders</Text>
//           </View>
          
//           <View style={[styles.statCard, { backgroundColor: '#E8F5E9' }]}>
//             <Ionicons name="cash" size={32} color="#43A047" />
//             <Text style={styles.statValue}>₹{(dashboard?.today_revenue || 0).toFixed(0)}</Text>
//             <Text style={styles.statLabel}>Today's Revenue</Text>
//           </View>
          
//           <View style={[styles.statCard, { backgroundColor: '#FFF3E0' }]}>
//             <Ionicons name="time" size={32} color="#FFA726" />
//             <Text style={styles.statValue}>{dashboard?.pending_orders || 0}</Text>
//             <Text style={styles.statLabel}>Pending Orders</Text>
//           </View>
          
//           <View style={[styles.statCard, { backgroundColor: '#FCE4EC' }]}>
//             <Ionicons name="alert-circle" size={32} color="#EC407A" />
//             <Text style={styles.statValue}>{dashboard?.low_stock_products || 0}</Text>
//             <Text style={styles.statLabel}>Low Stock Items</Text>
//           </View>
//         </View>

//         {/* User Stats */}
//         <View style={styles.section}>
//           <Text style={styles.sectionTitle}>User Overview</Text>
//           <View style={styles.userStats}>
//             <View style={styles.userStatItem}>
//               <Ionicons name="people" size={24} color="#1E88E5" />
//               <Text style={styles.userStatValue}>{dashboard?.total_users || 0}</Text>
//               <Text style={styles.userStatLabel}>Total Users</Text>
//             </View>
//             <View style={styles.divider} />
//             <View style={styles.userStatItem}>
//               <Ionicons name="hourglass" size={24} color="#FFA726" />
//               <Text style={styles.userStatValue}>{dashboard?.unverified_users || 0}</Text>
//               <Text style={styles.userStatLabel}>Pending Verification</Text>
//             </View>
//             <View style={styles.divider} />
//             <View style={styles.userStatItem}>
//               <Ionicons name="cube" size={24} color="#43A047" />
//               <Text style={styles.userStatValue}>{dashboard?.total_products || 0}</Text>
//               <Text style={styles.userStatLabel}>Total Products</Text>
//             </View>
//           </View>
//         </View>

//         {/* Quick Actions */}
//         <View style={styles.section}>
//           <Text style={styles.sectionTitle}>Quick Actions</Text>
          
//           <TouchableOpacity 
//             style={styles.actionCard}
//             onPress={() => router.push('/admin/users')}
//           >
//             <View style={[styles.actionIcon, { backgroundColor: '#E3F2FD' }]}>
//               <Ionicons name="people" size={24} color="#1E88E5" />
//             </View>
//             <View style={styles.actionContent}>
//               <Text style={styles.actionTitle}>User Management</Text>
//               <Text style={styles.actionSubtitle}>Verify & manage retailer accounts</Text>
//             </View>
//             <Ionicons name="chevron-forward" size={20} color="#999" />
//           </TouchableOpacity>
          
//           <TouchableOpacity 
//             style={styles.actionCard}
//             onPress={() => router.push('/admin/products')}
//           >
//             <View style={[styles.actionIcon, { backgroundColor: '#E8F5E9' }]}>
//               <Ionicons name="cube" size={24} color="#43A047" />
//             </View>
//             <View style={styles.actionContent}>
//               <Text style={styles.actionTitle}>Product Management</Text>
//               <Text style={styles.actionSubtitle}>Add, edit & manage products</Text>
//             </View>
//             <Ionicons name="chevron-forward" size={20} color="#999" />
//           </TouchableOpacity>
          
//           <TouchableOpacity 
//             style={styles.actionCard}
//             onPress={() => router.push('/admin/orders')}
//           >
//             <View style={[styles.actionIcon, { backgroundColor: '#FFF3E0' }]}>
//               <Ionicons name="receipt" size={24} color="#FFA726" />
//             </View>
//             <View style={styles.actionContent}>
//               <Text style={styles.actionTitle}>Order Management</Text>
//               <Text style={styles.actionSubtitle}>Process & track orders</Text>
//             </View>
//             <Ionicons name="chevron-forward" size={20} color="#999" />
//           </TouchableOpacity>
          
//           <TouchableOpacity 
//             style={styles.actionCard}
//             onPress={() => router.push('/admin/settings')}
//           >
//             <View style={[styles.actionIcon, { backgroundColor: '#F3E5F5' }]}>
//               <Ionicons name="settings" size={24} color="#9C27B0" />
//             </View>
//             <View style={styles.actionContent}>
//               <Text style={styles.actionTitle}>Settings</Text>
//               <Text style={styles.actionSubtitle}>Configure app settings & branding</Text>
//             </View>
//             <Ionicons name="chevron-forward" size={20} color="#999" />
//           </TouchableOpacity>

//           <TouchableOpacity 
//             style={styles.actionCard}
//             onPress={() => router.push('/(tabs)')}
//           >
//             <View style={[styles.actionIcon, { backgroundColor: '#E0F7FA' }]}>
//               <Ionicons name="storefront" size={24} color="#00ACC1" />
//             </View>
//             <View style={styles.actionContent}>
//               <Text style={styles.actionTitle}>View Store</Text>
//               <Text style={styles.actionSubtitle}>See app as a retailer</Text>
//             </View>
//             <Ionicons name="chevron-forward" size={20} color="#999" />
//           </TouchableOpacity>
//         </View>

//         <View style={styles.bottomPadding} />
//       </ScrollView>
//     </SafeAreaView>
//   );
// }

// const styles = StyleSheet.create({
//   container: {
//     flex: 1,
//     backgroundColor: '#f5f5f5',
//   },
//   loadingContainer: {
//     flex: 1,
//     justifyContent: 'center',
//     alignItems: 'center',
//   },
//   scrollView: {
//     flex: 1,
//   },
//   header: {
//     flexDirection: 'row',
//     justifyContent: 'space-between',
//     alignItems: 'center',
//     padding: 20,
//     backgroundColor: '#fff',
//   },
//   welcomeText: {
//     fontSize: 14,
//     color: '#666',
//   },
//   userName: {
//     fontSize: 20,
//     fontWeight: '700',
//     color: '#333',
//   },
//   logoutBtn: {
//     padding: 8,
//   },
//   statsGrid: {
//     flexDirection: 'row',
//     flexWrap: 'wrap',
//     padding: 12,
//     gap: 12,
//   },
//   statCard: {
//     width: '47%',
//     padding: 20,
//     borderRadius: 16,
//     alignItems: 'center',
//   },
//   statValue: {
//     fontSize: 24,
//     fontWeight: '700',
//     color: '#333',
//     marginTop: 12,
//   },
//   statLabel: {
//     fontSize: 12,
//     color: '#666',
//     marginTop: 4,
//   },
//   section: {
//     padding: 16,
//   },
//   sectionTitle: {
//     fontSize: 18,
//     fontWeight: '700',
//     color: '#333',
//     marginBottom: 16,
//   },
//   userStats: {
//     flexDirection: 'row',
//     backgroundColor: '#fff',
//     borderRadius: 16,
//     padding: 20,
//   },
//   userStatItem: {
//     flex: 1,
//     alignItems: 'center',
//   },
//   userStatValue: {
//     fontSize: 20,
//     fontWeight: '700',
//     color: '#333',
//     marginTop: 8,
//   },
//   userStatLabel: {
//     fontSize: 11,
//     color: '#888',
//     marginTop: 4,
//     textAlign: 'center',
//   },
//   divider: {
//     width: 1,
//     backgroundColor: '#eee',
//     marginHorizontal: 8,
//   },
//   actionCard: {
//     flexDirection: 'row',
//     alignItems: 'center',
//     backgroundColor: '#fff',
//     padding: 16,
//     borderRadius: 12,
//     marginBottom: 12,
//   },
//   actionIcon: {
//     width: 48,
//     height: 48,
//     borderRadius: 12,
//     alignItems: 'center',
//     justifyContent: 'center',
//   },
//   actionContent: {
//     flex: 1,
//     marginLeft: 16,
//   },
//   actionTitle: {
//     fontSize: 16,
//     fontWeight: '600',
//     color: '#333',
//   },
//   actionSubtitle: {
//     fontSize: 13,
//     color: '#888',
//     marginTop: 2,
//   },
//   bottomPadding: {
//     height: 40,
//   },
// });
import { View, Text } from 'react-native';

export default function Screen() {
  return <Text>OK</Text>;
}
