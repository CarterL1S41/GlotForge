"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Catalog, VoiceManifest } from "../shared/types";
import {
  DEFAULT_COOKIE_NAME,
  dirForLocale,
  readLocaleCookie,
  writeLocaleCookie,
} from "./cookie";
import { PSEUDO_LOCALE } from "./pseudo";
import { setRuntimeSnapshot, type RuntimeSnapshot } from "./store";
import { makeT, type TFunction } from "./t";
import {
  formatCurrency,
  formatDate,
  formatList,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  formatTime,
  type DateStyle,
} from "./format";

export interface I18nProviderProps {
  /** Locales offered to the user (include the source locale). */
  locales: string[];
  /** Locale the source code is written in. Default "en-US". */
  sourceLocale?: string;
  /** Used when nothing is stored. Default: sourceLocale. */
  defaultLocale?: string;
  /**
   * The locale resolved on the SERVER from the cookie (readLocaleCookie +
   * pickLocale). Passing it makes the first paint render translated — this
   * is the no-flash path. Omit only in fully client-rendered apps.
   */
  initialLocale?: string;
  /** The initialLocale's catalog, loaded server-side. Pairs with initialLocale. */
  initialCatalog?: Catalog | null;
  /**
   * Lazy per-locale catalog import, e.g.
   *   (locale) => import(`@/i18n/catalog/${locale}.json`).then((m) => m.default)
   * Only the active locale is ever loaded.
   */
  loadCatalog?: (locale: string) => Promise<Catalog>;
  /** locale -> font key, written to <html data-i18n-font> for CSS font stacks. */
  fontMap?: Record<string, string>;
  /**
   * Lazy per-locale audio catalog import, e.g.
   *   (locale) => import(`@/i18n/voice/${locale}.json`).then((m) => m.default)
   * Loaded for the active locale (the source locale too) when set; omit it
   * in apps without spoken audio.
   */
  loadVoiceManifest?: (locale: string) => Promise<VoiceManifest>;
  /**
   * URL prefix the clip files are served from — the app's public path for
   * the CLI's voice.audioDir. Default "/audio/i18n".
   */
  audioBaseUrl?: string;
  cookieName?: string;
  /** localStorage key prefix. Default "glotforge". */
  storagePrefix?: string;
  /**
   * Server-controlled permission for the translation devtools (hover
   * inspector, locale switcher, pseudo-locale). Users only see the toggle
   * when this is true — wire it to a flag on the user record.
   */
  devtoolsAllowed?: boolean;
  onLocaleChange?: (locale: string) => void;
  children: ReactNode;
}

export interface I18nContextValue {
  locale: string;
  setLocale: (locale: string) => void;
  locales: string[];
  sourceLocale: string;
  catalog: Catalog | null;
  /** "loading" only when a non-source locale's catalog isn't available yet. */
  status: "ready" | "loading";
  pseudo: boolean;
  devtoolsAllowed: boolean;
  devtoolsActive: boolean;
  setDevtoolsActive: (active: boolean) => void;
  storagePrefix: string;
  /** Audio catalog for the effective locale, when the provider loads one. */
  voiceManifest: VoiceManifest | null;
  /** "unavailable" when no loadVoiceManifest was given. */
  voiceStatus: "ready" | "loading" | "unavailable";
  audioBaseUrl: string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function safeStorageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private windows / blocked storage — persistence is best-effort.
  }
}

