import React, { useEffect } from 'react';
import { View, type ViewProps } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useAppTheme } from '../hooks/useAppTheme';
import { useThemeStore } from '../store/themeStore';

type ThemeProviderProps = {
  children: React.ReactNode;
};

export function ThemeProvider({ children }: ThemeProviderProps) {
  const initTheme = useThemeStore((s) => s.initTheme);

  useEffect(() => {
    void initTheme();
  }, [initTheme]);

  return <ThemedRoot>{children}</ThemedRoot>;
}

export function ThemedRoot({ children, style, ...rest }: ViewProps) {
  const { colors, isDark } = useAppTheme();

  return (
    <>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <View style={[{ flex: 1, backgroundColor: colors.background }, style]} {...rest}>
        {children}
      </View>
    </>
  );
}
