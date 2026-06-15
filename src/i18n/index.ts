import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import * as Localization from 'expo-localization';
import en from './en.json';
import hi from './hi.json';

const deviceLang = Localization.getLocales()[0]?.languageCode ?? 'en';

i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, hi: { translation: hi } },
  lng: deviceLang.startsWith('hi') ? 'hi' : 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

export default i18n;
