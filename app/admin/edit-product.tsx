import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { supabase } from '../../src/services/supabase';

export default function EditProduct() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [sku, setSku] = useState('');
  const [packSize, setPackSize] = useState('');
  const [mrp, setMrp] = useState('');
  const [sellingPrice, setSellingPrice] = useState('');
  const [gst, setGst] = useState('');
  const [stock, setStock] = useState('');

  /* ---------- LOAD PRODUCT ---------- */
  useEffect(() => {
    if (!id) return;

    const fetchProduct = async () => {
      try {
        const { data, error } = await supabase
          .from('products')
          .select('*')
          .eq('id', id)
          .single();

        if (error || !data) throw error;

        setName(data.name ?? '');
        setCompany(data.company ?? '');
        setSku(data.sku ?? '');
        setPackSize(data.pack_size ?? '');
        setMrp(String(data.mrp ?? ''));
        setSellingPrice(String(data.selling_price ?? ''));
        setGst(String(data.gst_percent ?? ''));
        setStock(String(data.stock_quantity ?? ''));
      } catch (err: any) {
        Alert.alert('Error', 'Failed to load product');
        router.back();
      } finally {
        setLoading(false);
      }
    };

    fetchProduct();
  }, [id]);

  /* ---------- UPDATE ---------- */
  const handleUpdate = async () => {
    if (!name.trim() || !sku.trim() || !sellingPrice.trim()) {
      Alert.alert('Missing fields', 'Name, SKU and Selling Price are required');
      return;
    }

    try {
      setSaving(true);

      const { error } = await supabase
        .from('products')
        .update({
          name: name.trim(),
          company: company.trim() || null,
          sku: sku.trim(),
          pack_size: packSize.trim() || null,
          mrp: Number(mrp) || 0,
          selling_price: Number(sellingPrice),
          gst_percent: Number(gst) || 0,
          stock_quantity: Number(stock) || 0,
        })
        .eq('id', id);

      if (error) throw error;

      Alert.alert('Success', 'Product updated');
      router.back();
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to update product');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.loader}>
        <ActivityIndicator size="large" color="#4C51C9" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <Stack.Screen options={{ title: 'Edit Product' }} />

      <ScrollView contentContainerStyle={styles.content}>
        <Input label="Product Name *" value={name} onChange={setName} />
        <Input label="Company" value={company} onChange={setCompany} />
        <Input label="SKU *" value={sku} onChange={setSku} />
        <Input label="Pack Size (e.g. 10 Strips, 100ml Vial)" value={packSize} onChange={setPackSize} />

        <View style={styles.row}>
          <Input
            label="MRP"
            value={mrp}
            onChange={setMrp}
            keyboardType="numeric"
            style={{ flex: 1 }}
          />
          <Input
            label="GST %"
            value={gst}
            onChange={setGst}
            keyboardType="numeric"
            style={{ flex: 1 }}
          />
        </View>

        <View style={styles.row}>
          <Input
            label="Selling Price *"
            value={sellingPrice}
            onChange={setSellingPrice}
            keyboardType="numeric"
            style={{ flex: 1 }}
          />
          <Input
            label="Stock"
            value={stock}
            onChange={setStock}
            keyboardType="numeric"
            style={{ flex: 1 }}
          />
        </View>

        <TouchableOpacity
          style={[styles.button, saving && styles.buttonDisabled]}
          onPress={handleUpdate}
          disabled={saving}
        >
          {saving ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Save Changes</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

/* ---------- INPUT ---------- */

function Input({
  label,
  value,
  onChange,
  keyboardType,
  style,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  keyboardType?: any;
  style?: any;
}) {
  return (
    <View style={[styles.inputWrapper, style]}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        keyboardType={keyboardType}
        style={styles.input}
        placeholderTextColor="#999"
      />
    </View>
  );
}

/* ---------- STYLES ---------- */

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  content: { padding: 16 },
  loader: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  label: { fontSize: 13, color: '#555', marginBottom: 6 },
  inputWrapper: { marginBottom: 14 },
  input: {
    backgroundColor: '#fff',
    padding: 12,
    borderRadius: 10,
    fontSize: 15,
  },
  row: { flexDirection: 'row', gap: 12 },

  button: {
    marginTop: 24,
    backgroundColor: '#4C51C9',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.7 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
