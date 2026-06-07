import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { DEFAULT_LOCALE, isSupportedLocale, type LocaleCode } from "../../../shared/locale";
import en from "./locales/en/translation.json";
import zhCN from "./locales/zh-CN/translation.json";

const LANGUAGE_STORAGE_KEY = "agent-pyramid.locale";

function getInitialLocale(): LocaleCode {
  const savedLocale = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  return savedLocale && isSupportedLocale(savedLocale) ? savedLocale : DEFAULT_LOCALE;
}

export function persistLocale(locale: LocaleCode): void {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, locale);
}

void i18n.use(initReactI18next).init({
  resources: {
    "zh-CN": {
      translation: zhCN
    },
    en: {
      translation: en
    }
  },
  lng: getInitialLocale(),
  fallbackLng: DEFAULT_LOCALE,
  interpolation: {
    escapeValue: false
  },
  returnEmptyString: false
});

export { i18n };
