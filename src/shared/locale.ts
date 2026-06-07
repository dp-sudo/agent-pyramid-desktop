export const SUPPORTED_LOCALES = ["zh-CN", "en"] as const;

export type LocaleCode = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: LocaleCode = "zh-CN";

export function isSupportedLocale(value: string): value is LocaleCode {
  return SUPPORTED_LOCALES.includes(value as LocaleCode);
}
