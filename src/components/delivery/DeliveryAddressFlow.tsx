import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';

import { ShopLocationCard } from './ShopLocationCard';
import { MapPinWebView } from './MapPinWebView';
import { TimeSlotDropdown } from './TimeSlotDropdown';
import { BRANCH_LABEL_OPTIONS } from '../../constants/shopLocation';
import {
  autocompletePlaces,
  geocodePincode,
  placeDetails,
  reverseGeocode,
} from '../../services/googleMapsApi';
import {
  deleteShopLocation,
  draftFromLocation,
  emptyDraft,
  fetchShopLocations,
  saveShopLocation,
  setDefaultShopLocation,
} from '../../services/shopLocationService';
import type { DeliveryFlowStage, RetailerShopLocation, ShopLocationDraft } from '../../types/shopLocation';
import { isValidIndianMobile, normalizeIndianMobile } from '../../utils/indianPhone';
import type { AppUser } from '../../store/authStore';
import { useAppTheme } from '../../hooks/useAppTheme';
import { useThemedStyles } from '../../theme/useThemedStyles';
import type { AppColors } from '../../theme/colors';

type Props = {
  visible: boolean;
  onClose: () => void;
  onSelect: (location: RetailerShopLocation) => void;
  retailerId: string;
  user: AppUser | null;
  initialStage?: DeliveryFlowStage;
};

function applyGeocode(draft: ShopLocationDraft, geo: Awaited<ReturnType<typeof reverseGeocode>>): ShopLocationDraft {
  if (!geo) return draft;
  return {
    ...draft,
    lat: geo.lat,
    lng: geo.lng,
    formatted_address: geo.formatted_address,
    street: geo.street || draft.street,
    area: geo.area || draft.area,
    city: geo.city || draft.city,
    state: geo.state || draft.state,
    pincode: geo.pincode || draft.pincode,
    building: draft.building || geo.formatted_address.split(',')[0] || '',
  };
}

function isDraftValid(d: ShopLocationDraft): boolean {
  return (
    !!d.shop_name.trim() &&
    !!d.shop_no.trim() &&
    !!d.building.trim() &&
    !!d.landmark.trim() &&
    !!d.area.trim() &&
    !!d.city.trim() &&
    !!d.pincode.trim() &&
    !!d.receiver_name.trim() &&
    isValidIndianMobile(d.receiver_phone) &&
    (d.branch_label !== 'custom' || !!d.custom_label.trim())
  );
}

