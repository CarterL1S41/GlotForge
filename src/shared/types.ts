/** A compiled per-locale catalog: message hash -> translated message. */
export type Catalog = Record<string, string>;

/** One entry in the source manifest (messages.json). */
export interface MessageEntry {
  /** Canonical English source message. */
  message: string;
  /** Free-prose disambiguation, included in the hash and shown to the translator. */
  context?: string;
  /** Where the message appears in source, as "path:line" strings. */
  origins: string[];
  /**
   * Spoken audio is generated for this message. A string is the voice key
   * the app addresses it by (useVoicePlayer("intro")); `true` means voiced
   * without a key. Not part of the hash.
   */
  voice?: string | true;
}

/** The source manifest: message hash -> entry. Committed to git. */
export type Manifest = Record<string, MessageEntry>;

/** One spoken word inside a clip, offsets in milliseconds from clip start. */
export interface VoiceWord {
  text: string;
  startMs: number;
  endMs: number;
  /** The aligner could not place this word and interpolated its slot. */
  estimated?: true;
}

/** One sentence of a voiced message: one audio file. */
export interface VoiceClip {
  /** Path relative to the audio directory, e.g. "es-ES/1abc...-0.mp3". */
  file: string;
  /** The sentence text this clip speaks. */
  text: string;
  durationMs: number;
  /** Per-word timing when word timing was obtained for this clip. */
  words?: VoiceWord[];
}

/** How word offsets were obtained for an entry. */
export type VoiceTiming = "marks" | "align" | "sentence";

/** The generated audio for one message in one locale. */
export interface VoiceEntry {
  /** Google voice name the clips were synthesized with. */
  voice: string;
  /** Speech model the clips were generated with, when the voice names one. */
  model?: string;
  /** Style direction the clips were generated with, when one was given. */
  style?: string;
  format: "MP3" | "LINEAR16";
  speakingRate: number;
  timing: VoiceTiming;
  clips: VoiceClip[];
}

/**
 * Per-locale audio catalog (<catalogDir>/voice/<locale>.json). Committed to
 * git beside the text catalogs; `glotforge voice` only generates what is
 * missing or stale.
 */
export interface VoiceManifest {
  /** Variant names configured for this locale, in config order; the first is the default. */
  variants: string[];
  /** Voice key -> message hash, for every voiced message that has a key. */
  keys: Record<string, string>;
  /** Message hash -> variant name -> generated audio. */
  entries: Record<string, Record<string, VoiceEntry>>;
}

/** Variant name used when a locale configures a single voice as a plain string. */
export const DEFAULT_VOICE_VARIANT = "default";

/**
 * Which Google API speaks a voice:
 *   text-to-speech   — Cloud Text-to-Speech (`text:synthesize`): Chirp 3 HD,
 *                      Neural2, WaveNet, Standard, and the speech models that
 *                      API serves by `modelName`.
 *   generate-content — the generative model API (`generateContent`), for
 *                      speech models that are only served there.
 */
export type VoiceApi = "text-to-speech" | "generate-content";

/** A voice with its own model, style or API, where a plain voice name is not enough. */
export interface VoiceSpec {
  /** Voice name: "en-US-Chirp3-HD-Aoede" for a voice family, "Kore" for a speech model. */
  voice: string;
  /** Speech model for this voice. Overrides `voice.model`; "" uses none. */
  model?: string;
  /** Style direction for this voice. Overrides `voice.styles` and `voice.style`. */
  style?: string;
  /** API for this voice. Overrides `voice.api`. */
  api?: VoiceApi;
}

/** A configured voice with every default applied. */
export interface ResolvedVoice {
  voice: string;
  /** "" when the voice name alone selects the voice. */
  model: string;
  /** "" when no style direction applies. */
  style: string;
  api: VoiceApi;
}

/**
 * Where clip files are kept. The audio catalogs stay in the catalog
 * directory either way; only the audio moves.
 *   local — the app's own `audioDir`, committed with the code.
 *   gcs   — a Google Cloud Storage bucket. Nothing is written under
 *           `audioDir`; the app serves the clips from the bucket.
 */
