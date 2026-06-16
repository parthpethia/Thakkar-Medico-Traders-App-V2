import { useColorScheme } from 'react-native';
import { darkColors, lightColors, type AppColors } from '../theme/colors';
import { useThemeStore, type ThemePreference } from '../store/themeStore';

export function useAppTheme(): {
  colors: AppColors;
  isDark: boolean;
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => Promise<void>;
} {
  const preference = useThemeStore((s) => s.preference);
  const setPreference = useThemeStore((s) => s.setPreference);
  const systemScheme = useColorScheme();

  const isDark =
    preference === 'dark' || (preference === 'system' && systemScheme === 'dark');
  const colors = isDark ? darkColors : lightColors;

  return { colors, isDark, preference, setPreference };
}
