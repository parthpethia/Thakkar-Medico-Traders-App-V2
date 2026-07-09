import React, { useEffect, useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Animated,
  PanResponder,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { AppColors } from '../../theme/colors';

type SwipeButtonProps = {
  onSwipeSuccess: () => void;
  title: string;
  colors: AppColors;
  disabled?: boolean;
};

export function SwipeButton({
  onSwipeSuccess,
  title,
  colors,
  disabled = false,
}: SwipeButtonProps) {
  const [completed, setCompleted] = useState(false);
  const pan = useRef(new Animated.ValueXY()).current;
  const [containerWidth, setContainerWidth] = useState(0);
  const handleWidth = 48;

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !completed && !disabled,
      onMoveShouldSetPanResponder: () => !completed && !disabled,
      onPanResponderMove: (e, gestureState) => {
        if (completed || disabled) return;
        const maxSwipe = containerWidth - handleWidth - 6; // padding offsets
        if (gestureState.dx >= 0 && gestureState.dx <= maxSwipe) {
          pan.x.setValue(gestureState.dx);
        }
      },
      onPanResponderRelease: (e, gestureState) => {
        if (completed || disabled) return;
        const maxSwipe = containerWidth - handleWidth - 6;
        if (gestureState.dx >= maxSwipe * 0.82) {
          Animated.timing(pan.x, {
            toValue: maxSwipe,
            duration: 150,
            useNativeDriver: false,
          }).start(() => {
            setCompleted(true);
            onSwipeSuccess();
          });
        } else {
          Animated.spring(pan, {
            toValue: { x: 0, y: 0 },
            useNativeDriver: false,
            friction: 7,
          }).start();
        }
      },
    })
  ).current;

  useEffect(() => {
    if (disabled || !completed) {
      setCompleted(false);
      pan.setValue({ x: 0, y: 0 });
    }
  }, [disabled, completed, pan]);

  const maxSwipe = Math.max(1, containerWidth - handleWidth - 6);

  return (
    <View
      onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}
      style={[
        styles.container,
        {
          backgroundColor: disabled ? colors.border : colors.primaryMuted,
          borderColor: disabled ? colors.border : colors.primary,
          opacity: disabled ? 0.6 : 1,
        },
      ]}
    >
      <Animated.View
        style={[
          styles.trackBackground,
          {
            backgroundColor: colors.primary,
            width: pan.x.interpolate({
              inputRange: [0, maxSwipe],
              outputRange: [handleWidth, containerWidth],
              extrapolate: 'clamp',
            }),
          },
        ]}
      />

      <Animated.View
        {...panResponder.panHandlers}
        style={[
          styles.handle,
          {
            backgroundColor: '#FF9900', // Amazon Gold
            transform: [{ translateX: pan.x }],
          },
        ]}
      >
        <Ionicons name="arrow-forward" size={24} color="#FFF" />
      </Animated.View>

      <Text
        style={[
          styles.title,
          { color: disabled ? colors.textMuted : colors.text },
        ]}
        pointerEvents="none"
      >
        {completed ? 'Processing...' : title}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 56,
    borderRadius: 28,
    borderWidth: 1.5,
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
    overflow: 'hidden',
    padding: 3,
  },
  trackBackground: {
    position: 'absolute',
    left: 3,
    height: 48,
    borderRadius: 24,
    opacity: 0.22,
  },
  handle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    position: 'absolute',
    left: 3,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3.5,
    elevation: 4,
    zIndex: 2,
  },
  title: {
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0.5,
    zIndex: 1,
    textTransform: 'uppercase',
  },
});
