import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, Link } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../../src/store/authStore';
import { isValidEmail } from '../../src/utils/email';
import { routeForUser } from '../_layout';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import { stackScreenBase } from '../../src/theme/stackScreenStyles';
import type { AppColors } from '../../src/theme/colors';

export default function Register() {
  const styles = useThemedStyles(createRegisterStyles);
  const { colors } = useAppTheme();
  const router = useRouter();
  const { register, fetchUser, isLoading, error, clearError } = useAuthStore();

  const [formData, setFormData] = useState({
    name: '',
    email: '',
    phone: '',
    password: '',
    confirmPassword: '',
    business_name: '',
    gstin: '',
    address: '',
    city: '',
    state: '',
    pincode: '',
  });

  const [showPassword, setShowPassword] = useState(false);

  const updateField = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleRegister = async () => {
    clearError();

    if (!formData.name || !formData.email || !formData.password) {
      Alert.alert('Error', 'Please fill in name, email and password');
      return;
    }

    if (!isValidEmail(formData.email)) {
      Alert.alert('Error', 'Please enter a valid email address');
      return;
    }

    if (formData.phone && formData.phone.length !== 10) {
      Alert.alert('Error', 'Phone number must be 10 digits');
      return;
    }

    if (formData.password.length < 6) {
      Alert.alert('Error', 'Password must be at least 6 characters');
      return;
    }

    if (formData.password !== formData.confirmPassword) {
      Alert.alert('Error', 'Passwords do not match');
      return;
    }

    const success = await register({
      email: formData.email,
      password: formData.password,
      phone: formData.phone || null,
      name: formData.name,
      business_name: formData.business_name || null,
      gstin: formData.gstin || null,
      address: formData.address || null,
      city: formData.city || null,
      state: formData.state || null,
      pincode: formData.pincode || null,
    });

    if (!success) {
      const message = useAuthStore.getState().error;
      if (message) {
        Alert.alert('Registration Failed', message);
      }
      return;
    }

    await fetchUser({ silent: true });
    const currentUser = useAuthStore.getState().user;

    Alert.alert(
      'Registration Successful',
      'Your account has been created. You can browse products now; admin approval is required to place orders.',
      [
        {
          text: 'OK',
          onPress: () => {
            router.replace(currentUser ? routeForUser(currentUser) : '/(tabs)');
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
              <Ionicons name="arrow-back" size={24} color={colors.text} />
            </TouchableOpacity>

            <Text style={styles.title}>Create Account</Text>
            <Text style={styles.subtitle}>Register as a retailer</Text>
          </View>

          <View style={styles.form}>
            {error ? (
              <View style={styles.errorBox}>
                <Ionicons name="alert-circle" size={20} color={colors.error} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            <Text style={styles.sectionTitle}>Account Details *</Text>

            <TextInput
              style={styles.input}
              placeholder="Full Name *"
              placeholderTextColor={colors.textMuted}
              value={formData.name}
              onChangeText={(v) => updateField('name', v)}
            />

            <TextInput
              style={styles.input}
              placeholder="Email Address *"
              placeholderTextColor={colors.textMuted}
              value={formData.email}
              onChangeText={(v) => updateField('email', v)}
              keyboardType="email-address"
              autoCapitalize="none"
            />

            <TextInput
              style={styles.input}
              placeholder="Phone Number (10 digits, optional — for quick login)"
              placeholderTextColor={colors.textMuted}
              value={formData.phone}
              onChangeText={(v) => updateField('phone', v)}
              keyboardType="phone-pad"
              maxLength={10}
            />

            <View style={styles.passwordContainer}>
              <TextInput
                style={styles.passwordInput}
                placeholder="Password (min 6 characters) *"
                placeholderTextColor={colors.textMuted}
                value={formData.password}
                onChangeText={(v) => updateField('password', v)}
                secureTextEntry={!showPassword}
              />
              <TouchableOpacity onPress={() => setShowPassword(!showPassword)}>
                <Ionicons
                  name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                  size={20}
                  color={colors.textSecondary}
                />
              </TouchableOpacity>
            </View>

            <TextInput
              style={styles.input}
              placeholder="Confirm Password *"
              placeholderTextColor={colors.textMuted}
              value={formData.confirmPassword}
              onChangeText={(v) => updateField('confirmPassword', v)}
              secureTextEntry={!showPassword}
            />

            <Text style={styles.sectionTitle}>Business Details</Text>

            <TextInput
              style={styles.input}
              placeholder="Business Name"
              placeholderTextColor={colors.textMuted}
              value={formData.business_name}
              onChangeText={(v) => updateField('business_name', v)}
            />

            <TextInput
              style={styles.input}
              placeholder="GSTIN (optional)"
              placeholderTextColor={colors.textMuted}
              value={formData.gstin}
              onChangeText={(v) => updateField('gstin', v)}
              autoCapitalize="characters"
              maxLength={15}
            />

            <Text style={styles.sectionTitle}>Address</Text>

            <TextInput
              style={[styles.input, styles.multilineInput]}
              placeholder="Address"
              placeholderTextColor={colors.textMuted}
              value={formData.address}
              onChangeText={(v) => updateField('address', v)}
              multiline
              numberOfLines={2}
            />

            <View style={styles.row}>
              <TextInput
                style={[styles.input, styles.halfInput]}
                placeholder="City"
                placeholderTextColor={colors.textMuted}
                value={formData.city}
                onChangeText={(v) => updateField('city', v)}
              />
              <TextInput
                style={[styles.input, styles.halfInput]}
                placeholder="State"
                placeholderTextColor={colors.textMuted}
                value={formData.state}
                onChangeText={(v) => updateField('state', v)}
              />
            </View>

            <TextInput
              style={styles.input}
              placeholder="Pincode"
              placeholderTextColor={colors.textMuted}
              value={formData.pincode}
              onChangeText={(v) => updateField('pincode', v)}
              keyboardType="number-pad"
              maxLength={6}
            />

            <TouchableOpacity
              style={[styles.registerButton, isLoading && styles.buttonDisabled]}
              onPress={handleRegister}
              disabled={isLoading}
            >
              <Text style={styles.registerButtonText}>
                {isLoading ? 'Creating Account...' : 'Create Account'}
              </Text>
            </TouchableOpacity>

            <View style={styles.loginRow}>
              <Text style={styles.loginText}>Already have an account? </Text>
              <Link href="/(auth)/login" asChild>
                <TouchableOpacity>
                  <Text style={styles.loginLink}>Sign In</Text>
                </TouchableOpacity>
              </Link>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function createRegisterStyles(c: AppColors, isDark: boolean) {
  const base = stackScreenBase(c, isDark);
  return {
    container: base.container,
    keyboardView: { flex: 1 },
    scrollContent: {
      flexGrow: 1,
      padding: 24,
      paddingBottom: 40,
    },
    header: { marginBottom: 24 },
    backButton: { marginBottom: 16 },
    title: {
      fontSize: 28,
      fontWeight: '700' as const,
      color: c.text,
    },
    subtitle: {
      fontSize: 16,
      color: c.textSecondary,
      marginTop: 4,
    },
    form: { gap: 12 },
    errorBox: base.errorBox,
    errorText: base.errorText,
    sectionTitle: base.sectionLabel,
    input: base.input,
    multilineInput: {
      height: 80,
      paddingTop: 14,
      textAlignVertical: 'top' as const,
    },
    passwordContainer: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      backgroundColor: c.inputBackground,
      borderRadius: 12,
      paddingHorizontal: 16,
      height: 52,
    },
    passwordInput: {
      flex: 1,
      fontSize: 16,
      color: c.text,
    },
    row: {
      flexDirection: 'row' as const,
      gap: 12,
    },
    halfInput: { flex: 1 },
    registerButton: {
      ...base.primaryButton,
      marginTop: 16,
    },
    buttonDisabled: { opacity: 0.7 },
    registerButtonText: base.primaryButtonText,
    loginRow: {
      flexDirection: 'row' as const,
      justifyContent: 'center' as const,
      marginTop: 16,
    },
    loginText: { color: c.textSecondary, fontSize: 14 },
    loginLink: {
      color: c.primary,
      fontSize: 14,
      fontWeight: '600' as const,
    },
  };
}
