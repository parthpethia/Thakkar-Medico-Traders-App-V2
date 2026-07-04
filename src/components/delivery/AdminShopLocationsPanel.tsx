import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Switch,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../services/supabase';
import { fetchShopLocations } from '../../services/shopLocationService';
import { ShopLocationCard } from './ShopLocationCard';
import type { RetailerShopLocation } from '../../types/shopLocation';
import { useAppTheme } from '../../hooks/useAppTheme';
import { useThemedStyles } from '../../theme/useThemedStyles';
import type { AppColors } from '../../theme/colors';

type Props = {
  retailerId: string;
};

export function AdminShopLocationsPanel({ retailerId }: Props) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const [locations, setLocations] = useState<RetailerShopLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [notesDraft, setNotesDraft] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await fetchShopLocations(retailerId);
      setLocations(list);
      const notes: Record<string, string> = {};
      list.forEach((l) => {
        notes[l.id] = l.admin_internal_notes || '';
      });
      setNotesDraft(notes);
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Could not load shop locations');
    } finally {
      setLoading(false);
    }
  }, [retailerId]);

  useEffect(() => {
    load();
  }, [load]);

  const patch = async (id: string, patch: Partial<RetailerShopLocation>) => {
    const { error } = await supabase.from('retailer_shop_locations').update(patch).eq('id', id);
    if (error) {
      Alert.alert('Error', error.message);
      return;
    }
    await load();
  };

  if (loading) {
    return <ActivityIndicator style={{ marginVertical: 16 }} color={colors.primary} />;
  }

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Shop delivery locations</Text>
      {locations.length === 0 ? (
        <Text style={styles.empty}>No saved shop locations yet.</Text>
      ) : (
        locations.map((loc) => (
          <View key={loc.id} style={styles.block}>
            <ShopLocationCard location={loc} compact />
            <View style={styles.toggleRow}>
              <Text style={styles.toggleLabel}>Lock (retailer cannot edit)</Text>
              <Switch
                value={loc.is_locked_by_admin}
                onValueChange={(v) =>
                  patch(loc.id, { is_locked_by_admin: v, added_by: 'admin' })
                }
              />
            </View>
            <View style={styles.toggleRow}>
              <Text style={styles.toggleLabel}>Verified ✅</Text>
              <Switch
                value={loc.is_verified}
                onValueChange={(v) => patch(loc.id, { is_verified: v })}
              />
            </View>
            <Text style={styles.toggleLabel}>Internal delivery notes (ops only)</Text>
            <TextInput
              style={styles.notesInput}
              multiline
              value={notesDraft[loc.id] ?? ''}
              onChangeText={(t) => setNotesDraft((n) => ({ ...n, [loc.id]: t }))}
              placeholder="e.g. Difficult access, send smaller vehicle"
              placeholderTextColor={colors.textMuted}
            />
            <TouchableOpacity
              style={styles.saveNotes}
              onPress={() =>
                patch(loc.id, { admin_internal_notes: notesDraft[loc.id]?.trim() || null })
              }
            >
              <Ionicons name="save-outline" size={16} color={colors.primary} />
              <Text style={styles.saveNotesText}>Save internal notes</Text>
            </TouchableOpacity>
          </View>
        ))
      )}
    </View>
  );
}

function createStyles(c: AppColors) {
  return {
    wrap: { marginTop: 8 },
    title: { fontSize: 16, fontWeight: '700' as const, color: c.text, marginBottom: 8 },
    empty: { fontSize: 14, color: c.textMuted },
    block: {
      backgroundColor: c.surface,
      borderRadius: 12,
      padding: 12,
      marginBottom: 12,
      borderWidth: 1,
      borderColor: c.border,
    },
    toggleRow: {
      flexDirection: 'row' as const,
      justifyContent: 'space-between',
      alignItems: 'center' as const,
      marginTop: 10,
    },
    toggleLabel: { fontSize: 13, color: c.textSecondary, fontWeight: '500' as const },
    notesInput: {
      marginTop: 6,
      backgroundColor: c.inputBackground,
      borderRadius: 8,
      padding: 10,
      minHeight: 64,
      textAlignVertical: 'top' as const,
      fontSize: 13,
      color: c.text,
    },
    saveNotes: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 6,
      marginTop: 8,
      alignSelf: 'flex-start' as const,
    },
    saveNotesText: { color: c.primary, fontWeight: '600' as const, fontSize: 13 },
  } as const;
}
