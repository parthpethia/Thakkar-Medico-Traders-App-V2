import { useMemo } from 'react';
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';
import { useAppTheme } from '../hooks/useAppTheme';

export function useThemedStackScreenOptions(
  overrides?: NativeStackNavigationOptions,
): NativeStackNavigationOptions {
  const { colors } = useAppTheme();

  return useMemo(
    () => ({
      headerStyle: { backgroundColor: colors.surface },
      headerTintColor: colors.primary,
      headerTitleStyle: { color: colors.text, fontWeight: '600' as const },
      headerShadowVisible: false,
      contentStyle: { backgroundColor: colors.background },
      ...overrides,
    }),
    [colors, overrides],
  );
}