export function I18nProvider(props: I18nProviderProps) {
  const {
    locales,
    sourceLocale = "en-US",
    defaultLocale = sourceLocale,
    initialLocale,
    initialCatalog,
    loadCatalog,
    fontMap,
    loadVoiceManifest,
    audioBaseUrl = "/audio/i18n",
    cookieName = DEFAULT_COOKIE_NAME,
    storagePrefix = "glotforge",
    devtoolsAllowed = false,
    onLocaleChange,
    children,
  } = props;

  const catalogCacheKey = useCallback(
    (locale: string) => `${storagePrefix}:catalog:${locale}`,
    [storagePrefix],
  );

  const [locale, setLocaleState] = useState<string>(() => {
    // When the server resolved a locale, hydrate with exactly that — the
    // client and server first render must match. Client-only apps fall back
    // to cookie -> localStorage -> default.
    if (initialLocale) return initialLocale;
    if (typeof window !== "undefined") {
      const fromCookie = readLocaleCookie(document.cookie, cookieName);
      if (fromCookie && (locales.includes(fromCookie) || fromCookie === PSEUDO_LOCALE)) {
        return fromCookie;
      }
      const stored = safeStorageGet(`${storagePrefix}:locale`);
      if (stored && (locales.includes(stored) || stored === PSEUDO_LOCALE)) {
        return stored;
      }
    }
    return defaultLocale;
  });

  const [catalogs, setCatalogs] = useState<Record<string, Catalog>>(() => {
    const seed: Record<string, Catalog> = {};
    if (initialCatalog && initialLocale) seed[initialLocale] = initialCatalog;
    return seed;
  });

  // Locales whose catalog has been fetched fresh this session (the
  // localStorage copy may be stale after a deploy — we serve it instantly,
  // then refresh in the background exactly once).
  const freshLocales = useRef(new Set<string>(initialCatalog && initialLocale ? [initialLocale] : []));

  const pseudo = locale === PSEUDO_LOCALE;
  const needsCatalog = !pseudo && locale !== sourceLocale;
  const activeCatalog = needsCatalog ? (catalogs[locale] ?? null) : null;

  // Load (and background-refresh) the active locale's catalog.
  useEffect(() => {
    if (!needsCatalog || !loadCatalog) return;
    if (freshLocales.current.has(locale)) return;
    let cancelled = false;

    if (!catalogs[locale]) {
      const cached = safeStorageGet(catalogCacheKey(locale));
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as Catalog;
          setCatalogs((prev) =>
            prev[locale] ? prev : { ...prev, [locale]: parsed },
          );
        } catch {
          // Corrupt cache entry — the fresh load below replaces it.
        }
      }
    }

    loadCatalog(locale)
      .then((fresh) => {
        if (cancelled) return;
        freshLocales.current.add(locale);
        setCatalogs((prev) => ({ ...prev, [locale]: fresh }));
        safeStorageSet(catalogCacheKey(locale), JSON.stringify(fresh));
      })
      .catch((err) => {
        if (process.env.NODE_ENV !== "production") {
          console.warn(`[glotforge] failed to load catalog for ${locale}`, err);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale, needsCatalog, loadCatalog, catalogCacheKey]);

  // Audio catalogs load the same way, for the effective locale — the source
  // locale has audio too, so there is no "needs" guard here.
  const effectiveLocale = pseudo ? sourceLocale : locale;
  const [voiceManifests, setVoiceManifests] = useState<Record<string, VoiceManifest>>({});
  const freshVoiceLocales = useRef(new Set<string>());
  const voiceCacheKey = useCallback(
    (l: string) => `${storagePrefix}:voice:${l}`,
    [storagePrefix],
  );
  useEffect(() => {
    if (!loadVoiceManifest) return;
    if (freshVoiceLocales.current.has(effectiveLocale)) return;
    let cancelled = false;
    if (!voiceManifests[effectiveLocale]) {
      const cached = safeStorageGet(voiceCacheKey(effectiveLocale));
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as VoiceManifest;
          setVoiceManifests((prev) =>
            prev[effectiveLocale] ? prev : { ...prev, [effectiveLocale]: parsed },
          );
        } catch {
          // Corrupt cache entry — the fresh load below replaces it.
        }
      }
    }
    loadVoiceManifest(effectiveLocale)
      .then((fresh) => {
        if (cancelled) return;
        freshVoiceLocales.current.add(effectiveLocale);
        setVoiceManifests((prev) => ({ ...prev, [effectiveLocale]: fresh }));
        safeStorageSet(voiceCacheKey(effectiveLocale), JSON.stringify(fresh));
      })
      .catch((err) => {
        if (process.env.NODE_ENV !== "production") {
          console.warn(`[glotforge] failed to load voice manifest for ${effectiveLocale}`, err);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveLocale, loadVoiceManifest, voiceCacheKey]);
  const activeVoiceManifest = voiceManifests[effectiveLocale] ?? null;

  const setLocale = useCallback(
    (next: string) => {
      setLocaleState(next);
      writeLocaleCookie(next, cookieName);
      safeStorageSet(`${storagePrefix}:locale`, next);
      onLocaleChange?.(next);
    },
    [cookieName, storagePrefix, onLocaleChange],
  );

  // Reflect the locale onto <html>: lang, dir, and the font key CSS reads.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const html = document.documentElement;
    const effective = pseudo ? sourceLocale : locale;
    html.lang = effective;
    html.dir = dirForLocale(effective);
    const font = fontMap?.[effective];
    if (font) html.setAttribute("data-i18n-font", font);
    else html.removeAttribute("data-i18n-font");
  }, [locale, pseudo, sourceLocale, fontMap]);

  // Keep the module snapshot in sync so the global `t` works in event
  // handlers and toasts. Client only — never leak per-request state on the
  // server.
  useEffect(() => {
    setRuntimeSnapshot({
      locale,
      sourceLocale,
      catalog: activeCatalog,
      pseudo,
    });
  }, [locale, sourceLocale, activeCatalog, pseudo]);

  // Devtools toggle — permission comes from the server (devtoolsAllowed);
  // the on/off state is the user's own, persisted locally.
  const [devtoolsEnabled, setDevtoolsEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return safeStorageGet(`${storagePrefix}:devtools`) === "on";
  });
  const setDevtoolsActive = useCallback(
    (active: boolean) => {
      setDevtoolsEnabled(active);
      safeStorageSet(`${storagePrefix}:devtools`, active ? "on" : "off");
    },
    [storagePrefix],
  );

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      locales,
      sourceLocale,
      catalog: activeCatalog,
      status: !needsCatalog || activeCatalog ? "ready" : "loading",
      pseudo,
      devtoolsAllowed,
      devtoolsActive: devtoolsAllowed && devtoolsEnabled,
      setDevtoolsActive,
      storagePrefix,
      voiceManifest: activeVoiceManifest,
      voiceStatus: !loadVoiceManifest
        ? "unavailable"
        : activeVoiceManifest
          ? "ready"
          : "loading",
      audioBaseUrl,
    }),
    [
      locale,
      setLocale,
      locales,
      sourceLocale,
      activeCatalog,
      needsCatalog,
      pseudo,
      devtoolsAllowed,
      devtoolsEnabled,
      setDevtoolsActive,
      storagePrefix,
      activeVoiceManifest,
      loadVoiceManifest,
      audioBaseUrl,
    ],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used inside <I18nProvider>");
  }
  return ctx;
}

