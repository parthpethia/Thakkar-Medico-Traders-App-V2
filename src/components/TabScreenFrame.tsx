import React from 'react';
import { View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppTheme } from '../hooks/useAppTheme';

type TabScreenFrameProps = {
  children: React.ReactNode;
  style?: ViewStyle;
};

/** Tab screen root — no top safe-area inset (avoids a band above the header). */
export function TabScreenFrame({ children, style }: TabScreenFrameProps) {
  const { colors } = useAppTheme();
  return (
    <View style={[{ flex: 1, backgroundColor: colors.background }, style]}>
      {children}
    </View>
  );
}

export function useTabTopInset() {
  return useSafeAreaInsets().top;
}

/** Padding so header content clears the status bar; use on the header bar background. */
export function useTabHeaderSafePadding(vertical = 16) {
  const top = useTabTopInset();
  return {
    paddingTop: top + vertical,
    paddingBottom: vertical,
    paddingHorizontal: 16,
  };
}
