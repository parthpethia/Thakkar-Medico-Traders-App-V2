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

export default function ForgotPasswordScreen() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const handleReset = async () => {
    if (!email.trim()) {
      setError(t('auth.forgotPasswordScreen.enterEmail'));
      return;
    }

    setError('');
    setLoading(true);

    const { error: resetError } = await supabase.auth.resetPasswordForEmail(
      email.trim(),
      { redirectTo: 'thakkarmedico://auth/reset-password' }
    );

    setLoading(false);

    if (resetError) {
      setError(resetError.message);
    } else {
      setSent(true);
    }
  };

  if (sent) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.content}>
          <View style={styles.iconCircle}>
            <Ionicons name="mail-outline" size={64} color={colors.primary} />
          </View>
          <Text style={styles.title}>{t('auth.forgotPasswordScreen.checkEmail')}</Text>
          <Text style={styles.description}>
            {t('auth.forgotPasswordScreen.emailSentTo')}{'\n'}
            <Text style={styles.emailHighlight}>{email}</Text>
          </Text>
          <Text style={styles.hint}>
            {t('auth.forgotPasswordScreen.linkHint')}
          </Text>
          <Pressable
            style={styles.backButton}
            onPress={() => router.replace('/(auth)/login')}
          >
            <Ionicons name="arrow-back" size={18} color={colors.primary} />
            <Text style={styles.backButtonText}>{t('auth.forgotPasswordScreen.back')}</Text>
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
            <Ionicons name="lock-closed-outline" size={64} color={colors.primary} />
          </View>
          <Text style={styles.title}>{t('auth.forgotPasswordScreen.title')}</Text>
          <Text style={styles.description}>
            {t('auth.forgotPasswordScreen.instruction')}
          </Text>

          <View style={styles.inputContainer}>
            <Ionicons name="mail-outline" size={20} color={colors.textMuted} style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              placeholder={t('auth.forgotPasswordScreen.emailPlaceholder')}
              placeholderTextColor={colors.textMuted}
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          <Pressable
            style={[styles.resetButton, loading && styles.resetButtonDisabled]}
            onPress={handleReset}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color={colors.onPrimary} />
            ) : (
              <Text style={styles.resetButtonText}>{t('auth.forgotPasswordScreen.send')}</Text>
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
    emailHighlight: {
      fontWeight: '600' as const,
      color: c.primary,
    },
    hint: {
      fontSize: 14,
      color: c.textMuted,
      textAlign: 'center' as const,
      lineHeight: 20,
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
    resetButton: {
      backgroundColor: c.primary,
      paddingVertical: 16,
      borderRadius: 12,
      width: '100%',
      alignItems: 'center' as const,
      marginBottom: 20,
    },
    resetButtonDisabled: {
      opacity: 0.7,
    },
    resetButtonText: {
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
  } as const;
}
