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

export default function ResetPasswordScreen() {
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
      <View style={styles.container}>
        <View style={styles.content}>
          <View style={styles.iconCircle}>
            <Ionicons name="checkmark-circle-outline" size={64} color="#27ae60" />
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
          <Ionicons name="key-outline" size={64} color={PRIMARY} />
        </View>
        <Text style={styles.title}>{t('auth.resetPasswordScreen.setNew')}</Text>
        <Text style={styles.description}>
          {t('auth.resetPasswordScreen.instruction')}
        </Text>

        <View style={styles.inputContainer}>
          <Ionicons name="lock-closed-outline" size={20} color="#999" style={styles.inputIcon} />
          <TextInput
            style={styles.input}
            placeholder={t('auth.resetPasswordScreen.newPlaceholder')}
            placeholderTextColor="#999"
            value={password}
            onChangeText={setPassword}
            secureTextEntry={!showPassword}
            autoCapitalize="none"
          />
          <Pressable onPress={() => setShowPassword(!showPassword)} hitSlop={8}>
            <Ionicons
              name={showPassword ? 'eye-off-outline' : 'eye-outline'}
              size={22}
              color="#999"
            />
          </Pressable>
        </View>

        <View style={styles.inputContainer}>
          <Ionicons name="lock-closed-outline" size={20} color="#999" style={styles.inputIcon} />
          <TextInput
            style={styles.input}
            placeholder={t('auth.resetPasswordScreen.confirmPlaceholder')}
            placeholderTextColor="#999"
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            secureTextEntry={!showConfirm}
            autoCapitalize="none"
          />
          <Pressable onPress={() => setShowConfirm(!showConfirm)} hitSlop={8}>
            <Ionicons
              name={showConfirm ? 'eye-off-outline' : 'eye-outline'}
              size={22}
              color="#999"
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
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryButtonText}>{t('auth.resetPasswordScreen.save')}</Text>
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
  primaryButton: {
    backgroundColor: PRIMARY,
    paddingVertical: 16,
    borderRadius: 12,
    width: '100%',
    alignItems: 'center',
    marginBottom: 20,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  primaryButtonText: {
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
