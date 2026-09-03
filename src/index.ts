/**
 * glotforge — client entry.
 *
 * Copy lives in the source in your source language (English by default);
 * catalogs are keyed by content hash; the
 * build-time loader injects hashes so the runtime never hashes or
 * re-serializes. See README for setup.
 */

export { I18nProvider, useI18n, useI18nOptional, useT, useFormat } from "./runtime/context";
export type { I18nProviderProps, I18nContextValue } from "./runtime/context";
export { Trans, Plural } from "./runtime/trans";
export type { TransProps, PluralProps } from "./runtime/trans";
export { t, msg, createT, makeT } from "./runtime/t";
export type { TFunction, MessageDescriptor, TOptions } from "./runtime/t";
export { I18nDevtools } from "./runtime/devtools";
export {
  readLocaleCookie,
  writeLocaleCookie,
  pickLocale,
  dirForLocale,
  DEFAULT_COOKIE_NAME,
} from "./runtime/cookie";
export { PSEUDO_LOCALE, pseudoize } from "./runtime/pseudo";
export {
  formatDate,
  formatTime,
  formatNumber,
  formatCurrency,
  formatPercent,
  formatList,
  formatRelativeTime,
} from "./runtime/format";
export type { DateStyle } from "./runtime/format";
export { hashMessage } from "./shared/hash";
export type { Catalog, Manifest, MessageEntry, I18nConfig } from "./shared/types";
