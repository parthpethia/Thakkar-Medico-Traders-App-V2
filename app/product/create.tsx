import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, Stack } from 'expo-router';
import { supabase } from '../../src/services/supabase';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import type { AppColors } from '../../src/theme/colors';

export default function CreateProduct() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
const router = useRouter();
  const [loading, setLoading] = useState(false);

  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [sku, setSku] = useState('');
  const [mrp, setMrp] = useState('');
  const [sellingPrice, setSellingPrice] = useState('');
  const [gst, setGst] = useState('');
  const [stock, setStock] = useState('');

  /* ================= CREATE ================= */

  const handleCreate = async () => {
    if (!name.trim() || !sku.trim() || !sellingPrice.trim()) {
      Alert.alert('Missing fields', 'Name, SKU and Selling Price are required');
      return;
    }

    const selling = Number(sellingPrice);
    if (isNaN(selling) || selling <= 0) {
      Alert.alert('Invalid price', 'Selling price must be a number');
      return;
    }

    try {
      setLoading(true);

      const { error } = await supabase.from('products').insert({
        name: name.trim(),
        company: company.trim() || null,
        sku: sku.trim(),
        mrp: Number(mrp || 0),
        selling_price: selling,
        gst_percent: Number(gst || 0),
        stock_quantity: Number(stock || 0),
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
    <SafeAreaView style={styles.safe}>
      <Stack.Screen options={{ title: 'Create Product' }} />

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView contentContainerStyle={styles.container}>
          <Section title="Basic Info">
            <Input label="Product Name *" value={name} onChange={setName} />
            <Input label="Company" value={company} onChange={setCompany} />
            <Input label="SKU *" value={sku} onChange={setSku} />
          </Section>

          <Section title="Pricing">
            <Input label="MRP" value={mrp} onChange={setMrp} numeric />
            <Input
              label="Selling Price *"
              value={sellingPrice}
              onChange={setSellingPrice}
              numeric
            />
            <Input label="GST %" value={gst} onChange={setGst} numeric />
          </Section>

          <Section title="Inventory">
            <Input
              label="Stock Quantity"
              value={stock}
              onChange={setStock}
              numeric
            />
          </Section>

          <TouchableOpacity
            style={[styles.btn, loading && { opacity: 0.7 }]}
            onPress={handleCreate}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color={colors.onPrimary} />
            ) : (
              <Text style={styles.btnText}>Create Product</Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/* ================= COMPONENTS ================= */

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Input({
  label,
  value,
  onChange,
  numeric,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  numeric?: boolean;
}) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  return (
    <View style={styles.inputGroup}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        keyboardType={numeric ? 'numeric' : 'default'}
        style={styles.input}
        placeholder="Enter value"
        placeholderTextColor={colors.textMuted}
      />
    </View>
  );
}

/* ================= STYLES ================= */

function createStyles(c: AppColors, isDark: boolean) {
  return {
  safe: { flex: 1, backgroundColor: c.background },

  container: {
    padding: 16,
    paddingBottom: 32,
  },

  section: {
    backgroundColor: c.surface,
    padding: 16,
    borderRadius: 12,
    marginBottom: 16,
  },

  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 12,
    color: c.text,
  },

  inputGroup: {
    marginBottom: 12,
  },

  label: {
    fontSize: 13,
    color: c.textSecondary,
    marginBottom: 6,
  },

  input: {
    backgroundColor: c.surfaceSecondary,
    padding: 12,
    borderRadius: 8,
    fontSize: 15,
  },

  btn: {
    marginTop: 8,
    backgroundColor: c.primary,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },

  btnText: {
    color: c.surface,
    fontWeight: '700',
    fontSize: 16,
  },
};
}
