import { useEffect } from 'react';

import { Redirect, Tabs } from 'expo-router';

import { Ionicons } from '@expo/vector-icons';

import { View, Text, StyleSheet } from 'react-native';

import { useCartStore } from '../../src/store/cartStore';

import { useAuthStore } from '../../src/store/authStore';

import { useRefreshProfileWhilePending } from '../../src/hooks/useRefreshProfileWhilePending';

import { GlassTabBar } from '../../src/components/GlassTabBar';

import { TAB_BAR_COLORS, TAB_BAR_LAYOUT } from '../../src/theme/tabBarTheme';



let adminBrowsingStore = false;



export function setAdminBrowsingStore(value: boolean) {

  adminBrowsingStore = value;

}



function profileInitials(name?: string, businessName?: string | null) {

  const source = (businessName || name || 'U').trim();

  const parts = source.split(/\s+/).filter(Boolean);

  if (parts.length >= 2) {

    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();

  }

  return source.slice(0, 2).toUpperCase();

}



export default function TabsLayout() {

  const { user } = useAuthStore();

  const { items } = useCartStore();

  const cartCount = items.reduce((sum, item) => sum + item.quantity, 0);

  const initials = profileInitials(user?.name, user?.business_name);



  useRefreshProfileWhilePending();

  const userId = user?.id;
  const fetchCart = useCartStore((s) => s.fetchCart);

  useEffect(() => {
    if (!userId) return;
    void fetchCart();
  }, [userId, fetchCart]);

  if (!user) {

    return <Redirect href="/(auth)/login" />;

  }



  if (user.role === 'admin' && !adminBrowsingStore) {

    return <Redirect href="/admin" />;

  }



  if (user.role === 'delivery' && !adminBrowsingStore) {

    return <Redirect href="/delivery" />;

  }



  return (

    <Tabs

      tabBar={(props) => <GlassTabBar {...props} />}

      screenOptions={{

        tabBarActiveTintColor: TAB_BAR_COLORS.active,

        tabBarInactiveTintColor: TAB_BAR_COLORS.inactive,

        tabBarStyle: {

          position: 'absolute',

          backgroundColor: 'transparent',

          borderTopWidth: 0,

          elevation: 0,

          height: TAB_BAR_LAYOUT.spacerHeight,

        },

        tabBarShowLabel: false,

        headerShown: false,

        animation: 'shift',

        sceneStyle: {

          backgroundColor: 'transparent',

        },

      }}

    >

      <Tabs.Screen

        name="index"

        options={{

          title: 'Home',

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

        name="products"

        options={{

          title: 'Products',

          tabBarIcon: ({ color, size, focused }) => (

            <Ionicons

              name={focused ? 'grid' : 'grid-outline'}

              size={size}

              color={color}

            />

          ),

        }}

      />

      <Tabs.Screen

        name="cart"

        options={{

          title: 'Cart',

          tabBarIcon: ({ color, size, focused }) => (

            <View style={styles.cartIconWrap}>

              <Ionicons

                name={focused ? 'cart' : 'cart-outline'}

                size={size}

                color={color}

              />

              {cartCount > 0 && (

                <View style={styles.badge}>

                  <Text style={styles.badgeText}>

                    {cartCount > 99 ? '99+' : cartCount}

                  </Text>

                </View>

              )}

            </View>

          ),

        }}

      />

      <Tabs.Screen

        name="orders"

        options={{

          title: 'Orders',

          tabBarIcon: ({ color, size, focused }) => (

            <Ionicons

              name={focused ? 'receipt' : 'receipt-outline'}

              size={size}

              color={color}

            />

          ),

        }}

      />

      <Tabs.Screen

        name="profile"

        options={{

          title: 'Profile',

          tabBarIcon: ({ focused }) => (

            <View

              style={[

                styles.profileOrb,

                focused ? styles.profileOrbActive : styles.profileOrbIdle,

              ]}

            >

              <Text style={styles.profileInitials}>{initials}</Text>

            </View>

          ),

        }}

      />

    </Tabs>

  );

}



const styles = StyleSheet.create({

  cartIconWrap: {

    width: 24,

    height: 24,

    alignItems: 'center',

    justifyContent: 'center',

  },

  badge: {

    position: 'absolute',

    top: -7,

    right: -11,

    backgroundColor: '#E53935',

    borderRadius: 10,

    minWidth: 18,

    height: 18,

    alignItems: 'center',

    justifyContent: 'center',

    paddingHorizontal: 4,

    borderWidth: 1.5,

    borderColor: '#FFFFFF',

  },

  badgeText: {

    color: '#fff',

    fontSize: 10,

    fontWeight: '700',

  },

  profileOrb: {

    width: 28,

    height: 28,

    borderRadius: 14,

    alignItems: 'center',

    justifyContent: 'center',

  },

  profileOrbIdle: {

    backgroundColor: TAB_BAR_COLORS.active,

  },

  profileOrbActive: {

    backgroundColor: TAB_BAR_COLORS.active,

    borderWidth: 2,

    borderColor: 'rgba(255, 255, 255, 0.9)',

  },

  profileInitials: {

    color: '#fff',

    fontSize: 10,

    fontWeight: '800',

    letterSpacing: 0.3,

  },

});