export function DeliveryAddressFlow({
  visible,
  onClose,
  onSelect,
  retailerId,
  user,
  initialStage = 'select',
}: Props) {
  const styles = useThemedStyles(createDeliveryAddressFlowStyles);
  const { colors } = useAppTheme();
  const [stage, setStage] = useState<DeliveryFlowStage>('select');
  const [locations, setLocations] = useState<RetailerShopLocation[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [suggestions, setSuggestions] = useState<{ place_id: string; description: string }[]>([]);
  const [pinInput, setPinInput] = useState('');
  const [draft, setDraft] = useState<ShopLocationDraft>(() => emptyDraft());
  const [dropLabel, setDropLabel] = useState('');
  const [editId, setEditId] = useState<string | undefined>();
  const [sameAsOwner, setSameAsOwner] = useState(false);
  const [landmarkWarning, setLandmarkWarning] = useState(false);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await fetchShopLocations(retailerId);
      setLocations(list);
      return list;
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Could not load shop locations');
      return [];
    } finally {
      setLoading(false);
    }
  }, [retailerId]);

  useEffect(() => {
    if (!visible) return;
    setStage(initialStage);
    setEditId(undefined);
    setDraft(emptyDraft({
      shop_name: user?.business_name || user?.name || '',
      gstin: user?.gstin || '',
    }));
    refresh().then((list) => {
      if (initialStage === 'select' && list.length === 0) {
        setStage('location_entry');
      }
    });
  }, [visible, initialStage, refresh, user]);

  useEffect(() => {
    if (!searchQuery.trim() || searchQuery.length < 2) {
      setSuggestions([]);
      return;
    }
    const t = setTimeout(async () => {
      const s = await autocompletePlaces(searchQuery);
      setSuggestions(s);
    }, 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  useEffect(() => {
    if (sameAsOwner && user) {
      setDraft((d) => ({
        ...d,
        receiver_name: user.name || user.business_name || '',
        receiver_phone: normalizeIndianMobile(user.phone || ''),
      }));
    }
  }, [sameAsOwner, user]);

  const updateDraft = (patch: Partial<ShopLocationDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
  };

  const useCurrentLocation = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Allow location access to pin your shop on the map.');
      return;
    }
    setLoading(true);
    try {
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const geo = await reverseGeocode(pos.coords.latitude, pos.coords.longitude);
      const next = applyGeocode(
        emptyDraft({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        geo,
      );
      setDraft(next);
      setDropLabel(geo?.formatted_address || '');
      setStage('map_pin');
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Could not get current location');
    } finally {
      setLoading(false);
    }
  };

  const onPickSuggestion = async (placeId: string) => {
    setLoading(true);
    try {
      const geo = await placeDetails(placeId);
      if (!geo) {
        Alert.alert('Error', 'Could not load place details');
        return;
      }
      setDraft((d) => applyGeocode({ ...d, shop_name: d.shop_name || searchQuery }, geo));
      setDropLabel(geo.formatted_address);
      setSearchQuery('');
      setSuggestions([]);
      setStage('map_pin');
    } finally {
      setLoading(false);
    }
  };

  const onPincodeSubmit = async () => {
    if (pinInput.length !== 6) {
      Alert.alert('Invalid PIN', 'Enter a 6-digit PIN code');
      return;
    }
    setLoading(true);
    try {
      const geo = await geocodePincode(pinInput);
      if (!geo) {
        Alert.alert('Not found', 'Could not find city for this PIN code');
        return;
      }
      setDraft((d) => applyGeocode({ ...d, pincode: pinInput }, geo));
      setDropLabel(geo.formatted_address);
      setStage('map_pin');
    } finally {
      setLoading(false);
    }
  };

  const onMapCenterChange = useCallback(async (lat: number, lng: number) => {
    updateDraft({ lat, lng });
    const geo = await reverseGeocode(lat, lng);
    if (geo) {
      setDropLabel(geo.formatted_address);
      setDraft((d) => applyGeocode({ ...d, lat, lng }, geo));
    }
  }, []);

  const confirmMap = () => setStage('details');

  const handleSave = async () => {
    if (!isDraftValid(draft)) return;
    if (!draft.landmark.trim()) {
      setLandmarkWarning(true);
    }
    setSaving(true);
    try {
      const saved = await saveShopLocation(
        retailerId,
        { ...draft, receiver_phone: normalizeIndianMobile(draft.receiver_phone) },
        editId,
      );
      await refresh();
      onSelect(saved);
      onClose();
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Could not save shop location');
    } finally {
      setSaving(false);
    }
  };

  const startAdd = () => {
    setEditId(undefined);
    setDraft(emptyDraft({
      shop_name: user?.business_name || user?.name || '',
      gstin: user?.gstin || '',
    }));
    setStage('location_entry');
  };

  const startEdit = (loc: RetailerShopLocation) => {
    setEditId(loc.id);
    setDraft(draftFromLocation(loc));
    setDropLabel(loc.formatted_address || '');
    setStage('details');
  };

  const confirmDelete = (loc: RetailerShopLocation) => {
    Alert.alert(
      'Delete location?',
      'Orders in progress won\'t be affected.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteShopLocation(loc.id);
              await refresh();
            } catch (e: any) {
              Alert.alert('Error', e.message || 'Could not delete');
            }
          },
        },
      ],
    );
  };

  const headerTitle = useMemo(() => {
    switch (stage) {
      case 'select':
      case 'address_book':
        return 'Shop locations';
      case 'location_entry':
        return 'Find your shop';
      case 'map_pin':
        return 'Confirm drop point';
      case 'details':
        return editId ? 'Edit shop location' : 'Shop details';
      default:
        return 'Delivery';
    }
  }, [stage, editId]);

  const renderSelect = () => (
    <>
      {loading && locations.length === 0 ? (
        <ActivityIndicator style={{ marginTop: 24 }} color={colors.primary} />
      ) : (
        <FlatList
          data={locations}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listPad}
          renderItem={({ item }) => (
            <ShopLocationCard
              location={item}
              onDeliverHere={() => {
                onSelect(item);
                onClose();
              }}
              onEdit={() => startEdit(item)}
              onSetDefault={async () => {
                try {
                  await setDefaultShopLocation(item.id);
                  await refresh();
                } catch (e: any) {
                  Alert.alert('Error', e.message);
                }
              }}
              onDelete={() => confirmDelete(item)}
            />
          )}
          ListFooterComponent={
            <TouchableOpacity style={styles.addBtn} onPress={startAdd}>
              <Ionicons name="add-circle-outline" size={22} color={colors.primary} />
              <Text style={styles.addBtnText}>Add New Shop Location</Text>
            </TouchableOpacity>
          }
        />
      )}
    </>
  );

  const renderLocationEntry = () => (
    <ScrollView contentContainerStyle={styles.scrollPad} keyboardShouldPersistTaps="handled">
      <TouchableOpacity style={styles.optionBtn} onPress={useCurrentLocation}>
        <Ionicons name="navigate" size={22} color={colors.primary} />
        <Text style={styles.optionText}>Use Current Location</Text>
      </TouchableOpacity>

      <Text style={styles.fieldLabel}>Search by shop name or area</Text>
      <TextInput
        style={styles.input}
        placeholder="e.g. Sharma General Store, Koramangala"
        value={searchQuery}
        onChangeText={setSearchQuery}
      />
      {suggestions.map((s) => (
        <TouchableOpacity key={s.place_id} style={styles.suggestion} onPress={() => onPickSuggestion(s.place_id)}>
          <Text style={styles.suggestionText}>{s.description}</Text>
        </TouchableOpacity>
      ))}

      <Text style={[styles.fieldLabel, { marginTop: 16 }]}>Enter PIN code</Text>
      <View style={styles.pinRow}>
        <TextInput
          style={[styles.input, { flex: 1 }]}
          placeholder="6-digit PIN"
          keyboardType="number-pad"
          maxLength={6}
          value={pinInput}
          onChangeText={setPinInput}
        />
        <TouchableOpacity style={styles.pinGo} onPress={onPincodeSubmit}>
          <Text style={styles.pinGoText}>Go</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );

  const renderMap = () => (
    <View style={styles.mapWrap}>
      <MapPinWebView lat={draft.lat} lng={draft.lng} onCenterChange={onMapCenterChange} />
      <Text style={styles.dropLabel}>Drop point: {dropLabel || 'Move map to your shop entrance'}</Text>
      <TouchableOpacity style={styles.primaryBtn} onPress={confirmMap}>
        <Text style={styles.primaryBtnText}>Confirm Drop Location</Text>
      </TouchableOpacity>
    </View>
  );

  const renderDetails = () => (
    <ScrollView contentContainerStyle={styles.scrollPad} keyboardShouldPersistTaps="handled">
      <Text style={styles.fieldLabel}>Shop / Business Name *</Text>
      <TextInput style={styles.input} value={draft.shop_name} onChangeText={(v) => updateDraft({ shop_name: v })} />

      <Text style={styles.fieldLabel}>Branch type *</Text>
      <View style={styles.pillRow}>
        {BRANCH_LABEL_OPTIONS.map((o) => (
          <TouchableOpacity
            key={o.value}
            style={[styles.pill, draft.branch_label === o.value && styles.pillActive]}
            onPress={() => updateDraft({ branch_label: o.value })}
          >
            <Text style={[styles.pillText, draft.branch_label === o.value && styles.pillTextActive]}>
              {o.emoji} {o.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      {draft.branch_label === 'custom' && (
        <TextInput
          style={styles.input}
          placeholder="Custom label"
          value={draft.custom_label}
          onChangeText={(v) => updateDraft({ custom_label: v })}
        />
      )}

      <Text style={styles.fieldLabel}>GSTIN (optional)</Text>
      <TextInput style={styles.input} value={draft.gstin} onChangeText={(v) => updateDraft({ gstin: v.toUpperCase() })} autoCapitalize="characters" />

      <Text style={styles.sectionHead}>Address</Text>
      <TextInput style={styles.input} placeholder="Shop No. / Unit No. *" value={draft.shop_no} onChangeText={(v) => updateDraft({ shop_no: v })} />
      <TextInput style={styles.input} placeholder="Building / Complex / Market *" value={draft.building} onChangeText={(v) => updateDraft({ building: v })} />
      <TextInput style={styles.input} placeholder="Street / Road" value={draft.street} onChangeText={(v) => updateDraft({ street: v })} />
      <TextInput
        style={styles.input}
        placeholder="Landmark *"
        value={draft.landmark}
        onChangeText={(v) => {
          updateDraft({ landmark: v });
          if (v.trim()) setLandmarkWarning(false);
        }}
      />
      {landmarkWarning && (
        <Text style={styles.softWarn}>Landmark helps our delivery team find your shop faster</Text>
      )}
      <TextInput style={styles.input} placeholder="Area / Locality *" value={draft.area} onChangeText={(v) => updateDraft({ area: v })} />
      <TextInput style={styles.input} placeholder="City *" value={draft.city} onChangeText={(v) => updateDraft({ city: v })} />
      <TextInput style={styles.input} placeholder="PIN Code *" keyboardType="number-pad" maxLength={6} value={draft.pincode} onChangeText={(v) => updateDraft({ pincode: v })} />

      <Text style={styles.sectionHead}>Delivery access</Text>
      <Text style={styles.fieldLabel}>Best delivery time (optional)</Text>
      <View style={styles.timeRow}>
        <TimeSlotDropdown
          label="From"
          placeholder="Start time"
          value={draft.best_delivery_time_start}
          onChange={(v) => {
            const patch: Partial<ShopLocationDraft> = { best_delivery_time_start: v };
            if (v && draft.best_delivery_time_end && draft.best_delivery_time_end <= v) {
              patch.best_delivery_time_end = '';
            }
            updateDraft(patch);
          }}
        />
        <TimeSlotDropdown
          label="To"
          placeholder="End time"
          value={draft.best_delivery_time_end}
          minTime={draft.best_delivery_time_start || undefined}
          onChange={(v) => updateDraft({ best_delivery_time_end: v })}
        />
      </View>
      <TextInput style={styles.input} placeholder="Loading / entry notes" value={draft.entry_notes} onChangeText={(v) => updateDraft({ entry_notes: v })} multiline />
      <Text style={styles.fieldLabel}>Parking</Text>
      <View style={styles.pillRow}>
        {(['yes', 'no', 'street'] as const).map((p) => (
          <TouchableOpacity
            key={p}
            style={[styles.pill, draft.parking === p && styles.pillActive]}
            onPress={() => updateDraft({ parking: p })}
          >
            <Text style={[styles.pillText, draft.parking === p && styles.pillTextActive]}>{p === 'street' ? 'Street' : p === 'yes' ? 'Yes' : 'No'}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.sectionHead}>Receiver at this location</Text>
      <View style={styles.ownerRow}>
        <Text style={styles.fieldLabel}>Same as account owner</Text>
        <Switch value={sameAsOwner} onValueChange={setSameAsOwner} />
      </View>
      <TextInput style={styles.input} placeholder="Receiver name *" value={draft.receiver_name} onChangeText={(v) => updateDraft({ receiver_name: v })} editable={!sameAsOwner} />
      <TextInput style={styles.input} placeholder="Receiver phone *" keyboardType="phone-pad" maxLength={10} value={draft.receiver_phone} onChangeText={(v) => updateDraft({ receiver_phone: v })} editable={!sameAsOwner} />
      <TextInput style={styles.input} placeholder="Alternate phone" keyboardType="phone-pad" maxLength={10} value={draft.alternate_phone} onChangeText={(v) => updateDraft({ alternate_phone: v })} />

      <TouchableOpacity
        style={[styles.primaryBtn, (!isDraftValid(draft) || saving) && styles.btnDisabled]}
        onPress={handleSave}
        disabled={!isDraftValid(draft) || saving}
      >
        {saving ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={styles.primaryBtnText}>Save Shop Location</Text>}
      </TouchableOpacity>
    </ScrollView>
  );

  const goBack = () => {
    if (stage === 'details' && !editId) setStage('map_pin');
    else if (stage === 'map_pin') setStage('location_entry');
    else if (stage === 'location_entry') setStage(locations.length ? 'select' : 'select');
    else onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <TouchableOpacity onPress={goBack} hitSlop={12}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{headerTitle}</Text>
          <TouchableOpacity onPress={onClose}>
            <Ionicons name="close" size={24} color={colors.text} />
          </TouchableOpacity>
        </View>

        {loading && stage !== 'select' ? (
          <View style={styles.loadingOverlay}>
            <ActivityIndicator color={colors.primary} size="large" />
          </View>
        ) : null}

        {stage === 'select' || stage === 'address_book' ? renderSelect() : null}
        {stage === 'location_entry' ? renderLocationEntry() : null}
        {stage === 'map_pin' ? renderMap() : null}
        {stage === 'details' ? renderDetails() : null}
      </SafeAreaView>
    </Modal>
  );
}

function createDeliveryAddressFlowStyles(c: AppColors, isDark: boolean) {
  return {
  safe: { flex: 1, backgroundColor: c.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: c.surface,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  headerTitle: { fontSize: 17, fontWeight: '700', flex: 1, textAlign: 'center', color: c.text },
  listPad: { padding: 16, paddingBottom: 40 },
  scrollPad: { padding: 16, paddingBottom: 48 },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 16,
    borderWidth: 1.5,
    borderColor: c.primary,
    borderRadius: 12,
    borderStyle: 'dashed',
  },
  addBtnText: { color: c.primary, fontWeight: '700', fontSize: 15 },
  optionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: c.surface,
    padding: 16,
    borderRadius: 12,
    marginBottom: 16,
  },
  optionText: { fontSize: 16, fontWeight: '600', color: c.text },
  fieldLabel: { fontSize: 13, fontWeight: '600', color: c.textSecondary, marginBottom: 6, marginTop: 8 },
  sectionHead: { fontSize: 15, fontWeight: '700', marginTop: 16, marginBottom: 8, color: c.text },
  input: {
    backgroundColor: c.surface,
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: c.border,
    fontSize: 15,
    color: c.text,
  },
  suggestion: {
    backgroundColor: c.surface,
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: c.borderLight,
  },
  suggestionText: { fontSize: 14, color: c.text },
  pinRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  timeRow: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  pinGo: {
    backgroundColor: c.primary,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 10,
    marginBottom: 10,
  },
  pinGoText: { color: c.onPrimary, fontWeight: '700' },
  mapWrap: { flex: 1, padding: 16 },
  dropLabel: { marginVertical: 12, fontSize: 14, color: c.textSecondary },
  primaryBtn: {
    backgroundColor: c.primary,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  primaryBtnText: { color: c.onPrimary, fontWeight: '700', fontSize: 16 },
  btnDisabled: { opacity: 0.5 },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.switchTrackOff,
  },
  pillActive: { borderColor: c.primary, backgroundColor: c.primaryMuted },
  pillText: { fontSize: 13, color: c.textSecondary },
  pillTextActive: { color: c.primary, fontWeight: '600' },
  ownerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  softWarn: { color: c.warning, fontSize: 12, marginBottom: 8, marginTop: -4 },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: isDark ? 'rgba(18,18,24,0.72)' : 'rgba(255,255,255,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
};
}