/** Optional variant for components that may render outside the provider. */
export function useI18nOptional(): I18nContextValue | null {
  return useContext(I18nContext);
}

/**
 * A t() bound to the provider via context — components using it re-render
 * on locale change. Prefer this inside components; the global `t` is for
 * non-component code (toasts, handlers).
 */
export function useT(): TFunction {
  const { locale, sourceLocale, catalog, pseudo } = useI18n();
  return useMemo(() => {
    const snapshot: RuntimeSnapshot = { locale, sourceLocale, catalog, pseudo };
    return makeT(() => snapshot);
  }, [locale, sourceLocale, catalog, pseudo]);
}

/** Intl formatting helpers pre-bound to the active locale. */
export function useFormat() {
  const { locale, sourceLocale, pseudo } = useI18n();
  const effective = pseudo ? sourceLocale : locale;
  return useMemo(
    () => ({
      locale: effective,
      formatDate: (
        value: Date | number | string,
        options?: DateStyle | Intl.DateTimeFormatOptions,
      ) => formatDate(value, effective, options),
      formatTime: (
        value: Date | number | string,
        options?: DateStyle | Intl.DateTimeFormatOptions,
      ) => formatTime(value, effective, options),
      formatNumber: (value: number, options?: Intl.NumberFormatOptions) =>
        formatNumber(value, effective, options),
      formatCurrency: (
        value: number,
        currency: string,
        options?: Intl.NumberFormatOptions,
      ) => formatCurrency(value, currency, effective, options),
      formatPercent: (value: number, options?: Intl.NumberFormatOptions) =>
        formatPercent(value, effective, options),
      formatList: (values: string[], options?: Intl.ListFormatOptions) =>
        formatList(values, effective, options),
      formatRelativeTime: (
        value: number,
        unit: Intl.RelativeTimeFormatUnit,
        options?: Intl.RelativeTimeFormatOptions,
      ) => formatRelativeTime(value, unit, effective, options),
    }),
    [effective],
  );
}
