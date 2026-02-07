// import React, { useEffect } from 'react';
// import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
// import { useRouter } from 'expo-router';
// import { useAuthStore } from '../src/store/authStore';
// import { Ionicons } from '@expo/vector-icons';

// export default function Index() {
//   const router = useRouter();
//   const { isAuthenticated, user, isLoading } = useAuthStore();

//   useEffect(() => {
//     if (!isLoading) {
//       if (isAuthenticated && user) {
//         if (user.role === 'admin') {
//           router.replace('/admin');
//         } else {
//           router.replace('/(tabs)');
//         }
//       } else {
//         router.replace('/(auth)/login');
//       }
//     }
//   }, [isAuthenticated, user, isLoading]);

//   return (
//     <View style={styles.container}>
//       <View style={styles.logoContainer}>
//         <Ionicons name="medical" size={80} color="#1E88E5" />
//         <Text style={styles.title}>Thakkar Medico</Text>
//         <Text style={styles.subtitle}>Traders</Text>
//       </View>
//       <ActivityIndicator size="large" color="#1E88E5" style={styles.loader} />
//     </View>
//   );
// }

// const styles = StyleSheet.create({
//   container: {
//     flex: 1,
//     backgroundColor: '#fff',
//     justifyContent: 'center',
//     alignItems: 'center',
//   },
//   logoContainer: {
//     alignItems: 'center',
//   },
//   title: {
//     fontSize: 32,
//     fontWeight: '700',
//     color: '#1E88E5',
//     marginTop: 16,
//   },
//   subtitle: {
//     fontSize: 20,
//     fontWeight: '500',
//     color: '#666',
//   },
//   loader: {
//     marginTop: 40,
//   },
// });
import { View, Text } from 'react-native';

export default function Index() {
  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
      <Text>THIS IS DEV MODE 🚀</Text>
    </View>
  );
}
