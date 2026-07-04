import React from 'react';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { GlassTabBar } from '../../../src/components/GlassTabBar';
import { useAppTheme } from '../../../src/hooks/useAppTheme';
import { getTabBarColors } from '../../../src/theme/tabBarTheme';

export default function DeliveryTabsLayout() {
  const { colors } = useAppTheme();

  return (
    <Tabs
      tabBar={(props) => <GlassTabBar {...props} />}
      screenOptions={{
        tabBarActiveTintColor: getTabBarColors(colors).active,
        tabBarInactiveTintColor: getTabBarColors(colors).inactive,
        tabBarStyle: {
          position: 'absolute',
          backgroundColor: 'transparent',
          borderTopWidth: 0,
          elevation: 0,
        },
        tabBarShowLabel: false,
        headerShown: false,
        animation: 'shift',
        sceneStyle: {
          backgroundColor: colors.background,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Run Sheet',
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons
              name={focused ? 'home' : 'home-outline'}
              size={size}
              color={color}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="todays-path"
        options={{
          title: 'Route',
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons
              name={focused ? 'map' : 'map-outline'}
              size={size}
              color={color}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="orders"
        options={{
          title: 'All Orders',
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons
              name={focused ? 'receipt' : 'receipt-outline'}
              size={size}
              color={color}
            />
          ),
        }}
      />
    </Tabs>
  );
}
