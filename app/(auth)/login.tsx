import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Alert,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, Link } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../../src/store/authStore';

export default function Login() {
  const router = useRouter();
  const { login, isLoading, error, initError, clearError } = useAuthStore();
  const setupMessage = initError || error;


  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const handleLogin = async () => {
    clearError();
    if (!identifier.trim() || !password) {
      Alert.alert('Error', 'Please enter email or phone and password');
      return;
    }

    const success = await login(identifier.trim(), password);

    if (!success) {
      const message = useAuthStore.getState().error || 'Invalid credentials';
      Alert.alert('Login Failed', message);
      return;
    }

    const currentUser = useAuthStore.getState().user;

    if (currentUser?.role === 'admin') {
      router.replace('/admin');
      return;
    }

    if (currentUser?.role === 'delivery') {
      router.replace('/delivery');
      return;
    }

    router.replace('/(tabs)');
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
          {/* Header */}
          <View style={styles.header}>
            <Image
              source={require('../../assets/icon.png')}
              style={styles.logo}
              resizeMode="contain"
            />
            <Text style={styles.title}>Thakkar Medico Traders</Text>
            <Text style={styles.subtitle}>Welcome back!</Text>
          </View>

          {setupMessage ? (
            <View style={styles.setupBanner}>
              <Text style={styles.setupBannerText}>{setupMessage}</Text>
            </View>
          ) : null}

          {/* Form */}
          <View style={styles.form}>
            <View style={styles.inputContainer}>
              <Ionicons
                name={identifier.includes('@') ? 'mail-outline' : 'call-outline'}
                size={20}
                color="#666"
              />
              <TextInput
                style={styles.input}
                placeholder="Email or Phone (10 digits)"
                placeholderTextColor="#999"
                value={identifier}
                onChangeText={setIdentifier}
                keyboardType={identifier.includes('@') ? 'email-address' : 'phone-pad'}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={identifier.includes('@') ? 120 : 10}
              />
            </View>

            <View style={styles.inputContainer}>
              <Ionicons name="lock-closed-outline" size={20} color="#666" />
              <TextInput
                style={styles.input}
                placeholder="Password"
                placeholderTextColor="#999"
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!showPassword}
              />
              <TouchableOpacity onPress={() => setShowPassword(!showPassword)}>
                <Ionicons
                  name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                  size={20}
                  color="#666"
                />
              </TouchableOpacity>
            </View>

            <View style={styles.forgotRow}>
              <Link href="/(auth)/forgot-password">
                <Text style={styles.forgotLink}>Forgot password?</Text>
              </Link>
            </View>

            <TouchableOpacity
              style={[styles.loginButton, isLoading && styles.buttonDisabled]}
              onPress={handleLogin}
              disabled={isLoading}
            >
              <Text style={styles.loginButtonText}>
                {isLoading ? 'Signing in...' : 'Sign In'}
              </Text>
            </TouchableOpacity>

            <View style={styles.registerRow}>
              <Text style={styles.registerText}>Don't have an account? </Text>
              <Link href="/(auth)/register">
                <Text style={styles.registerLink}>Register</Text>
              </Link>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
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
    color: '#4C51C9',
    marginTop: 16,
  },
  subtitle: { fontSize: 16, color: '#666', marginTop: 8 },
  form: { gap: 16 },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f5f5f5',
    borderRadius: 12,
    paddingHorizontal: 16,
    height: 56,
    gap: 12,
  },
  input: { flex: 1, fontSize: 16, color: '#333' },
  forgotRow: {
    alignItems: 'flex-end',
    marginTop: -4,
  },
  forgotLink: {
    color: '#4C51C9',
    fontSize: 14,
    fontWeight: '600',
  },
  loginButton: {
    backgroundColor: '#4C51C9',
    height: 56,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: { opacity: 0.7 },
  loginButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  registerRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: 16,
  },
  registerText: { color: '#666' },
  registerLink: {
    color: '#4C51C9',
    fontWeight: '600',
  },
  setupBanner: {
    backgroundColor: '#FFF3E0',
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
  },
  setupBannerText: {
    color: '#E65100',
    fontSize: 13,
    lineHeight: 18,
  },
});
