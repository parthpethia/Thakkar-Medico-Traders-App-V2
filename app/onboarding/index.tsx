import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Dimensions,
  FlatList,
  Linking,
  Pressable,
  Text,
  View,
  ViewToken,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import { AppLoadingScreen } from '../../src/components/AppLoadingScreen';

import type { AppColors } from '../../src/theme/colors';

const { width, height } = Dimensions.get('window');

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
  const styles = useThemedStyles(createOnboardingStyles);
  const { colors } = useAppTheme();
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

  if (!ready) {
    return <AppLoadingScreen message="Loading…" />;
  }

  const renderPage = ({ item, index }: { item: OnboardingPage; index: number }) => (
    <View style={styles.page}>
      <View style={styles.iconContainer}>
        <Ionicons name={item.icon} size={120} color={colors.primary} />
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
            <Ionicons name="arrow-forward" size={18} color={colors.onPrimary} />
          </Pressable>
        )}
      </View>
    </View>
  );
}

function createOnboardingStyles(c: AppColors) {
  return {
  container: {
    flex: 1,
    backgroundColor: c.background,
  },
  skipButton: {
    position: 'absolute' as const,
    top: 56,
    right: 24,
    zIndex: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  skipText: {
    fontSize: 16,
    color: c.primary,
    fontWeight: '600' as const,
  },
  page: {
    width,
    height,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    paddingHorizontal: 40,
  },
  iconContainer: {
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: c.primaryMuted,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    marginBottom: 40,
  },
  title: {
    fontSize: 28,
    fontWeight: '700' as const,
    color: c.text,
    textAlign: 'center' as const,
    marginBottom: 16,
  },
  subtitle: {
    fontSize: 16,
    color: c.textSecondary,
    textAlign: 'center' as const,
    lineHeight: 24,
  },
  ctaContainer: {
    marginTop: 40,
    alignItems: 'center' as const,
    width: '100%',
  },
  signInButton: {
    backgroundColor: c.primary,
    paddingVertical: 16,
    paddingHorizontal: 48,
    borderRadius: 12,
    width: '100%',
    alignItems: 'center' as const,
  },
  signInButtonText: {
    color: c.onPrimary,
    fontSize: 18,
    fontWeight: '700' as const,
  },
  contactLink: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    marginTop: 20,
    gap: 8,
  },
  contactLinkText: {
    fontSize: 16,
    color: '#25D366',
    fontWeight: '600' as const,
  },
  footer: {
    position: 'absolute' as const,
    bottom: 60,
    left: 0,
    right: 0,
    alignItems: 'center' as const,
    paddingHorizontal: 24,
  },
  dotsContainer: {
    flexDirection: 'row' as const,
    gap: 8,
    marginBottom: 24,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: c.border,
  },
  dotActive: {
    backgroundColor: c.primary,
    width: 28,
  },
  nextButton: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    backgroundColor: c.primary,
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: 12,
    gap: 8,
  },
  nextButtonText: {
    color: c.onPrimary,
    fontSize: 16,
    fontWeight: '600' as const,
  },
};
}
