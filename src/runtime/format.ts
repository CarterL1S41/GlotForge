/**
 * Locale-aware formatting via Intl — the browser already ships full CLDR
 * data, so month names, digit grouping, and currency symbols come translated
 * for free ("января", "1.234,56 €") with no catalog entries involved.
 */

export type DateStyle = "short" | "medium" | "long" | "full";

export function formatDate(
  value: Date | number | string,
  locale: string,
  options?: DateStyle | Intl.DateTimeFormatOptions,
): string {
  const date = value instanceof Date ? value : new Date(value);
  const resolved: Intl.DateTimeFormatOptions =
    typeof options === "string"
      ? { dateStyle: options }
      : (options ?? { dateStyle: "medium" });
  return new Intl.DateTimeFormat(locale, resolved).format(date);
}

export function formatTime(
  value: Date | number | string,
  locale: string,
  options?: DateStyle | Intl.DateTimeFormatOptions,
): string {
  const date = value instanceof Date ? value : new Date(value);
  const resolved: Intl.DateTimeFormatOptions =
    typeof options === "string"
      ? { timeStyle: options }
      : (options ?? { timeStyle: "short" });
  return new Intl.DateTimeFormat(locale, resolved).format(date);
}

export function formatNumber(
  value: number,
  locale: string,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

/**
 * Currency display. Pass the ISO 4217 code the record carries; the symbol,
 * decimals, and placement come from the locale's own conventions.
 */
export function formatCurrency(
  value: number,
  currency: string,
  locale: string,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    ...options,
  }).format(value);
}

export function formatPercent(
  value: number,
  locale: string,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    ...options,
  }).format(value);
}

export function formatList(
  values: string[],
  locale: string,
  options?: Intl.ListFormatOptions,
): string {
  return new Intl.ListFormat(locale, options).format(values);
}

export function formatRelativeTime(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
  locale: string,
  options?: Intl.RelativeTimeFormatOptions,
): string {
  return new Intl.RelativeTimeFormat(locale, {
    numeric: "auto",
    ...options,
  }).format(value, unit);
}
