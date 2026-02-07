// import React, { useEffect, useState, useCallback } from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   ScrollView,
//   TouchableOpacity,
//   RefreshControl,
//   Alert,
// } from 'react-native';
// import { SafeAreaView } from 'react-native-safe-area-context';
// import { useRouter } from 'expo-router';
// import { Ionicons } from '@expo/vector-icons';
// import { useAuthStore } from '../../src/store/authStore';
// import { useCartStore } from '../../src/store/cartStore';
// import { useSettingsStore } from '../../src/store/settingsStore';
// import { CategoryCard } from '../../src/components/CategoryCard';
// import { ProductCard } from '../../src/components/ProductCard';
// import { Category, Product } from '../../src/types';
// import api from '../../src/services/api';

// export default function Home() {
//   const router = useRouter();
//   const { user } = useAuthStore();
//   const { addToCart, fetchCart } = useCartStore();
//   const { settings } = useSettingsStore();
  
//   const [categories, setCategories] = useState<Category[]>([]);
//   const [featuredProducts, setFeaturedProducts] = useState<Product[]>([]);
//   const [refreshing, setRefreshing] = useState(false);
//   const [loading, setLoading] = useState(true);

//   const isVerified = user?.role === 'verified_retailer' || user?.role === 'admin';
//   const showPrices = settings?.features.show_prices_to_unverified || isVerified;

//   const fetchData = async () => {
//     try {
//       const [catRes, prodRes] = await Promise.all([
//         api.get('/categories'),
//         api.get('/products?limit=6'),
//       ]);
//       setCategories(catRes.data);
//       setFeaturedProducts(prodRes.data);
//     } catch (error) {
//       console.error('Error fetching data:', error);
//     } finally {
//       setLoading(false);
//     }
//   };

//   useEffect(() => {
//     fetchData();
//     if (user) fetchCart();
//   }, [user]);

//   const onRefresh = useCallback(async () => {
//     setRefreshing(true);
//     await fetchData();
//     setRefreshing(false);
//   }, []);

//   const handleAddToCart = async (product: Product) => {
//     if (!user) {
//       Alert.alert('Login Required', 'Please login to add items to cart');
//       return;
//     }
//     const success = await addToCart(product.id, product.min_order_quantity);
//     if (success) {
//       Alert.alert('Added to Cart', `${product.name} added to your cart`);
//     }
//   };

//   return (
//     <SafeAreaView style={styles.container} edges={['top']}>
//       <View style={styles.header}>
//         <View>
//           <Text style={styles.greeting}>Hello, {user?.name || 'Guest'}</Text>
//           <Text style={styles.businessName}>
//             {user?.business_name || 'Welcome to Thakkar Medico'}
//           </Text>
//         </View>
//         {user?.role === 'unverified_retailer' && (
//           <View style={styles.verificationBadge}>
//             <Ionicons name="time" size={14} color="#FFA726" />
//             <Text style={styles.verificationText}>Pending Verification</Text>
//           </View>
//         )}
//       </View>

//       <ScrollView
//         style={styles.scrollView}
//         showsVerticalScrollIndicator={false}
//         refreshControl={
//           <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
//         }
//       >
//         {/* Quick Stats for verified users */}
//         {isVerified && (
//           <View style={styles.statsContainer}>
//             <View style={styles.statCard}>
//               <Ionicons name="star" size={24} color="#FFA726" />
//               <Text style={styles.statValue}>{user?.loyalty_points || 0}</Text>
//               <Text style={styles.statLabel}>Points</Text>
//             </View>
//             <View style={styles.statCard}>
//               <Ionicons name="wallet" size={24} color="#43A047" />
//               <Text style={styles.statValue}>
//                 ₹{((user?.credit_limit || 0) - (user?.credit_used || 0)).toFixed(0)}
//               </Text>
//               <Text style={styles.statLabel}>Credit Available</Text>
//             </View>
//           </View>
//         )}

//         {/* Unverified user message */}
//         {user?.role === 'unverified_retailer' && (
//           <View style={styles.unverifiedBox}>
//             <Ionicons name="information-circle" size={24} color="#1E88E5" />
//             <View style={styles.unverifiedContent}>
//               <Text style={styles.unverifiedTitle}>Account Pending Verification</Text>
//               <Text style={styles.unverifiedText}>
//                 You can browse products but need admin approval to place orders.
//               </Text>
//             </View>
//           </View>
//         )}

//         {/* Categories */}
//         <View style={styles.section}>
//           <View style={styles.sectionHeader}>
//             <Text style={styles.sectionTitle}>Categories</Text>
//             <TouchableOpacity onPress={() => router.push('/(tabs)/products')}>
//               <Text style={styles.seeAll}>See All</Text>
//             </TouchableOpacity>
//           </View>
//           <ScrollView horizontal showsHorizontalScrollIndicator={false}>
//             {categories.map((category) => (
//               <CategoryCard
//                 key={category.id}
//                 category={category}
//                 onPress={() => router.push(`/(tabs)/products?category=${category.id}`)}
//               />
//             ))}
//           </ScrollView>
//         </View>

