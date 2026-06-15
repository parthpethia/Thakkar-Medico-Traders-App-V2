import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Dimensions,
  FlatList,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
  ViewToken,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

const { width, height } = Dimensions.get('window');

const PRIMARY = '#4C51C9';

interface OnboardingPage {
  id: string;
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle: string;
}

const pages: OnboardingPage[] = [
  {
    id: '1',
    icon: 'cart-outline',
    title: 'Order Smarter',
    subtitle:
      'Place orders for medicines and healthcare products from Thakkar Medico Traders — anytime, anywhere.',
  },
  {
    id: '2',
    icon: 'location-outline',
    title: 'Track Every Order',
    subtitle:
      'Get real-time updates on your order status from approval to delivery, right on your phone.',
  },
  {
    id: '3',
    icon: 'rocket-outline',
    title: 'Get Started',
    subtitle: '',
  },
];

export default function OnboardingScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const flatListRef = useRef<FlatList>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem('onboarding_complete').then((value) => {
      if (value === 'true') {
        router.replace('/(auth)/login');
      } else {
        setReady(true);
      }
    });
  }, []);

  const completeOnboarding = useCallback(async () => {
    await AsyncStorage.setItem('onboarding_complete', 'true');
  }, []);

  const handleSkip = useCallback(async () => {
    await completeOnboarding();
    router.replace('/(auth)/login');
  }, []);

  const handleNext = useCallback(() => {
    if (currentIndex < pages.length - 1) {
      flatListRef.current?.scrollToIndex({ index: currentIndex + 1 });
    }
  }, [currentIndex]);

  const handleSignIn = useCallback(async () => {
    await completeOnboarding();
    router.replace('/(auth)/login');
  }, []);

  const handleContactSales = useCallback(() => {
    Linking.openURL('https://wa.me/919999999999');
  }, []);

  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      if (viewableItems.length > 0 && viewableItems[0].index != null) {
        setCurrentIndex(viewableItems[0].index);
      }
    }
  ).current;

  const viewabilityConfig = useRef({ viewAreaCoveragePercentThreshold: 50 }).current;

  if (!ready) return null;

  const renderPage = ({ item, index }: { item: OnboardingPage; index: number }) => (
    <View style={styles.page}>
      <View style={styles.iconContainer}>
        <Ionicons name={item.icon} size={120} color={PRIMARY} />
      </View>
      <Text style={styles.title}>{index === 0 ? t('onboarding.screen1Title') : index === 1 ? t('onboarding.screen2Title') : t('onboarding.screen3Title')}</Text>
      {index < 2 ? <Text style={styles.subtitle}>{index === 0 ? t('onboarding.screen1Subtitle') : t('onboarding.screen2Subtitle')}</Text> : null}

      {index === 2 && (
        <View style={styles.ctaContainer}>
          <Pressable style={styles.signInButton} onPress={handleSignIn}>
            <Text style={styles.signInButtonText}>{t('onboarding.signIn')}</Text>
          </Pressable>
          <Pressable style={styles.contactLink} onPress={handleContactSales}>
            <Ionicons name="logo-whatsapp" size={20} color="#25D366" />
            <Text style={styles.contactLinkText}>{t('onboarding.contactSales')}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );

  return (
    <View style={styles.container}>
      {currentIndex < 2 && (
        <Pressable style={styles.skipButton} onPress={handleSkip}>
          <Text style={styles.skipText}>{t('onboarding.skip')}</Text>
        </Pressable>
      )}

      <FlatList
        ref={flatListRef}
        data={pages}
        renderItem={renderPage}
        keyExtractor={(item) => item.id}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        bounces={false}
      />

      <View style={styles.footer}>
        <View style={styles.dotsContainer}>
          {pages.map((_, i) => (
            <View
              key={i}
              style={[styles.dot, i === currentIndex && styles.dotActive]}
            />
          ))}
        </View>

        {currentIndex < 2 && (
          <Pressable style={styles.nextButton} onPress={handleNext}>
            <Text style={styles.nextButtonText}>{t('onboarding.next')}</Text>
            <Ionicons name="arrow-forward" size={18} color="#fff" />
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  skipButton: {
    position: 'absolute',
    top: 56,
    right: 24,
    zIndex: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  skipText: {
    fontSize: 16,
    color: PRIMARY,
    fontWeight: '600',
  },
  page: {
    width,
    height,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
  },
  iconContainer: {
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: `${PRIMARY}10`,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 40,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#1a1a2e',
    textAlign: 'center',
    marginBottom: 16,
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
    lineHeight: 24,
  },
  ctaContainer: {
    marginTop: 40,
    alignItems: 'center',
    width: '100%',
  },
  signInButton: {
    backgroundColor: PRIMARY,
    paddingVertical: 16,
    paddingHorizontal: 48,
    borderRadius: 12,
    width: '100%',
    alignItems: 'center',
  },
  signInButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  contactLink: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 20,
    gap: 8,
  },
  contactLinkText: {
    fontSize: 16,
    color: '#25D366',
    fontWeight: '600',
  },
  footer: {
    position: 'absolute',
    bottom: 60,
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  dotsContainer: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 24,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#ddd',
  },
  dotActive: {
    backgroundColor: PRIMARY,
    width: 28,
  },
  nextButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: PRIMARY,
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: 12,
    gap: 8,
  },
  nextButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
