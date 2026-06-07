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

const THEME_STORAGE_KEY = "agent.theme";

export function initTheme(): void {
  if (typeof document === "undefined") return;
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  const theme = stored === "dark" || stored === "light" ? stored : "light";
  document.documentElement.dataset.theme = theme;
  const platform = detectPlatform();
  if (platform) {
    document.documentElement.dataset.platform = platform;
  }
}

export function setTheme(theme: "light" | "dark"): void {
  window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  document.documentElement.dataset.theme = theme;
}

function detectPlatform(): "darwin" | "win32" | "linux" | undefined {
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
