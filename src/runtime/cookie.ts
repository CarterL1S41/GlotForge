/**
 * Locale persistence. localStorage is the client-side cache; the cookie is a
 * one-line mirror of the SAME choice that exists purely so the SERVER can
 * render the correct language on a hard refresh / first visit — that is what
 * eliminates the first-paint translation flash. Client navigation never
 * re-reads either.
 */

export const DEFAULT_COOKIE_NAME = "glotforge_locale";

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** Write the locale cookie (client only). */
export function writeLocaleCookie(
  locale: string,
  cookieName: string = DEFAULT_COOKIE_NAME,
): void {
  if (typeof document === "undefined") return;
  document.cookie = `${cookieName}=${encodeURIComponent(locale)}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; samesite=lax`;
}

/**
 * Parse the locale out of a Cookie header string (server) or
 * document.cookie (client). Returns undefined when absent.
 */
export function readLocaleCookie(
  cookieString: string | null | undefined,
  cookieName: string = DEFAULT_COOKIE_NAME,
): string | undefined {
  if (!cookieString) return undefined;
  for (const part of cookieString.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === cookieName) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Choose the best supported locale for a candidate: exact match first, then
 * same language with any region (id -> id-ID), else the default.
 */
export function pickLocale(
  candidate: string | undefined,
  supported: string[],
  defaultLocale: string,
): string {
  if (!candidate) return defaultLocale;
  if (supported.includes(candidate)) return candidate;
  const language = candidate.split("-")[0].toLowerCase();
  const byLanguage = supported.find(
    (locale) => locale.split("-")[0].toLowerCase() === language,
  );
  return byLanguage ?? defaultLocale;
}

const RTL_LANGUAGES = new Set(["ar", "he", "fa", "ur", "ps", "sd", "yi", "dv"]);

/** Text direction for a locale — wired to <html dir> by the provider. */
export function dirForLocale(locale: string): "ltr" | "rtl" {
  const language = locale.split("-")[0].toLowerCase();
  return RTL_LANGUAGES.has(language) ? "rtl" : "ltr";
}
