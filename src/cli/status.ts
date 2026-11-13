import { DEFAULT_VOICE_VARIANT, type ResolvedConfig } from "../shared/types";
import { readCatalog, readManifest } from "./catalog";
import { readVoiceManifest, voicedLocales } from "./voice-catalog";

export interface LocaleStatus {
  locale: string;
  language: string;
  translated: number;
  missing: number;
  percent: number;
}

export interface VoiceStatus {
  locale: string;
  /** Variant name ("default" for a single-voice locale). */
  variant: string;
  language: string;
  voice: string;
  /** Voiced messages with audio generated. */
  generated: number;
  /** Of those, with per-word timing. */
  wordTimed: number;
  missing: number;
}

export interface StatusSummary {
  totalMessages: number;
  locales: LocaleStatus[];
  /** Voiced messages in the manifest. */
  voicedMessages: number;
  /** One row per locale with a configured voice (source locale included). */
  voice: VoiceStatus[];
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
  const voicedHashes = hashes.filter((hash) => manifest[hash].voice !== undefined);
  const voice = voicedLocales(config).flatMap((locale) => {
    const voiceManifest = readVoiceManifest(config, cwd, locale);
    return Object.entries(config.voice.voices[locale]).map(([variant, voiceName]) => {
      const generated = voicedHashes.filter((hash) => voiceManifest.entries[hash]?.[variant]).length;
      const wordTimed = voicedHashes.filter((hash) => {
        const entry = voiceManifest.entries[hash]?.[variant];
        return entry !== undefined && entry.timing !== "sentence";
      }).length;
      return {
        locale,
        variant,
        language: displayNames?.of(locale) ?? locale,
        voice: voiceName.model ? `${voiceName.voice} (${voiceName.model})` : voiceName.voice,
        generated,
        wordTimed,
        missing: voicedHashes.length - generated,
      };
    });
  });
  return { totalMessages: hashes.length, locales, voicedMessages: voicedHashes.length, voice };
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
  if (summary.voicedMessages > 0 || summary.voice.length > 0) {
    console.log(`${summary.voicedMessages} voiced messages\n`);
    if (!summary.voice.length) {
      console.log("  no voices configured — add voice.voices to i18n.config.json\n");
      return;
    }
    const label = (s: VoiceStatus) =>
      s.variant === DEFAULT_VOICE_VARIANT ? s.locale : `${s.locale} / ${s.variant}`;
    const width = Math.max(...summary.voice.map((s) => label(s).length), 6);
    for (const status of summary.voice) {
      const percent = summary.voicedMessages
        ? Math.round((status.generated / summary.voicedMessages) * 100)
        : 100;
      const bar =
        "█".repeat(Math.round(percent / 5)) + "░".repeat(20 - Math.round(percent / 5));
      console.log(
        `  ${label(status).padEnd(width)}  ${bar} ${String(percent).padStart(3)}%  ` +
          `${status.generated}/${summary.voicedMessages} voiced` +
          (status.wordTimed < status.generated
            ? `, ${status.generated - status.wordTimed} sentence-timed only`
            : status.generated
              ? ", word-timed"
              : "") +
          (status.missing ? `, ${status.missing} missing` : "") +
          `  (${status.language}, ${status.voice})`,
      );
    }
    console.log("");
  }
}
