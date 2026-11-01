import { en } from "./en";
import { type UI, zhHK } from "./zh-HK";

export const locales = ["zh-HK", "en"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "zh-HK";

export const localeNames: Record<Locale, string> = { "zh-HK": "繁", en: "EN" };
export const ogLocale: Record<Locale, string> = { "zh-HK": "zh_HK", en: "en_US" };

const dictionaries: Record<Locale, UI> = { "zh-HK": zhHK, en };

export function t(locale: Locale): UI {
  return dictionaries[locale];
}

export function localePath(locale: Locale, path = "/"): string {
  if (locale === defaultLocale) return path;
  return path === "/" ? `/${locale}` : `/${locale}${path}`;
}
