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
}

/** The source manifest: message hash -> entry. Committed to git. */
export type Manifest = Record<string, MessageEntry>;

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
}

export interface ResolvedConfig extends Required<Omit<I18nConfig, "translation">> {
  translation: Required<NonNullable<I18nConfig["translation"]>>;
}
