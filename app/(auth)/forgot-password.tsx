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
import { isValidEmail, normalizeEmail } from '../../src/utils/email';
import { supabase } from '../../src/services/supabase';
import { formatPhoneE164 } from '../../src/utils/phone';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import type { AppColors } from '../../src/theme/colors';

type Step = 'email' | 'otp' | 'password';

export default function ForgotPassword() {
  const styles = useThemedStyles(createForgotPasswordStyles);
  const { colors } = useAppTheme();
  const router = useRouter();
  const {
    requestPasswordResetOtp,
    verifyPasswordResetOtp,
    setNewPasswordAfterReset,
    isLoading,
    error,
    clearError,
  } = useAuthStore();

  const [step, setStep] = useState<Step>('email');
  const [emailInput, setEmailInput] = useState('');
  const [normalizedEmail, setNormalizedEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const looksLikePhone = (input: string) => {
    const trimmed = input.trim();
    if (trimmed.includes('@')) return false;
    const digits = trimmed.replace(/\D/g, '');
    return digits.length >= 10;
  };

  const handleSendOtp = async () => {
    clearError();
    const input = emailInput.trim();
    if (!input) {
      Alert.alert('Error', 'Please enter email or phone');
      return;
    }

    let email = '';
    if (looksLikePhone(input)) {
      try {
        const e164 = formatPhoneE164(input);
        const { data, error: rpcError } = await supabase.rpc('get_email_by_phone', {
          p_phone: e164,
        });
        if (rpcError || !data) {
          Alert.alert('Error', 'No account found for this phone number');
          return;
        }
        email = data as string;
      } catch (err) {
        Alert.alert('Error', 'Could not resolve phone number');
        return;
      }
    } else if (isValidEmail(input)) {
      email = normalizeEmail(input);
    } else {
      Alert.alert('Error', 'Please enter a valid email address or 10-digit phone number');
      return;
    }

    const ok = await requestPasswordResetOtp(email);
    if (!ok) {
      Alert.alert(
        'Could not send code',
        error ||
          'Make sure you entered the correct email address. Enable Email provider in Supabase Dashboard.',
      );
      return;
    }

    setNormalizedEmail(email);
    setStep('otp');
    Alert.alert('Check your inbox', 'Enter the verification code sent to your email.');
  };

  const handleVerifyOtp = async () => {
    clearError();
    if (!otp.trim() || otp.trim().length < 6) {
      Alert.alert('Error', 'Enter the verification code from your email');
      return;
    }

    const ok = await verifyPasswordResetOtp(normalizedEmail, otp);
    if (!ok) {
      Alert.alert('Verification failed', error || 'Invalid or expired code');
      return;
    }

    setStep('password');
  };

  const handleSetPassword = async () => {
    clearError();
    if (password.length < 6) {
      Alert.alert('Error', 'Password must be at least 6 characters');
      return;
    }
    if (password !== confirmPassword) {
      Alert.alert('Error', 'Passwords do not match');
      return;
    }

    const ok = await setNewPasswordAfterReset(password);
    if (!ok) {
      Alert.alert('Error', error || 'Could not update password');
      return;
    }

    Alert.alert('Password updated', 'Sign in with your email or phone and new password.', [
      { text: 'OK', onPress: () => router.replace('/(auth)/login') },
    ]);
  };

  const maskedEmail =
    normalizedEmail.length > 0
      ? normalizedEmail.replace(/(.{2})(.*)(@.*)/, '$1***$3')
      : emailInput;

  const stepTitle =
    step === 'email'
      ? 'Reset password'
      : step === 'otp'
        ? 'Verify your email'
        : 'Choose a new password';

  const stepSubtitle =
    step === 'email'
      ? 'We will send a verification code to your registered email'
      : step === 'otp'
        ? `Code sent to ${maskedEmail}`
        : 'Create a strong new password';

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <TouchableOpacity style={styles.backRow} onPress={() => router.back()}>
            <Ionicons name="arrow-back" size={22} color={colors.primary} />
            <Text style={styles.backText}>Back to sign in</Text>
          </TouchableOpacity>

          <Text style={styles.title}>{stepTitle}</Text>
          <Text style={styles.subtitle}>{stepSubtitle}</Text>

          {error ? (
            <View style={styles.errorBanner}>
              <Text style={styles.errorBannerText}>{error}</Text>
            </View>
          ) : null}

          {step === 'email' && (
            <View style={styles.form}>
              <View style={styles.inputContainer}>
                <Ionicons name={emailInput.includes('@') || !emailInput.trim() ? 'mail-outline' : 'call-outline'} size={20} color={colors.textSecondary} />
                <TextInput
                  style={styles.input}
                  placeholder="Registered Email or Phone"
                  placeholderTextColor={colors.textMuted}
                  value={emailInput}
                  onChangeText={setEmailInput}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
              <TouchableOpacity
                style={[styles.primaryButton, isLoading && styles.buttonDisabled]}
                onPress={handleSendOtp}
                disabled={isLoading}
              >
                <Text style={styles.primaryButtonText}>
                  {isLoading ? 'Sending...' : 'Send verification code'}
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {step === 'otp' && (
            <View style={styles.form}>
              <View style={styles.inputContainer}>
                <Ionicons name="keypad-outline" size={20} color={colors.textSecondary} />
                <TextInput
                  style={styles.input}
                  placeholder="Verification code"
                  placeholderTextColor={colors.textMuted}
                  value={otp}
                  onChangeText={setOtp}
                  keyboardType="number-pad"
                  maxLength={8}
                />
              </View>
              <TouchableOpacity
                style={[styles.primaryButton, isLoading && styles.buttonDisabled]}
                onPress={handleVerifyOtp}
                disabled={isLoading}
              >
                <Text style={styles.primaryButtonText}>
                  {isLoading ? 'Verifying...' : 'Verify code'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleSendOtp}
                disabled={isLoading}
                style={styles.linkButton}
              >
                <Text style={styles.linkText}>Resend code</Text>
              </TouchableOpacity>
            </View>
          )}

          {step === 'password' && (
            <View style={styles.form}>
              <View style={styles.inputContainer}>
                <Ionicons name="lock-closed-outline" size={20} color={colors.textSecondary} />
                <TextInput
                  style={styles.input}
                  placeholder="New password"
                  placeholderTextColor={colors.textMuted}
                  value={password}
                  onChangeText={setPassword}
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
              <View style={styles.inputContainer}>
                <Ionicons name="lock-closed-outline" size={20} color={colors.textSecondary} />
                <TextInput
                  style={styles.input}
                  placeholder="Confirm new password"
                  placeholderTextColor={colors.textMuted}
                  value={confirmPassword}
                  onChangeText={setConfirmPassword}
                  secureTextEntry={!showPassword}
                />
              </View>
              <TouchableOpacity
                style={[styles.primaryButton, isLoading && styles.buttonDisabled]}
                onPress={handleSetPassword}
                disabled={isLoading}
              >
                <Text style={styles.primaryButtonText}>
                  {isLoading ? 'Saving...' : 'Update password'}
                </Text>
              </TouchableOpacity>
            </View>
          )}

          <View style={styles.footerRow}>
            <Text style={styles.footerText}>Remember your password? </Text>
            <Link href="/(auth)/login">
              <Text style={styles.footerLink}>Sign in</Text>
            </Link>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function createForgotPasswordStyles(c: AppColors, isDark: boolean) {
  return {
    container: { flex: 1, backgroundColor: c.surface },
    scrollContent: {
      flexGrow: 1,
      padding: 24,
      paddingTop: 12,
    },
    backRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 8,
      marginBottom: 24,
    },
    backText: { color: c.primary, fontSize: 16, fontWeight: '500' as const },
    title: {
      fontSize: 26,
      fontWeight: '700' as const,
      color: c.text,
    },
    subtitle: { fontSize: 15, color: c.textSecondary, marginTop: 8, marginBottom: 24 },
    form: { gap: 16 },
    inputContainer: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      backgroundColor: c.inputBackground,
      borderRadius: 12,
      paddingHorizontal: 16,
      height: 56,
      gap: 12,
    },
    input: { flex: 1, fontSize: 16, color: c.text },
    primaryButton: {
      backgroundColor: c.primary,
      height: 56,
      borderRadius: 12,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    buttonDisabled: { opacity: 0.7 },
    primaryButtonText: {
      color: c.onPrimary,
      fontSize: 17,
      fontWeight: '600' as const,
    },
    linkButton: { alignItems: 'center' as const, paddingVertical: 8 },
    linkText: { color: c.primary, fontWeight: '600' as const, fontSize: 15 },
    footerRow: {
      flexDirection: 'row' as const,
      justifyContent: 'center' as const,
      marginTop: 32,
    },
    footerText: { color: c.textSecondary },
    footerLink: { color: c.primary, fontWeight: '600' as const },
    errorBanner: {
      backgroundColor: isDark ? '#3d2024' : '#FFEBEE',
      borderRadius: 10,
      padding: 12,
      marginBottom: 16,
    },
    errorBannerText: { color: c.error, fontSize: 13, lineHeight: 18 },
  };
}
