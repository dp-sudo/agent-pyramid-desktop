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
const SYSTEM_THEME_QUERY = "(prefers-color-scheme: dark)";

let systemThemeMediaQuery: MediaQueryList | null = null;
let systemThemeListener: ((event: MediaQueryListEvent) => void) | null = null;

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
  applyThemePreference(preferences);
  configureSystemThemeListener(preferences.followSystemTheme);
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
  applyThemePreference(nextPreferences);
  configureSystemThemeListener(false);
}

export function setFollowSystemTheme(enabled: boolean): void {
  const nextPreferences = saveBasicPreferences({
    ...loadBasicPreferences(),
    followSystemTheme: enabled,
  });
  applyThemePreference(nextPreferences);
  configureSystemThemeListener(enabled);
}

export function resolveThemePreference(preferences = loadBasicPreferences()): ThemePreference {
  if (preferences.followSystemTheme) return getSystemThemePreference();
  return preferences.theme;
}

function getSystemThemePreference(): ThemePreference {
  const mediaQuery = getSystemThemeMediaQuery();
  if (!mediaQuery) {
    return "light";
  }
  return mediaQuery.matches ? "dark" : "light";
}

function applyThemePreference(preferences = loadBasicPreferences()): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = resolveThemePreference(preferences);
}

function configureSystemThemeListener(enabled: boolean): void {
  const mediaQuery = getSystemThemeMediaQuery();
  removeSystemThemeListener();
  if (!enabled || !mediaQuery) return;

  const listener = (): void => {
    const preferences = loadBasicPreferences();
    if (!preferences.followSystemTheme) {
      removeSystemThemeListener();
      applyThemePreference(preferences);
      return;
    }
    applyThemePreference(preferences);
  };
  systemThemeMediaQuery = mediaQuery;
  systemThemeListener = listener;
  addMediaQueryListener(mediaQuery, listener);
}

function removeSystemThemeListener(): void {
  if (!systemThemeMediaQuery || !systemThemeListener) {
    systemThemeMediaQuery = null;
    systemThemeListener = null;
    return;
  }
  removeMediaQueryListener(systemThemeMediaQuery, systemThemeListener);
  systemThemeMediaQuery = null;
  systemThemeListener = null;
}

function getSystemThemeMediaQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }
  return window.matchMedia(SYSTEM_THEME_QUERY);
}

function addMediaQueryListener(
  mediaQuery: MediaQueryList,
  listener: (event: MediaQueryListEvent) => void,
): void {
  if (typeof mediaQuery.addEventListener === "function") {
    mediaQuery.addEventListener("change", listener);
    return;
  }
  mediaQuery.addListener(listener);
}

function removeMediaQueryListener(
  mediaQuery: MediaQueryList,
  listener: (event: MediaQueryListEvent) => void,
): void {
  if (typeof mediaQuery.removeEventListener === "function") {
    mediaQuery.removeEventListener("change", listener);
    return;
  }
  mediaQuery.removeListener(listener);
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
