import React, { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../src/services/supabase';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import type { AppColors } from '../../src/theme/colors';

export default function ResetPasswordScreen() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const validate = (): string | null => {
    if (password.length < 8) {
      return t('auth.resetPasswordScreen.tooShort');
    }
    if (!/\d/.test(password)) {
      return t('auth.resetPasswordScreen.noNumber');
    }
    if (password !== confirmPassword) {
      return t('auth.resetPasswordScreen.mismatch');
    }
    return null;
  };

  const handleUpdatePassword = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setError('');
    setLoading(true);

    const { error: updateError } = await supabase.auth.updateUser({
      password,
    });

    setLoading(false);

    if (updateError) {
      setError(updateError.message);
    } else {
      setSuccess(true);
    }
  };

  if (success) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.content}>
          <View style={styles.iconCircle}>
            <Ionicons name="checkmark-circle-outline" size={64} color={colors.success} />
          </View>
          <Text style={styles.title}>{t('auth.resetPasswordScreen.success')}</Text>
          <Text style={styles.description}>
            {t('auth.resetPasswordScreen.success')}
          </Text>
          <Pressable
            style={styles.primaryButton}
            onPress={() => router.replace('/(auth)/login')}
          >
            <Text style={styles.primaryButtonText}>{t('auth.resetPasswordScreen.goToLogin')}</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={styles.content}>
          <View style={styles.iconCircle}>
            <Ionicons name="key-outline" size={64} color={colors.primary} />
          </View>
          <Text style={styles.title}>{t('auth.resetPasswordScreen.setNew')}</Text>
          <Text style={styles.description}>
            {t('auth.resetPasswordScreen.instruction')}
          </Text>

          <View style={styles.inputContainer}>
            <Ionicons name="lock-closed-outline" size={20} color={colors.textMuted} style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              placeholder={t('auth.resetPasswordScreen.newPlaceholder')}
              placeholderTextColor={colors.textMuted}
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!showPassword}
              autoCapitalize="none"
            />
            <Pressable onPress={() => setShowPassword(!showPassword)} hitSlop={8}>
              <Ionicons
                name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                size={22}
                color={colors.textMuted}
              />
            </Pressable>
          </View>

          <View style={styles.inputContainer}>
            <Ionicons name="lock-closed-outline" size={20} color={colors.textMuted} style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              placeholder={t('auth.resetPasswordScreen.confirmPlaceholder')}
              placeholderTextColor={colors.textMuted}
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              secureTextEntry={!showConfirm}
              autoCapitalize="none"
            />
            <Pressable onPress={() => setShowConfirm(!showConfirm)} hitSlop={8}>
              <Ionicons
                name={showConfirm ? 'eye-off-outline' : 'eye-outline'}
                size={22}
                color={colors.textMuted}
              />
            </Pressable>
          </View>

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          <Pressable
            style={[styles.primaryButton, loading && styles.buttonDisabled]}
            onPress={handleUpdatePassword}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color={colors.onPrimary} />
            ) : (
              <Text style={styles.primaryButtonText}>{t('auth.resetPasswordScreen.save')}</Text>
            )}
          </Pressable>

          <Pressable
            style={styles.backButton}
            onPress={() => router.replace('/(auth)/login')}
          >
            <Ionicons name="arrow-back" size={18} color={colors.primary} />
            <Text style={styles.backButtonText}>{t('auth.forgotPasswordScreen.back')}</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function createStyles(c: AppColors) {
  return {
    container: {
      flex: 1,
      backgroundColor: c.surface,
    },
    content: {
      flex: 1,
      justifyContent: 'center',
      paddingHorizontal: 32,
      alignItems: 'center',
    },
    iconCircle: {
      width: 120,
      height: 120,
      borderRadius: 60,
      backgroundColor: c.primaryMuted,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      marginBottom: 32,
    },
    title: {
      fontSize: 26,
      fontWeight: '700' as const,
      color: c.text,
      marginBottom: 12,
      textAlign: 'center' as const,
    },
    description: {
      fontSize: 15,
      color: c.textSecondary,
      textAlign: 'center' as const,
      lineHeight: 22,
      marginBottom: 32,
    },
    inputContainer: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      backgroundColor: c.inputBackground,
      borderRadius: 12,
      paddingHorizontal: 16,
      width: '100%',
      marginBottom: 16,
    },
    inputIcon: {
      marginRight: 12,
    },
    input: {
      flex: 1,
      paddingVertical: 16,
      fontSize: 16,
      color: c.text,
    },
    errorText: {
      color: c.error,
      fontSize: 14,
      marginBottom: 16,
      textAlign: 'center' as const,
    },
    primaryButton: {
      backgroundColor: c.primary,
      paddingVertical: 16,
      borderRadius: 12,
      width: '100%',
      alignItems: 'center' as const,
      marginBottom: 20,
    },
    buttonDisabled: {
      opacity: 0.7,
    },
    primaryButtonText: {
      color: c.onPrimary,
      fontSize: 17,
      fontWeight: '700' as const,
    },
    backButton: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 6,
      paddingVertical: 8,
    },
    backButtonText: {
      color: c.primary,
      fontSize: 15,
      fontWeight: '600' as const,
    },
  };
}
