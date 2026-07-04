import { useMemo } from 'react';
import { StyleSheet, type ImageStyle, type TextStyle, type ViewStyle } from 'react-native';
import { useAppTheme } from '../hooks/useAppTheme';
import type { AppColors } from './colors';

export function useThemedStyles<T extends StyleSheet.NamedStyles<T> | StyleSheet.NamedStyles<any>>(
  factory: (colors: AppColors, isDark: boolean) => T,
): T {
  const { colors, isDark } = useAppTheme();
  return useMemo(() => StyleSheet.create(factory(colors, isDark)), [colors, isDark]);
}
