import React, { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../src/services/supabase';

const PRIMARY = '#4C51C9';

export default function ForgotPasswordScreen() {
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
      <View style={styles.container}>
        <View style={styles.content}>
          <View style={styles.iconCircle}>
            <Ionicons name="mail-outline" size={64} color={PRIMARY} />
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
            <Ionicons name="arrow-back" size={18} color={PRIMARY} />
            <Text style={styles.backButtonText}>{t('auth.forgotPasswordScreen.back')}</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.content}>
        <View style={styles.iconCircle}>
          <Ionicons name="lock-closed-outline" size={64} color={PRIMARY} />
        </View>
        <Text style={styles.title}>{t('auth.forgotPasswordScreen.title')}</Text>
        <Text style={styles.description}>
          {t('auth.forgotPasswordScreen.instruction')}
        </Text>

        <View style={styles.inputContainer}>
          <Ionicons name="mail-outline" size={20} color="#999" style={styles.inputIcon} />
          <TextInput
            style={styles.input}
            placeholder={t('auth.forgotPasswordScreen.emailPlaceholder')}
            placeholderTextColor="#999"
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
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.resetButtonText}>{t('auth.forgotPasswordScreen.send')}</Text>
          )}
        </Pressable>

        <Pressable
          style={styles.backButton}
          onPress={() => router.replace('/(auth)/login')}
        >
          <Ionicons name="arrow-back" size={18} color={PRIMARY} />
          <Text style={styles.backButtonText}>{t('auth.forgotPasswordScreen.back')}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
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
    backgroundColor: `${PRIMARY}10`,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 32,
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    color: '#1a1a2e',
    marginBottom: 12,
    textAlign: 'center',
  },
  description: {
    fontSize: 15,
    color: '#666',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 32,
  },
  emailHighlight: {
    fontWeight: '600',
    color: PRIMARY,
  },
  hint: {
    fontSize: 14,
    color: '#888',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 32,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f5f5f7',
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
    color: '#1a1a2e',
  },
  errorText: {
    color: '#e74c3c',
    fontSize: 14,
    marginBottom: 16,
    textAlign: 'center',
  },
  resetButton: {
    backgroundColor: PRIMARY,
    paddingVertical: 16,
    borderRadius: 12,
    width: '100%',
    alignItems: 'center',
    marginBottom: 20,
  },
  resetButtonDisabled: {
    opacity: 0.7,
  },
  resetButtonText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
  },
  backButtonText: {
    color: PRIMARY,
    fontSize: 15,
    fontWeight: '600',
  },
});
