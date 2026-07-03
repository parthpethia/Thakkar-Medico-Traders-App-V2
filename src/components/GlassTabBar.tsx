import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { BlurView } from 'expo-blur';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getTabBarColors } from '../theme/tabBarTheme';
import { useAppTheme } from '../hooks/useAppTheme';

const INDICATOR_SIZE = 50;

const BLUR_INTENSITY = Platform.select({ ios: 45, android: 15, default: 15 }) ?? 15;

type TabLayout = { x: number; width: number };

function AnimatedTabIcon({
  focused,
  children,
}: {
  focused: boolean;
  children: React.ReactNode;
}) {
  const scale = useRef(new Animated.Value(focused ? 1.08 : 1)).current;

  useEffect(() => {
    Animated.spring(scale, {
      toValue: focused ? 1.08 : 1,
      friction: 7,
      tension: 140,
      useNativeDriver: true,
    }).start();
  }, [focused, scale]);

  return (
    <Animated.View style={[styles.iconAnimatedWrap, { transform: [{ scale }] }]}>
      {children}
    </Animated.View>
  );
}

export function GlassTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useAppTheme();
  const tabColors = getTabBarColors(colors);
  const ACTIVE = tabColors.active;
  const INACTIVE = tabColors.inactive;
  const LABEL_INACTIVE = tabColors.labelInactive;
  const blurTint = isDark
    ? Platform.OS === 'ios'
      ? 'systemUltraThinMaterialDark'
      : 'dark'
    : Platform.OS === 'ios'
      ? 'systemUltraThinMaterialLight'
      : 'light';
  const blurShellStyle: StyleProp<ViewStyle> = Platform.select({
    ios: { backgroundColor: 'transparent' },
    android: { backgroundColor: isDark ? 'rgba(28, 28, 36, 0.82)' : 'rgba(255, 255, 255, 0.82)' },
    default: { backgroundColor: tabColors.glassFallbackAndroid },
  });
  const activeIndex = state.index;
  const routeCount = state.routes.length;

  const indicatorX = useRef(new Animated.Value(0)).current;
  const indicatorReady = useRef(false);
  const prevRouteCount = useRef(routeCount);
  const [tabLayouts, setTabLayouts] = useState<Record<number, TabLayout>>({});

  const layoutsReady = useMemo(
    () => routeCount > 0 && Object.keys(tabLayouts).length === routeCount,
    [routeCount, tabLayouts],
  );

  const moveIndicator = useCallback(
    (index: number, animate: boolean) => {
      const layout = tabLayouts[index];
      if (!layout) {
        return;
      }

      const targetX = layout.x + layout.width / 2 - INDICATOR_SIZE / 2;

      if (!animate || !indicatorReady.current) {
        indicatorX.setValue(targetX);
        indicatorReady.current = true;
        return;
      }

      Animated.spring(indicatorX, {
        toValue: targetX,
        friction: 9,
        tension: 130,
        useNativeDriver: true,
      }).start();
    },
    [indicatorX, tabLayouts],
  );

  useEffect(() => {
    if (!layoutsReady) {
      return;
    }
    moveIndicator(activeIndex, indicatorReady.current);
  }, [activeIndex, layoutsReady, moveIndicator]);

  useEffect(() => {
    if (prevRouteCount.current === routeCount) {
      return;
    }
    prevRouteCount.current = routeCount;
    indicatorReady.current = false;
    setTabLayouts({});
  }, [routeCount]);

  const onTabLayout = useCallback(
    (index: number) => (event: LayoutChangeEvent) => {
      const { x, width } = event.nativeEvent.layout;
      setTabLayouts((prev) => {
        const existing = prev[index];
        if (existing?.x === x && existing?.width === width) {
          return prev;
        }
        return { ...prev, [index]: { x, width } };
      });
    },
    [],
  );

  const isAndroid = Platform.OS === 'android';

  const sheenStyle = [
    styles.glassSheen,
    {
      backgroundColor: isDark ? 'rgba(255, 255, 255, 0.01)' : 'rgba(255, 255, 255, 0.05)',
      borderColor: isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(255, 255, 255, 0.2)',
    }
  ];

  const borderStyle = [
    styles.glassBorder,
    {
      borderColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(255, 255, 255, 0.2)',
      borderTopColor: isDark ? 'rgba(255, 255, 255, 0.3)' : 'rgba(255, 255, 255, 0.65)',
      borderLeftColor: isDark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(255, 255, 255, 0.45)',
      borderWidth: 1.2,
    }
  ];

  const activeGlowStyle = [
    styles.activeGlow,
    {
      backgroundColor: `${colors.primary}25`,
      borderColor: `${colors.primary}55`,
      borderWidth: 1.5,
    }
  ];

  // Soft step-fading to simulate a linear-gradient gloss reflection
  const glassReflectSoftHighlight1 = {
    position: 'absolute' as const,
    top: 1,
    left: 1,
    right: 1,
    height: 4,
    borderTopLeftRadius: 27,
    borderTopRightRadius: 27,
    backgroundColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(255, 255, 255, 0.16)',
  };

  const glassReflectSoftHighlight2 = {
    position: 'absolute' as const,
    top: 1,
    left: 1,
    right: 1,
    height: 10,
    borderTopLeftRadius: 27,
    borderTopRightRadius: 27,
    backgroundColor: isDark ? 'rgba(255, 255, 255, 0.03)' : 'rgba(255, 255, 255, 0.08)',
  };

  const glassReflectSoftHighlight3 = {
    position: 'absolute' as const,
    top: 1,
    left: 1,
    right: 1,
    height: 18,
    borderTopLeftRadius: 27,
    borderTopRightRadius: 27,
    backgroundColor: isDark ? 'rgba(255, 255, 255, 0.01)' : 'rgba(255, 255, 255, 0.03)',
  };

  const tabContent = (
    <>
      <View style={sheenStyle} pointerEvents="none" />
      <View style={borderStyle} pointerEvents="none" />
      <View style={glassReflectSoftHighlight3} pointerEvents="none" />
      <View style={glassReflectSoftHighlight2} pointerEvents="none" />
      <View style={glassReflectSoftHighlight1} pointerEvents="none" />

      <View style={styles.tabRow}>
        {layoutsReady && (
          <Animated.View
            pointerEvents="none"
            style={[
              activeGlowStyle,
              { transform: [{ translateX: indicatorX }] },
            ]}
          />
        )}

        {state.routes.map((route, index) => {
          const { options } = descriptors[route.key];
          const label =
            typeof options.tabBarLabel === 'string'
              ? options.tabBarLabel
              : options.title ?? route.name;
          const isFocused = activeIndex === index;
          const iconColor = isFocused ? ACTIVE : INACTIVE;
          const labelColor = isFocused ? ACTIVE : LABEL_INACTIVE;

          const onPress = () => {
            const event = navigation.emit({
              type: 'tabPress',
              target: route.key,
              canPreventDefault: true,
            });

            if (!isFocused && !event.defaultPrevented) {
              navigation.navigate(route.name, route.params);
            }
          };

          return (
            <Pressable
              key={route.key}
              accessibilityRole="button"
              accessibilityState={isFocused ? { selected: true } : {}}
              accessibilityLabel={options.tabBarAccessibilityLabel}
              onPress={onPress}
              onLongPress={() => {
                navigation.emit({
                  type: 'tabLongPress',
                  target: route.key,
                });
              }}
              onLayout={onTabLayout(index)}
              style={({ pressed }) => [
                styles.tab,
                pressed && styles.tabPressed,
              ]}
            >
              <View style={styles.iconSlot}>
                <AnimatedTabIcon focused={isFocused}>
                  {options.tabBarIcon?.({
                    focused: isFocused,
                    color: iconColor,
                    size: 24,
                  })}
                </AnimatedTabIcon>
              </View>
              <Text
                style={[
                  styles.label,
                  isFocused ? styles.labelActive : styles.labelInactive,
                  { color: labelColor },
                ]}
                numberOfLines={1}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </>
  );

  return (
    <View
      style={[styles.outer, { paddingBottom: Math.max(insets.bottom, 10) }]}
      pointerEvents="box-none"
    >
      <View style={styles.pillShadow}>
        {isAndroid ? (
          <View style={[styles.blurShell, blurShellStyle]}>
            {tabContent}
          </View>
        ) : (
          <BlurView
            intensity={BLUR_INTENSITY}
            tint={blurTint}
            style={[styles.blurShell, blurShellStyle]}
          >
            {tabContent}
          </BlurView>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 18,
    alignItems: 'stretch',
    zIndex: 100,
    elevation: 100,
  },
  pillShadow: {
    borderRadius: 28,
    backgroundColor: 'transparent',
    ...Platform.select({
      ios: {
        shadowColor: '#1E2235',
        shadowOffset: { width: 0, height: 12 },
        shadowOpacity: 0.18,
        shadowRadius: 28,
      },
      android: {
        elevation: 20,
      },
    }),
  },
  blurShell: {
    borderRadius: 28,
    overflow: 'hidden',
  },
  glassSheen: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 28,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
  },
  glassBorder: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 28,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(76, 81, 201, 0.1)',
  },
  tabRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingTop: 10,
    paddingBottom: 8,
    paddingHorizontal: 8,
    minHeight: 66,
  },
  activeGlow: {
    position: 'absolute',
    top: 1,
    left: 0,
    width: INDICATOR_SIZE,
    height: INDICATOR_SIZE,
    borderRadius: INDICATOR_SIZE / 2,
    backgroundColor: 'rgba(76, 81, 201, 0.16)',
    borderWidth: 1,
    borderColor: 'rgba(76, 81, 201, 0.28)',
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-start',
    minWidth: 0,
    paddingTop: 2,
  },
  tabPressed: {
    opacity: 0.85,
  },
  iconSlot: {
    width: INDICATOR_SIZE,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconAnimatedWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    marginTop: 4,
    fontSize: 11,
    lineHeight: 13,
    letterSpacing: 0.15,
    textAlign: 'center',
    width: '100%',
    paddingHorizontal: 2,
  },
  labelActive: {
    fontWeight: '700',
  },
  labelInactive: {
    fontWeight: '500',
  },
});
