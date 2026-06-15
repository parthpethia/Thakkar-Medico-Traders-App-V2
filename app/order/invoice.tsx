import React, { useEffect, useState } from 'react';
import { View, ActivityIndicator, StyleSheet, Alert, Platform } from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import { WebView } from 'react-native-webview';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { supabase } from '../../src/services/supabase';
import { withRetry } from '../../src/utils/retryable';

export default function InvoiceScreen() {
  const { orderId, type, retailerId, month } = useLocalSearchParams<{
    orderId: string;
    type?: 'invoice' | 'statement';
    retailerId?: string;
    month?: string;
  }>();

  const [htmlContent, setHtmlContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isStatement = type === 'statement';
  const title = isStatement ? 'Statement' : 'Invoice';

  useEffect(() => {
    fetchDocument();
  }, [orderId, type, retailerId, month]);

  async function fetchDocument() {
    try {
      setLoading(true);
      setError(null);

      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setError('Not authenticated');
        setLoading(false);
        return;
      }

      const baseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
      const endpoint = isStatement
        ? `${baseUrl}/functions/v1/generate-statement`
        : `${baseUrl}/functions/v1/generate-invoice`;

      const body = isStatement
        ? { retailer_id: retailerId, month }
        : { order_id: orderId };

      const html = await withRetry(async () => {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          throw new Error(`Failed to load ${title.toLowerCase()}: ${response.status}`);
        }

        return response.text();
      });

      setHtmlContent(html);
    } catch (err: any) {
      setError(err?.message || 'Failed to load document');
    } finally {
      setLoading(false);
    }
  }

  async function handleSharePrint() {
    if (!htmlContent) return;

    try {
      if (Platform.OS !== 'web') {
        await Print.printAsync({ html: htmlContent });
      } else {
        const isAvailable = await Sharing.isAvailableAsync();
        if (isAvailable) {
          Alert.alert('Info', 'Sharing is not supported on web.');
        }
      }
    } catch {
      Alert.alert('Error', 'Could not print or share the document.');
    }
  }

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title,
          headerRight: () =>
            htmlContent ? (
              <HeaderButton onPress={handleSharePrint} />
            ) : null,
        }}
      />

      {loading && (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#2563eb" />
        </View>
      )}

      {error && !loading && (
        <View style={styles.centered}>
          <ErrorView message={error} onRetry={fetchDocument} />
        </View>
      )}

      {htmlContent && !loading && (
        <WebView
          source={{ html: htmlContent }}
          style={styles.webview}
          originWhitelist={['*']}
        />
      )}
    </View>
  );
}

function HeaderButton({ onPress }: { onPress: () => void }) {
  const { Text, TouchableOpacity } = require('react-native');
  return (
    <TouchableOpacity onPress={onPress} style={{ paddingHorizontal: 12 }}>
      <Text style={{ color: '#2563eb', fontSize: 16, fontWeight: '600' }}>
        Share / Print
      </Text>
    </TouchableOpacity>
  );
}

function ErrorView({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { Text, TouchableOpacity } = require('react-native');
  return (
    <View style={{ alignItems: 'center', padding: 24 }}>
      <Text style={{ color: '#dc2626', fontSize: 16, marginBottom: 16, textAlign: 'center' }}>
        {message}
      </Text>
      <TouchableOpacity
        onPress={onRetry}
        style={{ backgroundColor: '#2563eb', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 }}
      >
        <Text style={{ color: '#fff', fontWeight: '600' }}>Retry</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  webview: {
    flex: 1,
  },
});
