import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export type TimeSlot = { value: string; label: string };

const SLOT_STEP_MINUTES = 30;
const SLOT_START_HOUR = 6;
const SLOT_END_HOUR = 22;

function minutesFromHHMM(value: string): number {
  const [h, m] = value.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return -1;
  return h * 60 + m;
}

function formatTimeLabel(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m || 0, 0, 0);
  return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
}

export function buildDeliveryTimeSlots(): TimeSlot[] {
  const slots: TimeSlot[] = [];
  for (let hour = SLOT_START_HOUR; hour <= SLOT_END_HOUR; hour++) {
    for (let minute = 0; minute < 60; minute += SLOT_STEP_MINUTES) {
      if (hour === SLOT_END_HOUR && minute > 0) break;
      const value = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      slots.push({ value, label: formatTimeLabel(value) });
    }
  }
  return slots;
}

/** Normalize DB time "10:00:00" → "10:00" for dropdown value */
export function normalizeTimeValue(raw?: string | null): string {
  if (!raw) return '';
  const part = raw.trim().slice(0, 5);
  return /^\d{2}:\d{2}$/.test(part) ? part : '';
}

type Props = {
  label: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  /** Only show slots strictly after this time (for end-time picker) */
  minTime?: string;
  allowClear?: boolean;
};

export function TimeSlotDropdown({
  label,
  placeholder = 'Select time',
  value,
  onChange,
  minTime,
  allowClear = true,
}: Props) {
  const [open, setOpen] = useState(false);
  const allSlots = useMemo(() => buildDeliveryTimeSlots(), []);

  const slots = useMemo(() => {
    if (!minTime) return allSlots;
    const minM = minutesFromHHMM(minTime);
    if (minM < 0) return allSlots;
    return allSlots.filter((s) => minutesFromHHMM(s.value) > minM);
  }, [allSlots, minTime]);

  const normalized = normalizeTimeValue(value);
  const display = normalized ? formatTimeLabel(normalized) : '';

  const select = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      <TouchableOpacity
        style={styles.pickerBtn}
        onPress={() => setOpen((o) => !o)}
        activeOpacity={0.8}
      >
        <Text style={[styles.pickerBtnText, !display && styles.placeholder]}>
          {display || placeholder}
        </Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color="#999" />
      </TouchableOpacity>

      {open && (
        <View style={styles.dropdown}>
          <ScrollView style={styles.scroll} nestedScrollEnabled keyboardShouldPersistTaps="handled">
            {allowClear && (
              <TouchableOpacity
                style={[styles.option, !normalized && styles.optionActive]}
                onPress={() => select('')}
              >
                <Text style={[styles.optionText, !normalized && styles.optionTextActive]}>
                  Not set
                </Text>
              </TouchableOpacity>
            )}
            {slots.map((slot) => (
              <TouchableOpacity
                key={slot.value}
                style={[styles.option, normalized === slot.value && styles.optionActive]}
                onPress={() => select(slot.value)}
              >
                <Text
                  style={[
                    styles.optionText,
                    normalized === slot.value && styles.optionTextActive,
                  ]}
                >
                  {slot.label}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, marginBottom: 4 },
  label: { fontSize: 12, fontWeight: '600', color: '#666', marginBottom: 6 },
  pickerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: '#eee',
  },
  pickerBtnText: { fontSize: 15, color: '#333', flex: 1 },
  placeholder: { color: '#999' },
  dropdown: {
    marginTop: 4,
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#eee',
    maxHeight: 220,
    overflow: 'hidden',
  },
  scroll: { maxHeight: 220 },
  option: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#f0f0f0',
  },
  optionActive: { backgroundColor: '#F3F3FF' },
  optionText: { fontSize: 15, color: '#444' },
  optionTextActive: { color: '#4C51C9', fontWeight: '600' },
});