//         {/* Featured Products */}
//         <View style={styles.section}>
//           <View style={styles.sectionHeader}>
//             <Text style={styles.sectionTitle}>Featured Products</Text>
//             <TouchableOpacity onPress={() => router.push('/(tabs)/products')}>
//               <Text style={styles.seeAll}>See All</Text>
//             </TouchableOpacity>
//           </View>
//           <View style={styles.productGrid}>
//             {featuredProducts.map((product) => (
//               <ProductCard
//                 key={product.id}
//                 product={product}
//                 showPrices={showPrices}
//                 onPress={() => router.push(`/product/${product.id}`)}
//                 onAddToCart={showPrices ? () => handleAddToCart(product) : undefined}
//               />
//             ))}
//           </View>
//         </View>

//         {/* Quick Actions */}
//         <View style={styles.quickActions}>
//           <TouchableOpacity
//             style={styles.actionButton}
//             onPress={() => router.push('/(tabs)/orders')}
//           >
//             <Ionicons name="receipt-outline" size={24} color="#1E88E5" />
//             <Text style={styles.actionText}>My Orders</Text>
//           </TouchableOpacity>
//           <TouchableOpacity
//             style={styles.actionButton}
//             onPress={() => router.push('/(tabs)/cart')}
//           >
//             <Ionicons name="cart-outline" size={24} color="#43A047" />
//             <Text style={styles.actionText}>View Cart</Text>
//           </TouchableOpacity>
//         </View>
//       </ScrollView>
//     </SafeAreaView>
//   );
// }

// const styles = StyleSheet.create({
//   container: {
//     flex: 1,
//     backgroundColor: '#f5f5f5',
//   },
//   header: {
//     flexDirection: 'row',
//     justifyContent: 'space-between',
//     alignItems: 'center',
//     padding: 16,
//     backgroundColor: '#fff',
//     borderBottomWidth: 1,
//     borderBottomColor: '#eee',
//   },
//   greeting: {
//     fontSize: 14,
//     color: '#666',
//   },
//   businessName: {
//     fontSize: 18,
//     fontWeight: '700',
//     color: '#333',
//     marginTop: 2,
//   },
//   verificationBadge: {
//     flexDirection: 'row',
//     alignItems: 'center',
//     backgroundColor: '#FFF3E0',
//     paddingHorizontal: 10,
//     paddingVertical: 6,
//     borderRadius: 20,
//     gap: 4,
//   },
//   verificationText: {
//     fontSize: 11,
//     color: '#FFA726',
//     fontWeight: '600',
//   },
//   scrollView: {
//     flex: 1,
//   },
//   statsContainer: {
//     flexDirection: 'row',
//     padding: 16,
//     gap: 12,
//   },
//   statCard: {
//     flex: 1,
//     backgroundColor: '#fff',
//     borderRadius: 12,
//     padding: 16,
//     alignItems: 'center',
//     shadowColor: '#000',
//     shadowOffset: { width: 0, height: 1 },
//     shadowOpacity: 0.1,
//     shadowRadius: 2,
//     elevation: 2,
//   },
//   statValue: {
//     fontSize: 20,
//     fontWeight: '700',
//     color: '#333',
//     marginTop: 8,
//   },
//   statLabel: {
//     fontSize: 12,
//     color: '#666',
//     marginTop: 4,
//   },
//   unverifiedBox: {
//     flexDirection: 'row',
//     backgroundColor: '#e3f2fd',
//     marginHorizontal: 16,
//     marginTop: 16,
//     padding: 16,
//     borderRadius: 12,
//     gap: 12,
//   },
//   unverifiedContent: {
//     flex: 1,
//   },
//   unverifiedTitle: {
//     fontSize: 14,
//     fontWeight: '600',
//     color: '#1E88E5',
//   },
//   unverifiedText: {
//     fontSize: 13,
//     color: '#666',
//     marginTop: 4,
//   },
//   section: {
//     padding: 16,
//   },
//   sectionHeader: {
//     flexDirection: 'row',
//     justifyContent: 'space-between',
//     alignItems: 'center',
//     marginBottom: 16,
//   },
//   sectionTitle: {
//     fontSize: 18,
//     fontWeight: '700',
//     color: '#333',
//   },
//   seeAll: {
//     fontSize: 14,
//     color: '#1E88E5',
//     fontWeight: '600',
//   },
//   productGrid: {
//     flexDirection: 'row',
//     flexWrap: 'wrap',
//     justifyContent: 'space-between',
//   },
//   quickActions: {
//     flexDirection: 'row',
//     padding: 16,
//     gap: 12,
//     marginBottom: 20,
//   },
//   actionButton: {
//     flex: 1,
//     backgroundColor: '#fff',
//     borderRadius: 12,
//     padding: 16,
//     alignItems: 'center',
//     shadowColor: '#000',
//     shadowOffset: { width: 0, height: 1 },
//     shadowOpacity: 0.1,
//     shadowRadius: 2,
//     elevation: 2,
//   },
//   actionText: {
//     fontSize: 14,
//     fontWeight: '600',
//     color: '#333',
//     marginTop: 8,
//   },
// });
import { View, Text } from 'react-native';

export default function Screen() {
  return <Text>OK</Text>;
}