import fs from "fs";
import path from "path";
import type { I18nConfig, ResolvedConfig } from "../shared/types";

export const CONFIG_FILE = "i18n.config.json";

const DEFAULT_ATTRIBUTES = [
  "placeholder",
  "aria-label",
  "aria-description",
  "aria-roledescription",
  "aria-valuetext",
  "title",
  "alt",
  "label",
];

export function loadConfig(cwd: string): ResolvedConfig {
  const file = path.join(cwd, CONFIG_FILE);
  if (!fs.existsSync(file)) {
    throw new Error(
      `${CONFIG_FILE} not found in ${cwd} — run "glotforge init" to create one.`,
    );
  }
  let raw: I18nConfig;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as I18nConfig;
  } catch (err) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(raw.locales) || raw.locales.length === 0) {
    throw new Error(`${CONFIG_FILE} must declare a non-empty "locales" array.`);
  }
  const sourceLocale = raw.sourceLocale ?? "en-US";
  return {
    locales: raw.locales.filter((locale) => locale !== sourceLocale),
    sourceLocale,
    include: raw.include ?? ["src/**/*.{ts,tsx,js,jsx}"],
    exclude: raw.exclude ?? [],
    catalogDir: raw.catalogDir ?? "i18n",
    attributes: raw.attributes ?? DEFAULT_ATTRIBUTES,
    translation: {
      model: raw.translation?.model ?? "claude-opus-5",
      thinking: raw.translation?.thinking ?? true,
      effort: raw.translation?.effort ?? "",
      overrides: raw.translation?.overrides ?? {},
      providers: raw.translation?.providers ?? {},
      models: raw.translation?.models ?? {},
      batchSize: raw.translation?.batchSize ?? 20,
      appContext: raw.translation?.appContext ?? "",
      glossary: raw.translation?.glossary ?? {},
      maxTokens: raw.translation?.maxTokens ?? 16000,
      concurrency: raw.translation?.concurrency ?? 3,
    },
    voice: resolveVoice(raw.voice ?? {}),
  };
}

function resolveVoice(
  raw: NonNullable<I18nConfig["voice"]>,
): ResolvedConfig["voice"] {
  const format = raw.format ?? "MP3";
  if (format !== "MP3" && format !== "LINEAR16") {
    throw new Error(`${CONFIG_FILE}: voice.format must be "MP3" or "LINEAR16".`);
  }
  const wordTiming = raw.wordTiming ?? "auto";
  if (!["auto", "marks", "align", "none"].includes(wordTiming)) {
    throw new Error(
      `${CONFIG_FILE}: voice.wordTiming must be auto, marks, align or none.`,
    );
  }
  const speakingRate = raw.speakingRate ?? 1;
  if (
    typeof speakingRate !== "number" ||
    speakingRate < 0.25 ||
    speakingRate > 2
  ) {
    throw new Error(`${CONFIG_FILE}: voice.speakingRate must be between 0.25 and 2.`);
  }
  return {
    voices: raw.voices ?? {},
    project: raw.project ?? "",
    credentialsEnv: raw.credentialsEnv ?? "GOOGLE_APPLICATION_CREDENTIALS",
    apiKeyEnv: raw.apiKeyEnv ?? "GOOGLE_TTS_KEY",
    format,
    speakingRate,
    audioDir: raw.audioDir ?? "public/audio/i18n",
    wordTiming,
    sttRegion: raw.sttRegion ?? "us-central1",
    sttModel: raw.sttModel ?? "chirp_2",
    pricing: raw.pricing ?? {},
    sttPerMinuteUsd: raw.sttPerMinuteUsd ?? 0.016,
    concurrency: raw.concurrency ?? 3,
  };
}
