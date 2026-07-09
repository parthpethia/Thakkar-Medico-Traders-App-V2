import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import { createClient } from '@supabase/supabase-js';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import type { AppColors } from '../../src/theme/colors';

const supabaseUrl = (process.env.EXPO_PUBLIC_SUPABASE_URL || '').trim();
const supabaseKey = (process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '').trim();

const isolatedSignupClient = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

export default function DeliveryCreateRetailer() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: '',
    phone: '',
    password: '',
    business_name: '',
    gstin: '',
    address: '',
    city: '',
    state: '',
    pincode: '',
    email: '',
  });

  const updateField = (field: keyof typeof form, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const createRetailer = async () => {
    if (!form.name.trim() || !form.phone.trim() || !form.password.trim()) {
      Alert.alert('Required', 'Name, phone and password are required.');
      return;
    }

    const digits = form.phone.replace(/\D/g, '');
    if (digits.length !== 10) {
      Alert.alert('Invalid Phone', 'Enter valid 10-digit phone number.');
      return;
    }

    if (form.password.length < 6) {
      Alert.alert('Invalid Password', 'Password must be at least 6 characters.');
      return;
    }

    if (form.email.trim()) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(form.email.trim())) {
        Alert.alert('Invalid Email', 'Please enter a valid email address.');
        return;
      }
    }

    if (form.pincode.trim()) {
      if (!/^\d{6}$/.test(form.pincode.trim())) {
        Alert.alert('Invalid Pincode', 'Pincode must be exactly 6 digits.');
        return;
      }
    }

    const formattedPhone = `+91${digits}`;
    const retailerEmail = form.email.trim() || `${digits}@thakkarmedico.internal`;

    setSaving(true);

    try {
      const { data, error } = await isolatedSignupClient.auth.signUp({
        email: retailerEmail,
        password: form.password,
        options: {
          data: {
            name: form.name.trim(),
            phone: formattedPhone,
            business_name: form.business_name.trim() || null,
            gstin: form.gstin.trim() || null,
            address: form.address.trim() || null,
            city: form.city.trim() || null,
            state: form.state.trim() || null,
            pincode: form.pincode.trim() || null,
          },
        },
      });

      if (error) throw error;
      if (!data.user?.id) throw new Error('Retailer user could not be created.');

      // If signUp didn't return a session (email auto-confirm is off),
      // sign in explicitly so the isolated client has the new user's JWT.
      if (!data.session) {
        const { error: signInError } = await isolatedSignupClient.auth.signInWithPassword({
          email: retailerEmail,
          password: form.password,
        });
        if (signInError) {
          console.warn('Could not sign in as new retailer:', signInError.message);
        }
      }

      // Check if session was successfully established before attempting the upsert
      const { data: sessionData } = await isolatedSignupClient.auth.getSession();
      if (sessionData.session) {
        try {
          const { error: profileError } = await isolatedSignupClient
            .from('profiles')
            .upsert(
              {
                id: data.user.id,
                phone: formattedPhone,
                name: form.name.trim(),
                email: retailerEmail,
                business_name: form.business_name.trim() || null,
                gstin: form.gstin.trim() || null,
                address: form.address.trim() || null,
                city: form.city.trim() || null,
                state: form.state.trim() || null,
                pincode: form.pincode.trim() || null,
                role: 'retailer',
                approved: true,
              },
              { onConflict: 'id' }
            );

          if (profileError) {
            console.warn('Profile upsert warning (non-fatal):', profileError.message);
          }
        } catch (err) {
          console.warn('Profile upsert caught warning (non-fatal):', err);
        }
      }

      Alert.alert('Success', 'Retailer account created successfully.', [
        { text: 'OK', onPress: () => router.back() },
      ]);
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to create retailer account');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Create Retailer' }} />

      <ScrollView contentContainerStyle={styles.content}>
        <SectionTitle title="Account Details" />

        <Input
          placeholder="Full Name *"
          value={form.name}
          onChangeText={(value) => updateField('name', value)}
        />
        <Input
          placeholder="Phone Number (10 digits) *"
          value={form.phone}
          onChangeText={(value) => updateField('phone', value)}
          keyboardType="phone-pad"
          maxLength={10}
        />
        <Input
          placeholder="Password (min 6 chars) *"
          value={form.password}
          onChangeText={(value) => updateField('password', value)}
          secureTextEntry
        />
        <Input
          placeholder="Email"
          value={form.email}
          onChangeText={(value) => updateField('email', value)}
          keyboardType="email-address"
          autoCapitalize="none"
        />

        <SectionTitle title="Business Details" />

        <Input
          placeholder="Business Name"
          value={form.business_name}
          onChangeText={(value) => updateField('business_name', value)}
        />
        <Input
          placeholder="GSTIN"
          value={form.gstin}
          onChangeText={(value) => updateField('gstin', value)}
          autoCapitalize="characters"
          maxLength={15}
        />

        <SectionTitle title="Address" />

        <Input
          placeholder="Address"
          value={form.address}
          onChangeText={(value) => updateField('address', value)}
          multiline
        />
        <View style={styles.row}>
          <Input
            placeholder="City"
            value={form.city}
            onChangeText={(value) => updateField('city', value)}
            containerStyle={styles.halfInput}
          />
          <Input
            placeholder="State"
            value={form.state}
            onChangeText={(value) => updateField('state', value)}
            containerStyle={styles.halfInput}
          />
        </View>
        <Input
          placeholder="Pincode"
          value={form.pincode}
          onChangeText={(value) => updateField('pincode', value)}
          keyboardType="number-pad"
          maxLength={6}
        />
      </ScrollView>

      <View style={styles.footer}>
        <TouchableOpacity
          style={[styles.submitBtn, saving && { opacity: 0.6 }]}
          onPress={createRetailer}
          disabled={saving}
        >
          {saving ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={styles.submitText}>Create Retailer</Text>}
        </TouchableOpacity>
      </View>
    </View>
  );
}

function SectionTitle({ title }: { title: string }) {
  const styles = useThemedStyles(createStyles);
  return <Text style={styles.sectionTitle}>{title}</Text>;
}

function Input({ containerStyle, multiline, ...props }: any) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  return (
    <View style={[styles.inputWrap, containerStyle]}>
      <TextInput
        style={[styles.input, multiline && styles.inputMultiline]}
        placeholderTextColor={colors.textMuted}
        multiline={multiline}
        {...props}
      />
    </View>
  );
}

function createStyles(c: AppColors, isDark: boolean) {
  return {
  container: { flex: 1, backgroundColor: c.background },
  content: { padding: 16, paddingBottom: 40 },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: c.primary,
    marginTop: 14,
    marginBottom: 8,
  },
  inputWrap: {
    backgroundColor: c.surface,
    borderRadius: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: c.border,
    overflow: 'hidden',
  },
  input: {
    height: 46,
    paddingHorizontal: 12,
    color: c.text,
  },
  inputMultiline: {
    minHeight: 80,
    textAlignVertical: 'top',
    paddingTop: 12,
  },
  row: {
    flexDirection: 'row',
    gap: 10,
  },
  halfInput: {
    flex: 1,
  },
  footer: {
    backgroundColor: c.surface,
    borderTopWidth: 1,
    borderTopColor: c.border,
    padding: 16,
  },
  submitBtn: {
    height: 52,
    borderRadius: 10,
    backgroundColor: c.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitText: {
    color: c.surface,
    fontSize: 16,
    fontWeight: '700',
  },
  } as const;
}
