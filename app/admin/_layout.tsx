import { Stack, Redirect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../../src/store/authStore';
import { useThemedStackScreenOptions } from '../../src/theme/useThemedStackScreenOptions';

export default function AdminLayout() {
  const { user } = useAuthStore();
  const { t } = useTranslation();
  const screenOptions = useThemedStackScreenOptions({ headerShown: true });

  if (!user) {
    return <Redirect href="/(auth)/login" />;
  }

  if (user.role !== 'admin') {
    return <Redirect href="/" />;
  }

  return (
    <Stack screenOptions={screenOptions}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="products" options={{ headerShown: false }} />
      <Stack.Screen name="analytics" options={{ title: t('admin.analyticsScreen.title') }} />
      <Stack.Screen name="bulk-restock" options={{ title: t('admin.stockScreen.bulkRestock') }} />
      <Stack.Screen name="create-product" options={{ title: t('admin.productsScreen.createProduct') }} />
      <Stack.Screen name="edit-product" options={{ title: t('admin.productsScreen.editProduct') }} />
      <Stack.Screen name="delivery-tracking" options={{ title: 'Live Driver Tracking' }} />
      <Stack.Screen name="track-delivery/[orderId]" options={{ title: 'Live Order Tracking' }} />
      <Stack.Screen name="track-delivery" options={{ headerShown: true }} />
      <Stack.Screen name="orders" options={{ title: t('admin.orders') }} />
      <Stack.Screen name="invoice-import" options={{ title: 'Invoice to Order' }} />
      <Stack.Screen name="settings" options={{ title: t('admin.settingsScreen.title') }} />
      <Stack.Screen name="stock" options={{ title: t('admin.stockScreen.title') }} />
      <Stack.Screen name="users" options={{ title: t('admin.retailersScreen.title') }} />
    </Stack>
  );
}
