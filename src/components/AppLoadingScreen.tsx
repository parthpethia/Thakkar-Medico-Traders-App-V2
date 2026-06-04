import React from 'react';
import {
  View,
  ActivityIndicator,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

type Props = {
  message?: string;
  onRetry?: () => void;
};

export function AppLoadingScreen({ message = 'Loading...', onRetry }: Props) {
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Image
          source={require('../../assets/icon.png')}
          style={styles.logo}
          resizeMode="contain"
        />
        <Text style={styles.title}>Thakkar Medico Traders</Text>
        <ActivityIndicator size="large" color="#4C51C9" style={styles.spinner} />
        <Text style={styles.message}>{message}</Text>
        {onRetry ? (
          <TouchableOpacity style={styles.retryButton} onPress={onRetry}>
            <Text style={styles.retryText}>Try again</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </SafeAreaView>
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
    alignItems: 'center',
    padding: 24,
  },
  logo: {
    width: 88,
    height: 88,
    borderRadius: 18,
    marginBottom: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#4C51C9',
    marginBottom: 32,
    textAlign: 'center',
  },
  spinner: {
    marginBottom: 12,
  },
  message: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
  },
  retryButton: {
    marginTop: 20,
    backgroundColor: '#4C51C9',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
  },
  retryText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 16,
  },
});
