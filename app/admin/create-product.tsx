import React, { useState } from 'react';
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
import { Stack, useRouter } from 'expo-router';
import { supabase } from '../../src/services/supabase';

export default function CreateProduct() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [sku, setSku] = useState('');
  const [packSize, setPackSize] = useState('');
  const [mrp, setMrp] = useState('');
  const [sellingPrice, setSellingPrice] = useState('');
  const [gst, setGst] = useState('');
  const [stock, setStock] = useState('');

  const handleCreate = async () => {
    if (!name.trim() || !sku.trim() || !sellingPrice.trim()) {
      Alert.alert('Missing fields', 'Name, SKU and Selling Price are required');
      return;
    }

    if (Number(sellingPrice) <= 0) {
      Alert.alert('Invalid price', 'Selling price must be greater than 0');
      return;
    }

    try {
      setLoading(true);

      const { error } = await supabase.from('products').insert({
        name: name.trim(),
        company: company.trim() || null,
        sku: sku.trim(),
        pack_size: packSize.trim() || null,
        mrp: Number(mrp) || 0,
        selling_price: Number(sellingPrice),
        gst_percent: Number(gst) || 0,
        stock_quantity: Number(stock) || 0,
        is_active: true,
      });

      if (error) throw error;

      Alert.alert('Success', 'Product created successfully');
      router.back();
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to create product');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <Stack.Screen options={{ title: 'Create Product' }} />

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
          style={[styles.button, loading && styles.buttonDisabled]}
          onPress={handleCreate}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Create Product</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

/* ---------- INPUT COMPONENT ---------- */

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
        placeholderTextColor="#aaa"
      />
    </View>
  );
}

/* ---------- STYLES ---------- */

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  content: {
    padding: 16,
  },
  label: {
    fontSize: 13,
    color: '#555',
    marginBottom: 6,
  },
  inputWrapper: {
    marginBottom: 14,
  },
  input: {
    backgroundColor: '#fff',
    padding: 12,
    borderRadius: 10,
    fontSize: 15,
  },
  row: {
    flexDirection: 'row',
    gap: 12,
  },
  button: {
    marginTop: 24,
    backgroundColor: '#4C51C9',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
});
