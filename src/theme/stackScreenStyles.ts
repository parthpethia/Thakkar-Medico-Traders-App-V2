import type { AppColors } from './colors';
import { tabScreenBase } from './tabScreenStyles';

/** Shared layout tokens for stack screens (admin, delivery, checkout, auth forms). */
export function stackScreenBase(c: AppColors, isDark: boolean) {
  const tab = tabScreenBase(c);
  return {
    ...tab,
    scrollContent: {
      flexGrow: 1 as const,
      padding: 16,
      paddingBottom: 32,
    },
    input: {
      backgroundColor: c.inputBackground,
      borderRadius: 12,
      paddingHorizontal: 16,
      height: 52,
      fontSize: 16,
      color: c.text,
    },
    inputRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      backgroundColor: c.inputBackground,
      borderRadius: 12,
      paddingHorizontal: 16,
      height: 52,
      gap: 12,
    },
    sectionLabel: {
      fontSize: 14,
      fontWeight: '600' as const,
      color: c.primary,
      marginTop: 12,
      marginBottom: 4,
    },
    errorBox: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      backgroundColor: isDark ? '#3d2024' : '#ffebee',
      padding: 12,
      borderRadius: 8,
      gap: 8,
    },
    errorText: { color: c.error, fontSize: 14, flex: 1 as const },
    primaryButton: {
      backgroundColor: c.primary,
      height: 56,
      borderRadius: 12,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    primaryButtonText: {
      color: c.onPrimary,
      fontSize: 18,
      fontWeight: '600' as const,
    },
    actionCard: {
      backgroundColor: c.surface,
      borderRadius: 12,
      padding: 16,
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      marginBottom: 12,
      borderWidth: 1,
      borderColor: c.border,
    },
    statCard: {
      backgroundColor: c.surface,
      borderRadius: 16,
      padding: 20,
      alignItems: 'center' as const,
      borderWidth: 1,
      borderColor: c.border,
    },
  };
}