export type VoiceStorage =
  | { type: "local" }
  | {
      type: "gcs";
      /** Bucket name, without "gs://". */
      bucket: string;
      /** Folder inside the bucket the clips sit under. Default none. */
      prefix?: string;
      /** Cache-Control stored on each clip. Default "private, max-age=31536000, immutable". */
      cacheControl?: string;
    };

/** Price of a speech model, USD per million tokens. */
export interface VoiceTokenPrice {
  /** Text sent to the model. */
  input: number;
  /** Audio it returns. */
  output: number;
}

/** i18n.config.json — lives at the consuming app's repo root. */
export interface I18nConfig {
  /** Target locales to translate into (the source locale is implicit). */
  locales: string[];
  /** Locale the source code is written in. Default "en-US". */
  sourceLocale?: string;
  /** Globs of source files to scan. Default ["src/**\/*.{ts,tsx,js,jsx}"]. */
  include?: string[];
  /** Globs of source files to skip. node_modules and dot-dirs are always skipped. */
  exclude?: string[];
  /** Directory holding messages.json and catalog/. Default "i18n". */
  catalogDir?: string;
  /** JSX attributes whose string values are user-facing (kept in sync with the lint rule). */
  attributes?: string[];
  translation?: {
    /**
     * Model reference: "model" or "provider:model". A bare id uses the
     * anthropic provider ("claude-opus-5" == "anthropic:claude-opus-5").
     * Default "claude-opus-5".
     */
    model?: string;
    /** Reasoning/extended thinking for translation requests. Default true. */
    thinking?: boolean;
    /** Reasoning effort (low|medium|high|xhigh|max). Omitted by default.
     *  Providers clamp to what they support. */
    effort?: string;
    /**
     * Per-locale overrides, applied on top of the settings above:
     *   "overrides": {
     *     "am-ET": { "thinking": true },
     *     "yo-NG": { "model": "claude-fable-5" },
     *     "fr-FR": { "model": "openai:gpt-5.2-mini" }
     *   }
     * This is how multi-model translation works: each locale can run on a
     * different provider/model. CLI flags (--model / --no-thinking /
     * --thinking / --effort) outrank these for a given run.
     */
    overrides?: Record<
      string,
      { model?: string; thinking?: boolean; effort?: string }
    >;
    /**
     * Translation providers by name. "anthropic" and "openai" are built in;
     * add any OpenAI-compatible endpoint (Ollama, OpenRouter, Groq, ...):
     *   "providers": {
     *     "ollama": { "kind": "openai-compatible",
     *                 "baseUrl": "http://localhost:11434/v1", "apiKeyEnv": "" }
     *   }
     * Entries with a built-in name override that built-in's settings.
     */
    providers?: Record<
      string,
      {
        /** Wire protocol. Default "openai-compatible". */
        kind?: "anthropic" | "openai-compatible";
        /** API base URL (openai-compatible only). */
        baseUrl?: string;
        /** Env var holding the API key. Empty string = no auth header. */
        apiKeyEnv?: string;
      }
    >;
    /**
     * Pricing for cost estimates, keyed by full model reference, USD per
     * million tokens:
     *   "models": { "openai:gpt-5.2": { "inputPerMTok": 1.25, "outputPerMTok": 10 } }
     * Anthropic models ship with built-in pricing; anything else without an
     * entry here estimates at $0 with a warning.
     */
    models?: Record<
      string,
      { inputPerMTok: number; outputPerMTok: number; label?: string }
    >;
    /** Messages per API request. Default 20. */
    batchSize?: number;
    /**
     * A short description of the application and its audience, included in
     * every translation prompt so tone and terminology fit the product.
     */
    appContext?: string;
    /**
     * Domain glossary rendered into every translation prompt: term ->
     * guidance. Use it to pin meanings ("book": "record a transaction,
     * never a publication") and policies ("Acme": "keep untranslated").
     * The strongest lever for terminology quality and cross-string
     * consistency.
     */
    glossary?: Record<string, string>;
    /** max_tokens per request. Default 16000. */
    maxTokens?: number;
    /** Concurrent in-flight requests. Default 3. */
    concurrency?: number;
  };
  /**
   * Spoken audio for messages marked with `voice` (<Trans voice="intro">,
   * t("...", { voice: "intro" })). Google Cloud speaks them: a voice family
   * of Cloud Text-to-Speech, or a speech model when `model` is set. Word
   * timing comes from SSML marks where the voice family honours them,
   * otherwise from Speech-to-Text alignment.
   */
  voice?: {
    /**
     * Google voice per locale, including the source locale. A string is a
     * single voice; a map is a set of named variants the app can let the
     * user choose between (the first is the default):
     *   "voices": {
     *     "en-US": { "female": "en-US-Chirp3-HD-Aoede", "male": "en-US-Chirp3-HD-Charon" },
     *     "es-ES": "es-ES-Chirp3-HD-Kore"
     *   }
     * The name selects the family (Chirp3-HD, Neural2, Wavenet, Standard).
     * A locale without an entry gets no audio.
     *
     * With a speech model (`model` below) the voice is the model's speaker
     * name, and a variant can be an object when it needs its own model,
     * style or API:
     *   "voices": {
     *     "en-US": { "female": "Kore", "male": "Charon" },
     *     "pt-PT": { "female": { "voice": "Kore", "style": "European Portuguese." } },
     *     "de-DE": { "female": { "voice": "de-DE-Neural2-F", "model": "" } }
     *   }
     */
    voices?: Record<string, string | Record<string, string | VoiceSpec>>;
    /**
     * Speech model for every voice, e.g. "gemini-3.8-flash-tts". Omit to
     * use the voice families of Cloud Text-to-Speech, where the voice name
     * alone selects the voice. A variant's own `model` overrides it.
     */
    model?: string;
    /**
     * API that serves the voices. Default: "generate-content" when a model
     * is set, "text-to-speech" otherwise. Set "text-to-speech" with a model
     * for speech models that Cloud Text-to-Speech serves by `modelName`.
     */
    api?: VoiceApi;
    /**
     * Style direction for speech models, in plain words: tone, pace,
     * accent, delivery ("Warm, unhurried narrator."). Ignored by voice
     * families, which take no direction. Changing it regenerates the
     * entries it applies to.
     */
    style?: string;
    /**
     * Style direction per locale, replacing `style` for that locale. A
     * speech model that detects the language of the text takes accent and
     * dialect here: { "pt-PT": "European Portuguese, as spoken in Portugal." }
     */
    styles?: Record<string, string>;
    /**
     * Location for "generate-content" requests. Default "global". A
     * regional location is called on its regional host.
     */
    location?: string;
    /**
     * Host for "generate-content" requests, when the default for the
     * location is not the one to call (a multi-region or private
     * endpoint). Host only, no scheme or path.
     */
    endpoint?: string;
    /**
     * Bitrate in kbps for MP3 clips GlotForge encodes itself, which it
     * does when a speech model returns only uncompressed audio. One of 32,
     * 48, 64, 80, 96, 112, 128, 160. Default 64.
     */
    mp3Bitrate?: number;
    /**
     * Google Cloud project id. Required with an API key; read from the
     * service-account file when credentials are used. Also honoured from
     * GOOGLE_CLOUD_PROJECT.
     */
    project?: string;
    /**
     * Env var holding a service-account key: a path to the JSON file or
     * the JSON itself. Default "GOOGLE_APPLICATION_CREDENTIALS". Checked
     * before the API key.
     */
    credentialsEnv?: string;
    /** Env var holding a Google Cloud API key. Default "GOOGLE_TTS_KEY". */
    apiKeyEnv?: string;
    /** Clip encoding. Default "MP3" (about a twelfth the size of LINEAR16). */
    format?: "MP3" | "LINEAR16";
    /** Speaking pace, 0.25–2.0. Default 1. */
    speakingRate?: number;
    /**
     * How a message is cut into clips. Default "sentence":
     *   sentence — one clip per sentence. Each sentence is synthesized on
     *              its own, so a changed sentence regenerates alone.
     *   message  — one clip for the whole message. The voice hears every
     *              sentence in context, which keeps its intonation natural
     *              across sentence boundaries.
     * Changing it regenerates every entry on the next `voice` run.
     */
    clips?: "sentence" | "message";
    /**
     * Directory the clip files are written to, relative to the app root.
     * Default "public/audio/i18n" so a Next.js app serves them at
     * /audio/i18n — the provider's `audioBaseUrl` default.
     */
    audioDir?: string;
    /**
     * Where clip files are kept. Default { "type": "local" }: under
     * `audioDir`, committed with the code. A bucket keeps a large audio
     * library out of the repository and the build:
     *   "storage": { "type": "gcs", "bucket": "my-audio", "prefix": "i18n" }
     * The catalogs still record every clip, so nothing is generated twice.
     */
    storage?: VoiceStorage;
    /**
     * How clip files are named. "stable" names a clip by its message,
     * variant and position, so a regenerated clip replaces the old file.
     * "fingerprint" adds a short hash of the audio, so a file never
     * changes once written and can be cached for good. Default "stable"
     * for local storage, "fingerprint" for a bucket.
     */
    fileNames?: "stable" | "fingerprint";
    /**
     * How per-word offsets are obtained. Default "auto":
     *   auto   — SSML marks for families that honour them (Neural2, Wavenet,
     *            Standard, News, Polyglot), Speech-to-Text alignment for the
     *            rest (Chirp 3 HD ignores marks).
     *   marks  — always request marks; entries fall back to alignment with
     *            a warning when none come back.
     *   align  — always align through Speech-to-Text.
     *   none   — sentence-level timing only (clip durations).
     */
    wordTiming?: "auto" | "marks" | "align" | "none";
    /** Speech-to-Text V2 region for alignment. Default "us-central1". */
    sttRegion?: string;
    /** Speech-to-Text V2 model for alignment. Default "chirp_2". */
    sttModel?: string;
    /**
     * Pricing for the estimate, USD per million characters keyed by a
     * voice-name fragment ("Chirp3-HD", "Neural2", ...). Built-in list
     * prices cover the Google families; override or extend here.
     */
    pricing?: Record<string, number>;
    /**
     * Pricing for speech models, USD per million tokens, keyed by a
     * model-name fragment:
     *   { "gemini-3.8-flash-tts": { "input": 1, "output": 18 } }
     * Built-in list prices cover the models GlotForge knows; override or
     * extend here. A model with no price is estimated at $0 and says so.
     */
    tokenPricing?: Record<string, VoiceTokenPrice>;
    /**
     * Audio tokens a speech model bills per second of speech, for the
     * estimate before a run. Default 25. The cost reported after a run
     * uses the token counts the API returns.
     */
    audioTokensPerSecond?: number;
    /** Speech-to-Text price for the estimate, USD per minute of audio. Default 0.016. */
    sttPerMinuteUsd?: number;
    /** Concurrent in-flight requests. Default 3. */
    concurrency?: number;
  };
}

export interface ResolvedConfig
  extends Required<Omit<I18nConfig, "translation" | "voice">> {
  translation: Required<NonNullable<I18nConfig["translation"]>>;
  voice: Omit<Required<NonNullable<I18nConfig["voice"]>>, "voices" | "storage"> & {
    /** Normalized: locale -> variant name -> voice with its model, style and API, config order kept. */
    voices: Record<string, Record<string, ResolvedVoice>>;
    /** Normalized: a bucket carries its prefix (no leading or trailing slash) and Cache-Control. */
    storage:
      | { type: "local" }
      | { type: "gcs"; bucket: string; prefix: string; cacheControl: string };
  };
}
