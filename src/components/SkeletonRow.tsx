import React, { useEffect, useRef } from 'react';
import { View, Animated, AccessibilityInfo } from 'react-native';
import { useThemedStyles } from '../theme/useThemedStyles';
import type { AppColors } from '../theme/colors';

interface SkeletonRowProps {
  width?: number | string;
  height?: number;
  borderRadius?: number;
  style?: any;
}

/**
 * Animated shimmer placeholder for loading states.
 * Respects prefers-reduced-motion — shows a static gray placeholder when enabled.
 *
 * @param width - Width of the skeleton (default: '100%')
 * @param height - Height in pixels (default: 16)
 * @param borderRadius - Border radius (default: 6)
 */
export function SkeletonRow({
  width = '100%',
  height = 16,
  borderRadius = 6,
  style,
}: SkeletonRowProps) {
  const styles = useThemedStyles(createSkeletonStyles);
  const animValue = useRef(new Animated.Value(0.3)).current;
  const reducedMotion = useRef(false);

  useEffect(() => {
    let animation: Animated.CompositeAnimation | null = null;

    AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      reducedMotion.current = enabled;
      if (!enabled) {
        animation = Animated.loop(
          Animated.sequence([
            Animated.timing(animValue, {
              toValue: 1,
              duration: 800,
              useNativeDriver: true,
            }),
            Animated.timing(animValue, {
              toValue: 0.3,
              duration: 800,
              useNativeDriver: true,
            }),
          ]),
        );
        animation.start();
      } else {
        animValue.setValue(0.5);
      }
    });

    return () => {
      animation?.stop();
    };
  }, []);

  return (
    <Animated.View
      style={[
        styles.skeleton,
        {
          width: width as any,
          height,
          borderRadius,
          opacity: animValue,
        },
        style,
      ]}
    />
  );
}

/**
 * Pre-composed skeleton for order list items.
 */
export function SkeletonOrderCard() {
  const styles = useThemedStyles(createSkeletonStyles);
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <SkeletonRow width={120} height={14} />
        <SkeletonRow width={60} height={20} borderRadius={10} />
      </View>
      <SkeletonRow width="80%" height={12} style={{ marginTop: 10 }} />
      <SkeletonRow width="60%" height={12} style={{ marginTop: 6 }} />
      <SkeletonRow width={80} height={16} style={{ marginTop: 10 }} />
    </View>
  );
}

/**
 * Pre-composed skeleton for product list items.
 */
export function SkeletonProductCard() {
  const styles = useThemedStyles(createSkeletonStyles);
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <SkeletonRow width="70%" height={14} />
        <SkeletonRow width={40} height={18} />
      </View>
      <SkeletonRow width="40%" height={11} style={{ marginTop: 6 }} />
    </View>
  );
}

function createSkeletonStyles(c: AppColors) {
  return {
    skeleton: {
      backgroundColor: c.skeleton,
    },
    card: {
      backgroundColor: c.surface,
      borderRadius: 12,
      padding: 14,
      marginBottom: 10,
    },
    row: {
      flexDirection: 'row' as const,
      justifyContent: 'space-between' as const,
      alignItems: 'center' as const,
    },
  };
}
