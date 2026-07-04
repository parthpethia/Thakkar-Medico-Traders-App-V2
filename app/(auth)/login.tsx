// PA: CRIT-3 — Wire biometric sign-in on login screen
import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Alert,
  Image,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, Link } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../../src/store/authStore';
import {
  authenticateWithBiometric,
  checkBiometricAvailable,
  hasStoredCredentials,
  storeCredentials,
} from '../../src/hooks/useBiometric';
import { routeForUser } from '../_layout';
import { APP_VERSION, SUPPORT_EMAIL } from '../../src/constants/config';
import { supabaseConfigError } from '../../src/services/supabase';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import type { AppColors } from '../../src/theme/colors';

function biometricTypeLabel(type: string): string {
  switch (type) {
    case 'face':
      return 'Face ID';
    case 'fingerprint':
      return 'Fingerprint';
    case 'iris':
      return 'Iris';
    default:
      return 'Biometric';
  }
}

export default function Login() {
  const styles = useThemedStyles(createLoginStyles);
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const { login, isLoading, error, initError, clearError } = useAuthStore();
  const setupMessage = initError || error;

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showBiometric, setShowBiometric] = useState(false);
  const [biometricType, setBiometricType] = useState('biometric');
  const [biometricLoading, setBiometricLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [{ available, type }, hasCreds] = await Promise.all([
        checkBiometricAvailable(),
        hasStoredCredentials(),
      ]);
      if (cancelled) return;
      if (available && hasCreds) {
        setBiometricType(type);
        setShowBiometric(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const navigateAfterLogin = () => {
    const currentUser = useAuthStore.getState().user;
    if (!currentUser) return;
    router.replace(routeForUser(currentUser));
  };

  const handleLogin = async () => {
    clearError();
    if (supabaseConfigError) {
      Alert.alert(t('auth.loginFailed'), supabaseConfigError);
      return;
    }
    if (!identifier.trim() || !password) {
      Alert.alert(t('common.error'), t('auth.emailOrPhone'));
      return;
    }

    const success = await login(identifier.trim(), password);

    if (!success) {
      const message = useAuthStore.getState().error || t('auth.invalidCredentials');
      Alert.alert(t('auth.loginFailed'), message);
      return;
    }

    const resolvedEmail = useAuthStore.getState().user?.email;
    if (resolvedEmail) {
      await storeCredentials(resolvedEmail, password);
    }

    navigateAfterLogin();
  };

  const handleBiometricLogin = async () => {
    if (biometricLoading || isLoading) return;
    setBiometricLoading(true);
    clearError();

    try {
      const result = await authenticateWithBiometric();
      if (!result.success || !result.email || !result.password) {
        Alert.alert(t('auth.loginFailed'), t('auth.login.biometricFailed'));
        return;
      }

      const success = await login(result.email, result.password);
      if (!success) {
        Alert.alert(
          t('auth.loginFailed'),
          t('auth.login.biometricFailed'),
        );
        return;
      }

      navigateAfterLogin();
    } finally {
      setBiometricLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.header}>
            <Image
              source={require('../../assets/icon.png')}
              style={styles.logo}
              resizeMode="contain"
            />
            <Text style={styles.title}>{t('auth.login.title')}</Text>
            <Text style={styles.subtitle}>{t('auth.login.title')}</Text>
          </View>

          {setupMessage ? (
            <View style={styles.setupBanner}>
              <Text style={styles.setupBannerText}>{setupMessage}</Text>
            </View>
          ) : null}

          <View style={styles.form}>
            <View style={styles.inputContainer}>
              <Ionicons
                name={identifier.includes('@') ? 'mail-outline' : 'call-outline'}
                size={20}
                color={colors.textSecondary}
              />
              <TextInput
                style={styles.input}
                placeholder={t('auth.emailOrPhone')}
                placeholderTextColor={colors.textMuted}
                value={identifier}
                onChangeText={setIdentifier}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={/^\d+$/.test(identifier) ? 10 : 120}
              />
            </View>

            <View style={styles.inputContainer}>
              <Ionicons name="lock-closed-outline" size={20} color={colors.textSecondary} />
              <TextInput
                style={styles.input}
                placeholder={t('auth.password')}
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

            <View style={styles.forgotRow}>
              <Link href="/(auth)/forgot-password">
                <Text style={styles.forgotLink}>{t('auth.forgotPassword')}</Text>
              </Link>
            </View>

            <TouchableOpacity
              style={[styles.loginButton, isLoading && styles.buttonDisabled]}
              onPress={handleLogin}
              disabled={isLoading}
            >
              <Text style={styles.loginButtonText}>
                {isLoading ? t('auth.signingIn') : t('auth.signIn')}
              </Text>
            </TouchableOpacity>

            {showBiometric ? (
              <TouchableOpacity
                style={[styles.biometricButton, (isLoading || biometricLoading) && styles.buttonDisabled]}
                onPress={handleBiometricLogin}
                disabled={isLoading || biometricLoading}
              >
                <Ionicons name="finger-print-outline" size={22} color={colors.primary} />
                <Text style={styles.biometricButtonText}>
                  {t('auth.login.biometric', { type: biometricTypeLabel(biometricType) })}
                </Text>
              </TouchableOpacity>
            ) : null}

            <View style={styles.registerRow}>
              <Text style={styles.registerText}>{t('auth.noAccount')} </Text>
              <Link href="/(auth)/register">
                <Text style={styles.registerLink}>{t('auth.signUp')}</Text>
              </Link>
            </View>

            <View style={styles.footerMeta}>
              <Text style={styles.versionText}>Version {APP_VERSION}</Text>
              <TouchableOpacity
                onPress={() => Linking.openURL(`mailto:${SUPPORT_EMAIL}?subject=Sales%20Inquiry`)}
              >
                <Text style={styles.contactSales}>{t('auth.contactSalesRep')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function createLoginStyles(c: AppColors) {
  return {
  container: { flex: 1, backgroundColor: c.background },
  scrollContent: {
    flexGrow: 1,
    padding: 24,
    justifyContent: 'center',
  },
  header: { alignItems: 'center', marginBottom: 40 },
  logo: {
    width: 100,
    height: 100,
    borderRadius: 20,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: c.primary,
    marginTop: 16,
  },
  subtitle: { fontSize: 16, color: c.textSecondary, marginTop: 8 },
  form: { gap: 16 },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: c.inputBackground,
    borderRadius: 12,
    paddingHorizontal: 16,
    height: 56,
    gap: 12,
  },
  input: { flex: 1, fontSize: 16, color: c.text },
  forgotRow: {
    alignItems: 'flex-end',
    marginTop: -4,
  },
  forgotLink: {
    color: c.primary,
    fontSize: 14,
    fontWeight: '600',
  },
  loginButton: {
    backgroundColor: c.primary,
    height: 56,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  biometricButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    height: 56,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: c.primary,
    backgroundColor: c.surface,
  },
  biometricButtonText: {
    color: c.primary,
    fontSize: 16,
    fontWeight: '600',
  },
  buttonDisabled: { opacity: 0.7 },
  loginButtonText: {
    color: c.onPrimary,
    fontSize: 18,
    fontWeight: '600',
  },
  registerRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: 16,
  },
  registerText: { color: c.textSecondary },
  registerLink: {
    color: c.primary,
    fontWeight: '600',
  },
  setupBanner: {
    backgroundColor: c.warningBg,
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
  },
  setupBannerText: {
    color: c.warning,
    fontSize: 13,
    lineHeight: 18,
  },
  footerMeta: {
    marginTop: 24,
    alignItems: 'center',
    gap: 8,
  },
  versionText: { fontSize: 12, color: c.textMuted },
  contactSales: { fontSize: 13, color: c.primary, fontWeight: '600' as const },
} as const;
}
