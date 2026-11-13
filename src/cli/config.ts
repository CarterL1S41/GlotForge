import fs from "fs";
import path from "path";
import {
  DEFAULT_VOICE_VARIANT,
  type I18nConfig,
  type ResolvedConfig,
  type ResolvedVoice,
  type VoiceApi,
  type VoiceSpec,
  type VoiceStorage,
  type VoiceTokenPrice,
} from "../shared/types";

export const CONFIG_FILE = "i18n.config.json";

const VOICE_APIS: VoiceApi[] = ["text-to-speech", "generate-content"];

/** Constant bitrates offered for MP3 clips GlotForge encodes itself. */
export const MP3_BITRATES = [32, 48, 64, 80, 96, 112, 128, 160];

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
  const clips = raw.clips ?? "sentence";
  if (clips !== "sentence" && clips !== "message") {
    throw new Error(`${CONFIG_FILE}: voice.clips must be "sentence" or "message".`);
  }
  const speakingRate = raw.speakingRate ?? 1;
  if (
    typeof speakingRate !== "number" ||
    speakingRate < 0.25 ||
    speakingRate > 2
  ) {
    throw new Error(`${CONFIG_FILE}: voice.speakingRate must be between 0.25 and 2.`);
  }
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (raw.api !== undefined && !VOICE_APIS.includes(raw.api)) {
    throw new Error(`${CONFIG_FILE}: voice.api must be "text-to-speech" or "generate-content".`);
  }
  const style = typeof raw.style === "string" ? raw.style.trim() : "";
  const styles: Record<string, string> = {};
  for (const [locale, value] of Object.entries(raw.styles ?? {})) {
    if (typeof value !== "string") {
      throw new Error(`${CONFIG_FILE}: voice.styles.${locale} must be a string.`);
    }
    styles[locale] = value.trim();
  }
  const mp3Bitrate = raw.mp3Bitrate ?? 64;
  if (!MP3_BITRATES.includes(mp3Bitrate)) {
    throw new Error(`${CONFIG_FILE}: voice.mp3Bitrate must be one of ${MP3_BITRATES.join(", ")}.`);
  }
  const audioTokensPerSecond = raw.audioTokensPerSecond ?? 25;
  if (typeof audioTokensPerSecond !== "number" || audioTokensPerSecond <= 0) {
    throw new Error(`${CONFIG_FILE}: voice.audioTokensPerSecond must be a positive number.`);
  }
  const tokenPricing: Record<string, VoiceTokenPrice> = {};
  for (const [fragment, price] of Object.entries(raw.tokenPricing ?? {})) {
    if (!price || typeof price.input !== "number" || typeof price.output !== "number") {
      throw new Error(
        `${CONFIG_FILE}: voice.tokenPricing.${fragment} needs numeric "input" and "output" prices (USD per million tokens).`,
      );
    }
    tokenPricing[fragment] = { input: price.input, output: price.output };
  }

  let storage: ResolvedConfig["voice"]["storage"] = { type: "local" };
  if (raw.storage !== undefined) {
    const type = (raw.storage as { type?: string }).type;
    if (type === "gcs") {
      const gcs = raw.storage as Extract<VoiceStorage, { type: "gcs" }>;
      const bucket = typeof gcs.bucket === "string" ? gcs.bucket.trim().replace(/^gs:\/\//, "").replace(/\/+$/, "") : "";
      if (!bucket || bucket.includes("/")) {
        throw new Error(`${CONFIG_FILE}: voice.storage.bucket must be a bucket name, such as "my-audio".`);
      }
      storage = {
        type: "gcs",
        bucket,
        prefix: (gcs.prefix ?? "").trim().replace(/^\/+|\/+$/g, ""),
        cacheControl: (gcs.cacheControl ?? "").trim() || "private, max-age=31536000, immutable",
      };
    } else if (type !== "local") {
      throw new Error(`${CONFIG_FILE}: voice.storage.type must be "local" or "gcs".`);
    }
  }
  if (raw.fileNames !== undefined && raw.fileNames !== "stable" && raw.fileNames !== "fingerprint") {
    throw new Error(`${CONFIG_FILE}: voice.fileNames must be "stable" or "fingerprint".`);
  }

  // A variant is a voice name, or an object when it needs its own model,
  // style or API. Defaults flow: variant, then the locale's style, then the
  // voice-wide settings.
  const resolveOne = (locale: string, name: string, value: unknown): ResolvedVoice => {
    const spec: VoiceSpec | null =
      typeof value === "string"
        ? { voice: value }
        : value && typeof value === "object" && typeof (value as VoiceSpec).voice === "string"
          ? (value as VoiceSpec)
          : null;
    if (!spec || !spec.voice.trim()) {
      throw new Error(
        `${CONFIG_FILE}: voice variant "${name}" for ${locale} needs a voice name — a string, or an object with "voice".`,
      );
    }
    if (spec.api !== undefined && !VOICE_APIS.includes(spec.api)) {
      throw new Error(
        `${CONFIG_FILE}: voice variant "${name}" for ${locale}: api must be "text-to-speech" or "generate-content".`,
      );
    }
    const ownModel = typeof spec.model === "string" ? spec.model.trim() : model;
    const api: VoiceApi = spec.api ?? raw.api ?? (ownModel ? "generate-content" : "text-to-speech");
    if (api === "generate-content" && !ownModel) {
      throw new Error(
        `${CONFIG_FILE}: voice variant "${name}" for ${locale} uses the "generate-content" API, which needs a model — set voice.model or the variant's "model".`,
      );
    }
    return {
      voice: spec.voice.trim(),
      model: ownModel,
      // Voice families take no direction, so a style only travels with a model.
      style: ownModel
        ? (typeof spec.style === "string" ? spec.style : (styles[locale] ?? style)).trim()
        : "",
      api,
    };
  };

  const voices: Record<string, Record<string, ResolvedVoice>> = {};
  for (const [locale, value] of Object.entries(raw.voices ?? {})) {
    if (typeof value === "string") {
      if (value.trim()) voices[locale] = { [DEFAULT_VOICE_VARIANT]: resolveOne(locale, DEFAULT_VOICE_VARIANT, value) };
      continue;
    }
    const variants: Record<string, ResolvedVoice> = {};
    for (const [name, voice] of Object.entries(value ?? {})) {
      if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
        throw new Error(
          `${CONFIG_FILE}: voice variant "${name}" for ${locale} must be a simple name (letters, digits, - and _) — it becomes part of clip file names.`,
        );
      }
      variants[name] = resolveOne(locale, name, voice);
    }
    if (Object.keys(variants).length) voices[locale] = variants;
  }
  return {
    voices,
    model,
    api: raw.api ?? (model ? "generate-content" : "text-to-speech"),
    style,
    styles,
    location: (raw.location ?? "global").trim() || "global",
    endpoint: (raw.endpoint ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, ""),
    mp3Bitrate,
    tokenPricing,
    audioTokensPerSecond,
    storage,
    fileNames: raw.fileNames ?? (storage.type === "gcs" ? "fingerprint" : "stable"),
    project: raw.project ?? "",
    credentialsEnv: raw.credentialsEnv ?? "GOOGLE_APPLICATION_CREDENTIALS",
    apiKeyEnv: raw.apiKeyEnv ?? "GOOGLE_TTS_KEY",
    format,
    speakingRate,
    clips,
    audioDir: raw.audioDir ?? "public/audio/i18n",
    wordTiming,
    sttRegion: raw.sttRegion ?? "us-central1",
    sttModel: raw.sttModel ?? "chirp_2",
    pricing: raw.pricing ?? {},
    sttPerMinuteUsd: raw.sttPerMinuteUsd ?? 0.016,
    concurrency: raw.concurrency ?? 3,
  };
}
