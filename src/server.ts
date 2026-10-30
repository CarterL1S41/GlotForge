/**
 * glotforge/server — server-side entry (no "use client").
 *
 * The no-flash recipe in a Next.js App Router layout:
 *
 *   import { cookies } from "next/headers";
 *   import { readLocaleCookie, pickLocale } from "glotforge/server";
 *
 *   const cookieStore = await cookies();
 *   const locale = pickLocale(
 *     cookieStore.get("glotforge_locale")?.value,
 *     SUPPORTED_LOCALES,
 *     "en-US",
 *   );
 *   const catalog =
 *     locale === "en-US"
 *       ? null
 *       : (await import(`@/i18n/catalog/${locale}.json`)).default;
 *   // <I18nProvider initialLocale={locale} initialCatalog={catalog} ...>
 *
 * createT(locale, catalog) gives server code a per-request t() — the global
 * client `t` deliberately does not read request state on the server.
 */

export {
  readLocaleCookie,
  pickLocale,
  dirForLocale,
  DEFAULT_COOKIE_NAME,
} from "./runtime/cookie";
export { createT, makeT, msg, translateDescriptor } from "./runtime/t";
export type { TFunction, MessageDescriptor, TOptions } from "./runtime/t";
export { hashMessage } from "./shared/hash";
export {
  parseMessage,
  serializeMessage,
  validateTranslation,
  escapeText,
} from "./shared/message";
export type { MessageNode } from "./shared/message";
export type {
  Catalog,
  Manifest,
  MessageEntry,
  I18nConfig,
  VoiceManifest,
  VoiceEntry,
  VoiceClip,
  VoiceWord,
  VoiceTiming,
} from "./shared/types";
