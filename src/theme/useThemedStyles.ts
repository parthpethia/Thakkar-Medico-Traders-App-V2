import { useMemo } from 'react';
import { StyleSheet, type ImageStyle, type TextStyle, type ViewStyle } from 'react-native';
import { useAppTheme } from '../hooks/useAppTheme';
import type { AppColors } from './colors';

type NamedStyles<T> = {
  [P in keyof T]: ViewStyle | TextStyle | ImageStyle;
};

export function useThemedStyles<T extends NamedStyles<T>>(
  factory: (colors: AppColors, isDark: boolean) => T,
): T {
  const { colors, isDark } = useAppTheme();
  return useMemo(() => StyleSheet.create(factory(colors, isDark)), [colors, isDark]);
}
