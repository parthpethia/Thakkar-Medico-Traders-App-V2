/** Shared bottom tab bar colors — keep in sync with app primary (#4C51C9). */
export const TAB_BAR_COLORS = {
  active: '#4C51C9',
  inactive: '#5C6370',
  labelInactive: '#3D4451',
  /** Only when native blur is unavailable (Android fallback). Keep very transparent. */
  glassFallbackAndroid: 'rgba(255, 255, 255, 0.1)',
} as const;

export const TAB_BAR_LAYOUT = {
  /**
   * Bottom padding for scroll/list content and fixed footers so the last control
   * clears the floating tab bar (pill + home indicator).
   */
  scrollBottomInset: 136,
  /** Navigator tab bar slot height (absolute bar; does not shrink scene) */
  spacerHeight: 88,
} as const;

/** Use on ScrollView / FlatList contentContainerStyle */
export function tabScrollBottomPadding(extra = 0) {
  return { paddingBottom: TAB_BAR_LAYOUT.scrollBottomInset + extra };
}
