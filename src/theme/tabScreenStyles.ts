import type { AppColors } from './colors';

/** Shared layout tokens for main retailer tab screens */
export function tabScreenBase(c: AppColors) {
  return {
    container: { flex: 1 as const, backgroundColor: c.background },
    header: {
      flexDirection: 'row' as const,
      justifyContent: 'space-between' as const,
      alignItems: 'center' as const,
      padding: 16,
      backgroundColor: c.surface,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    title: { fontSize: 22, fontWeight: '700' as const, color: c.text },
    sectionTitle: {
      fontSize: 18,
      fontWeight: '700' as const,
      color: c.text,
      marginBottom: 12,
    },
    card: {
      backgroundColor: c.surface,
      borderRadius: 12,
      padding: 16,
    },
    textSecondary: { color: c.textSecondary },
    textMuted: { color: c.textMuted },
    primaryMutedBox: {
      backgroundColor: c.primaryMuted,
      borderRadius: 12,
      padding: 16,
    },
    skeletonText: { backgroundColor: c.skeleton },
    filterChip: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 20,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
    },
    filterChipActive: {
      backgroundColor: c.primary,
      borderColor: c.primary,
    },
    filterText: { color: c.textSecondary, fontSize: 13 },
    filterTextActive: { color: c.onPrimary, fontWeight: '600' as const },
    emptyTitle: { fontSize: 16, fontWeight: '600' as const, color: c.text },
    emptySubtitle: { fontSize: 14, color: c.textMuted, textAlign: 'center' as const },
  };
}

export function switchTrackColors(c: AppColors) {
  return {
    false: c.switchTrackOff,
    true: c.switchTrackOn,
  };
}

export function switchThumbColor(c: AppColors, enabled: boolean) {
  return enabled ? c.switchThumbOn : c.switchThumbOff;
}
