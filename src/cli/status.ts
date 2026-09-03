import type { ResolvedConfig } from "../shared/types";
import { readCatalog, readManifest } from "./catalog";

export interface LocaleStatus {
  locale: string;
  language: string;
  translated: number;
  missing: number;
  percent: number;
}

export interface StatusSummary {
  totalMessages: number;
  locales: LocaleStatus[];
}

export function computeStatus(config: ResolvedConfig, cwd: string): StatusSummary {
  const manifest = readManifest(config, cwd);
  const hashes = Object.keys(manifest);
  const displayNames = safeDisplayNames();
  const locales = config.locales.map((locale) => {
    const catalog = readCatalog(config, cwd, locale);
    const translated = hashes.filter((hash) => catalog[hash]).length;
    return {
      locale,
      language: displayNames?.of(locale) ?? locale,
      translated,
      missing: hashes.length - translated,
      percent: hashes.length ? Math.round((translated / hashes.length) * 100) : 100,
    };
  });
  return { totalMessages: hashes.length, locales };
}

export function languageLabel(locale: string): string {
  return safeDisplayNames()?.of(locale) ?? locale;
}

function safeDisplayNames(): Intl.DisplayNames | null {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" });
  } catch {
    return null;
  }
}

export function printStatus(summary: StatusSummary): void {
  console.log(`\n${summary.totalMessages} messages in the manifest\n`);
  const width = Math.max(...summary.locales.map((s) => s.locale.length), 6);
  for (const status of summary.locales) {
    const bar =
      "█".repeat(Math.round(status.percent / 5)) +
      "░".repeat(20 - Math.round(status.percent / 5));
    console.log(
      `  ${status.locale.padEnd(width)}  ${bar} ${String(status.percent).padStart(3)}%  ` +
        `${status.translated}/${summary.totalMessages} translated` +
        (status.missing ? `, ${status.missing} missing` : "") +
        `  (${status.language})`,
    );
  }
  console.log("");
}
