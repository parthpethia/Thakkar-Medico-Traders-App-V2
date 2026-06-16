import { Stack } from 'expo-router';

export default function ProductsLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: true,
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Products' }} />
      <Stack.Screen
        name="[id]"
        options={{
          title: 'Product',
        }}
      />
    </Stack>
  );
}
