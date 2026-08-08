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

const INDICATOR_SIZE = 46;

const BLUR_INTENSITY = Platform.select({ ios: 50, android: 20, default: 20 }) ?? 20;

type TabLayout = { x: number; width: number };

function AnimatedTabIcon({
  focused,
  children,
}: {
  focused: boolean;
  children: React.ReactNode;
}) {
  const scale = useRef(new Animated.Value(focused ? 1.05 : 1)).current;

  useEffect(() => {
    Animated.spring(scale, {
      toValue: focused ? 1.05 : 1,
      friction: 8,
      tension: 150,
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

  const ACTIVE = isDark ? '#8B9CF7' : tabColors.active;
  const INACTIVE = isDark ? '#999CA8' : tabColors.inactive;
  const LABEL_INACTIVE = isDark ? '#999CA8' : tabColors.labelInactive;

  const blurTint = isDark
    ? Platform.OS === 'ios'
      ? 'systemUltraThinMaterialDark'
      : 'dark'
    : Platform.OS === 'ios'
      ? 'systemUltraThinMaterialLight'
      : 'light';

  const blurShellStyle: StyleProp<ViewStyle> = Platform.select({
    ios: { backgroundColor: 'transparent' },
    android: { backgroundColor: isDark ? 'rgba(18, 18, 24, 0.88)' : 'rgba(255, 255, 255, 0.88)' },
    default: { backgroundColor: isDark ? 'rgba(18, 18, 24, 0.88)' : 'rgba(255, 255, 255, 0.88)' },
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

  const activeGlowStyle = [
    styles.activeGlow,
    {
      backgroundColor: isDark ? 'rgba(139, 156, 247, 0.18)' : `${colors.primary}1A`,
      borderColor: isDark ? 'rgba(139, 156, 247, 0.35)' : `${colors.primary}40`,
    },
  ];

  const glassTopHighlight = {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    right: 0,
    height: 28,
    borderTopLeftRadius: 36,
    borderTopRightRadius: 36,
    borderTopWidth: 1.2,
    borderTopColor: isDark ? 'rgba(255, 255, 255, 0.32)' : 'rgba(255, 255, 255, 0.75)',
    backgroundColor: isDark ? 'rgba(255, 255, 255, 0.03)' : 'rgba(255, 255, 255, 0.12)',
  };

  const glassBorder = {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 36,
    borderWidth: 1,
    borderColor: isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.08)',
  };

  const tabContent = (
    <>
      <View style={glassBorder} pointerEvents="none" />
      <View style={glassTopHighlight} pointerEvents="none" />

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
      style={[styles.outer, { paddingBottom: Math.max(insets.bottom, 12) }]}
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
    paddingHorizontal: 14,
    alignItems: 'stretch',
    zIndex: 100,
    elevation: 100,
  },
  pillShadow: {
    borderRadius: 36,
    backgroundColor: 'transparent',
    ...Platform.select({
      ios: {
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.22,
        shadowRadius: 18,
      },
      android: {
        elevation: 12,
      },
    }),
  },
  blurShell: {
    borderRadius: 36,
    overflow: 'hidden',
  },
  tabRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    paddingTop: 8,
    paddingBottom: 8,
    paddingHorizontal: 6,
    minHeight: 68,
  },
  activeGlow: {
    position: 'absolute',
    top: 8,
    left: 0,
    width: INDICATOR_SIZE,
    height: INDICATOR_SIZE,
    borderRadius: INDICATOR_SIZE / 2,
    borderWidth: 1.2,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 0,
  },
  tabPressed: {
    opacity: 0.8,
  },
  iconSlot: {
    width: INDICATOR_SIZE,
    height: INDICATOR_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconAnimatedWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    marginTop: 2,
    fontSize: 11,
    lineHeight: 13,
    letterSpacing: 0.1,
    textAlign: 'center',
    width: '100%',
    paddingHorizontal: 2,
  },
  labelActive: {
    fontWeight: '600',
  },
  labelInactive: {
    fontWeight: '400',
  },
});

