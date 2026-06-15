import React, { useEffect, useRef } from 'react';
import { Text, StyleSheet, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNetworkStatus } from '../hooks/useNetworkStatus';

/**
 * Persistent banner displayed at the top of the app when device is offline.
 * Animates in/out smoothly using opacity + translateY.
 */
export function OfflineBanner() {
  const { isOnline } = useNetworkStatus();
  const animValue = useRef(new Animated.Value(isOnline ? 0 : 1)).current;

  useEffect(() => {
    Animated.timing(animValue, {
      toValue: isOnline ? 0 : 1,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, [isOnline]);

  const translateY = animValue.interpolate({
    inputRange: [0, 1],
    outputRange: [-50, 0],
  });

  const opacity = animValue;

  return (
    <Animated.View
      style={[
        styles.container,
        { transform: [{ translateY }], opacity },
      ]}
      pointerEvents={isOnline ? 'none' : 'auto'}
    >
      <Ionicons name="cloud-offline-outline" size={16} color="#795548" />
      <Text style={styles.text}>
        No internet connection — some features may be unavailable
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#FFF3E0',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#FFE0B2',
  },
  text: {
    flex: 1,
    fontSize: 12,
    color: '#795548',
    fontWeight: '500',
  },
});
