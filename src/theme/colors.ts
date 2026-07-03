export type AppColors = {
  background: string;
  surface: string;
  surfaceSecondary: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  border: string;
  borderLight: string;
  primary: string;
  primaryMuted: string;
  success: string;
  successMuted: string;
  error: string;
  warning: string;
  warningBg: string;
  onPrimary: string;
  inputBackground: string;
  skeleton: string;
  cardBorder: string;
  shadow: string;
  tabBarInactive: string;
  tabBarLabelInactive: string;
  glassFallback: string;
  switchTrackOff: string;
  switchThumbOff: string;
  switchTrackOn: string;
  switchThumbOn: string;
  loyaltyInfoBg: string;
  loyaltyInfoText: string;
};

export const brand = {
  primary: '#4C51C9',
  secondary: '#43A047',
  accent: '#FFA726',
  danger: '#E53935',
} as const;

export const lightColors: AppColors = {
  background: '#f5f5f5',
  surface: '#ffffff',
  surfaceSecondary: '#fafafa',
  text: '#333333',
  textSecondary: '#666666',
  textMuted: '#999999',
  border: '#eeeeee',
  borderLight: '#f0f0f0',
  primary: brand.primary,
  primaryMuted: '#ECEDFB',
  success: brand.secondary,
  successMuted: '#E8F5E9',
  error: brand.danger,
  warning: brand.accent,
  warningBg: '#FFF3E0',
  onPrimary: '#ffffff',
  inputBackground: '#f5f5f5',
  skeleton: '#e0e0e0',
  cardBorder: '#E8E8FF',
  shadow: '#1E2235',
  tabBarInactive: '#5C6370',
  tabBarLabelInactive: '#3D4451',
  glassFallback: 'rgba(255, 255, 255, 0.08)',
  switchTrackOff: '#dddddd',
  switchThumbOff: '#cccccc',
  switchTrackOn: '#A5D6A7',
  switchThumbOn: brand.secondary,
  loyaltyInfoBg: '#FFF8E1',
  loyaltyInfoText: '#8D6E63',
};

export const darkColors: AppColors = {
  background: '#121218',
  surface: '#1c1c24',
  surfaceSecondary: '#252530',
  text: '#f0f0f5',
  textSecondary: '#b0b0bc',
  textMuted: '#888894',
  border: '#2e2e3a',
  borderLight: '#252530',
  primary: '#7B80E8',
  primaryMuted: '#2a2a4a',
  success: '#66BB6A',
  successMuted: '#1e3a24',
  error: '#EF5350',
  warning: '#FFB74D',
  warningBg: '#3d3018',
  onPrimary: '#ffffff',
  inputBackground: '#252530',
  skeleton: '#3a3a48',
  cardBorder: '#3a3a55',
  shadow: '#000000',
  tabBarInactive: '#9a9aa8',
  tabBarLabelInactive: '#c0c0cc',
  glassFallback: 'rgba(28, 28, 36, 0.35)',
  switchTrackOff: '#444452',
  switchThumbOff: '#666674',
  switchTrackOn: '#2e5034',
  switchThumbOn: '#66BB6A',
  loyaltyInfoBg: '#3d3018',
  loyaltyInfoText: '#d4b896',
};
