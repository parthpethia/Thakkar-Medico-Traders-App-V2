import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

const THEME_STORAGE_KEY = 'app_theme_preference';

export type ThemePreference = 'light' | 'dark' | 'system';

interface ThemeState {
  preference: ThemePreference;
  hydrated: boolean;
  initTheme: () => Promise<void>;
  setPreference: (preference: ThemePreference) => Promise<void>;
}

export const useThemeStore = create<ThemeState>((set) => ({
  preference: 'system',
  hydrated: false,

  initTheme: async () => {
    try {
      const stored = await AsyncStorage.getItem(THEME_STORAGE_KEY);
      if (stored === 'light' || stored === 'dark' || stored === 'system') {
        set({ preference: stored, hydrated: true });
        return;
      }
    } catch {
      /* ignore */
    }
    set({ hydrated: true });
  },

  setPreference: async (preference) => {
    set({ preference });
    try {
      await AsyncStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
      /* ignore */
    }
  },
}));
