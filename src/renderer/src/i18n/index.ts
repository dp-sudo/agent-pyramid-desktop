import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { DEFAULT_LOCALE, isSupportedLocale, type LocaleCode } from "../../../shared/locale";
import {
  loadBasicPreferences,
  saveBasicPreferences,
  type ThemePreference,
} from "../ui/preferences";
import en from "./locales/en/translation.json";
import zhCN from "./locales/zh-CN/translation.json";

const LANGUAGE_STORAGE_KEY = "agent-pyramid.locale";

function getInitialLocale(): LocaleCode {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  const savedLocale = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  return savedLocale && isSupportedLocale(savedLocale) ? savedLocale : DEFAULT_LOCALE;
}

export function persistLocale(locale: LocaleCode): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, locale);
}

export function initTheme(): void {
  if (typeof document === "undefined") return;
  const preferences = loadBasicPreferences();
  document.documentElement.dataset.theme = resolveThemePreference(preferences);
  const platform = detectPlatform();
  if (platform) {
    document.documentElement.dataset.platform = platform;
  }
}

export function setTheme(theme: ThemePreference): void {
  const nextPreferences = saveBasicPreferences({
    ...loadBasicPreferences(),
    theme,
    followSystemTheme: false,
  });
  document.documentElement.dataset.theme = resolveThemePreference(nextPreferences);
}

export function setFollowSystemTheme(enabled: boolean): void {
  const nextPreferences = saveBasicPreferences({
    ...loadBasicPreferences(),
    followSystemTheme: enabled,
  });
  document.documentElement.dataset.theme = resolveThemePreference(nextPreferences);
}

export function resolveThemePreference(preferences = loadBasicPreferences()): ThemePreference {
  if (preferences.followSystemTheme) return getSystemThemePreference();
  return preferences.theme;
}

function getSystemThemePreference(): ThemePreference {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function detectPlatform(): "darwin" | "win32" | "linux" | undefined {
  if (typeof navigator === "undefined") return undefined;
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac")) return "darwin";
  if (ua.includes("win")) return "win32";
  if (ua.includes("linux")) return "linux";
  return undefined;
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
