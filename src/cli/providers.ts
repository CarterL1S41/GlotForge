/**
 * Translation providers. The translate pipeline is provider-agnostic: it
 * assembles prompts, batches, validates, and writes catalogs; a provider
 * only has to turn (system, user, model) into text plus usage numbers.
 *
 * Model references are "provider:model" ("openai:gpt-5.2",
 * "ollama:qwen3"); a bare id ("claude-opus-5") means the anthropic
 * provider, so existing configs keep working unchanged.
 *
 * Built-ins:
 *   - "anthropic"  — Anthropic SDK: prompt caching, extended thinking,
 *     free token counting, server-side refusal fallbacks.
 *   - "openai"     — OpenAI-compatible chat completions over fetch. Also
 *     the template for ANY compatible endpoint (Ollama, OpenRouter, Groq,
 *     LM Studio, ...) via `translation.providers` in i18n.config.json.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ResolvedConfig } from "../shared/types";
import { resolveModel, thinkingParam } from "./models";

export interface ModelRef {
  provider: string;
  model: string;
  /** The full reference as written ("openai:gpt-5.2" or "claude-opus-5"). */
  raw: string;
}

export function parseModelRef(raw: string): ModelRef {
  const idx = raw.indexOf(":");
  if (idx === -1) return { provider: "anthropic", model: raw, raw };
  return { provider: raw.slice(0, idx), model: raw.slice(idx + 1), raw };
}

export interface ProviderRequest {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  thinking: boolean;
  effort?: string;
}

export type ProviderResult =
  | { kind: "ok"; text: string; inputTokens: number; outputTokens: number }
  | { kind: "refusal"; inputTokens: number; outputTokens: number }
  | { kind: "truncated"; inputTokens: number; outputTokens: number };

export interface TranslationProvider {
  id: string;
  translateBatch(req: ProviderRequest): Promise<ProviderResult>;
  /** Accurate input-token counting where the API offers it for free. */
  countInputTokens?(
    model: string,
    system: string,
    user: string,
  ): Promise<number>;
}

/* ----------------------------- anthropic ---------------------------------- */

class AnthropicProvider implements TranslationProvider {
  readonly id = "anthropic";
  private client: Anthropic;

  constructor(apiKeyEnv?: string) {
    // Dedicated key for the translation pipeline (set it in the app's .env /
    // .env.local — loaded by the CLI); falls back to the SDK's standard
    // resolution (ANTHROPIC_API_KEY, ant auth profile) when unset.
    const key =
      (apiKeyEnv ? process.env[apiKeyEnv] : undefined) ??
      process.env.ANTHROPIC_TRANSLATION_KEY;
    this.client = new Anthropic({ apiKey: key ?? undefined });
  }

  async countInputTokens(
    model: string,
    system: string,
    user: string,
  ): Promise<number> {
    const counted = await this.client.messages.countTokens({
      model,
      system,
      messages: [{ role: "user", content: user }],
    });
    return counted.input_tokens;
  }

  async translateBatch(req: ProviderRequest): Promise<ProviderResult> {
    const spec = resolveModel(req.model);
    const thinking = thinkingParam(spec, req.thinking);
    const request: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: [
        {
          type: "text",
          text: req.system,
          // The system prompt repeats for every batch of a locale — cache it.
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: req.user }],
      // Safety-classifier declines re-route server-side instead of failing
      // the batch.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    };
    if (thinking) request.thinking = thinking;
    if (req.effort) request.output_config = { effort: req.effort };

    const response = await (
      this.client.beta.messages.create as unknown as (
        body: Record<string, unknown>,
      ) => Promise<Anthropic.Beta.BetaMessage>
    )(request);

    const inputTokens =
      (response.usage.input_tokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0) +
      (response.usage.cache_read_input_tokens ?? 0);
    const outputTokens = response.usage.output_tokens ?? 0;

    if (response.stop_reason === "refusal") {
      return { kind: "refusal", inputTokens, outputTokens };
    }
    if (response.stop_reason === "max_tokens") {
      return { kind: "truncated", inputTokens, outputTokens };
    }
    const text = response.content
      .filter(
        (block): block is Anthropic.Beta.BetaTextBlock => block.type === "text",
      )
      .map((block) => block.text)
      .join("");
    return { kind: "ok", text, inputTokens, outputTokens };
  }
}

/* ------------------------- openai-compatible ------------------------------ */

/** Efforts OpenAI-compatible APIs accept; xhigh/max clamp down with a note. */
function clampEffort(effort: string | undefined, providerId: string): string | undefined {
  if (!effort) return undefined;
  if (effort === "xhigh" || effort === "max") {
    console.warn(
      `[glotforge] effort "${effort}" is not supported by ${providerId} — using "high".`,
    );
    return "high";
  }
  return effort;
}

class OpenAICompatibleProvider implements TranslationProvider {
  constructor(
    readonly id: string,
    private baseUrl: string,
    private apiKeyEnv: string,
  ) {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const key = this.apiKeyEnv ? process.env[this.apiKeyEnv] : undefined;
    if (key) headers.Authorization = `Bearer ${key}`;
    else if (this.apiKeyEnv) {
      // A configured env var that is unset is almost always a mistake —
      // say so once instead of collecting a run of opaque 401s.
      console.warn(
        `[glotforge] provider "${this.id}": ${this.apiKeyEnv} is not set — sending unauthenticated requests.`,
      );
      this.apiKeyEnv = "";
    }
    return headers;
  }

  async translateBatch(req: ProviderRequest): Promise<ProviderResult> {
    const effort = clampEffort(
      req.effort ?? (req.thinking ? "medium" : undefined),
      this.id,
    );
    // api.openai.com wants max_completion_tokens; most compatible servers
    // (Ollama, Groq, OpenRouter) still take max_tokens. Both are attempted:
    // if a server rejects one parameter by name, retry once with the other.
    let body: Record<string, unknown> = {
      model: req.model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      ...(this.baseUrl.includes("api.openai.com")
        ? { max_completion_tokens: req.maxTokens }
        : { max_tokens: req.maxTokens }),
      ...(effort ? { reasoning_effort: effort } : {}),
    };

    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        // Parameter-compatibility retries: strip whichever knob the server
        // rejected and try once more.
        if (attempt === 0 && /reasoning_effort/.test(errText)) {
          const { reasoning_effort: _drop, ...rest } = body;
          body = rest;
          continue;
        }
        if (attempt === 0 && /max_completion_tokens/.test(errText)) {
          const { max_completion_tokens: max, ...rest } = body;
          body = { ...rest, max_tokens: max };
          continue;
        }
        if (attempt === 0 && /max_tokens/.test(errText)) {
          const { max_tokens: max, ...rest } = body;
          body = { ...rest, max_completion_tokens: max };
          continue;
        }
        throw new Error(
          `${this.id} ${res.status} ${res.statusText}: ${errText.slice(0, 300)}`,
        );
      }

      const data = (await res.json()) as {
        choices?: Array<{
          message?: { content?: string | null };
          finish_reason?: string;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = data.choices?.[0];
      const inputTokens = data.usage?.prompt_tokens ?? 0;
      const outputTokens = data.usage?.completion_tokens ?? 0;
      if (!choice) throw new Error(`${this.id}: response had no choices`);
      if (choice.finish_reason === "content_filter") {
        return { kind: "refusal", inputTokens, outputTokens };
      }
      if (choice.finish_reason === "length") {
        return { kind: "truncated", inputTokens, outputTokens };
      }
      return {
        kind: "ok",
        text: choice.message?.content ?? "",
        inputTokens,
        outputTokens,
      };
    }
  }
}

/* ------------------------------ resolution --------------------------------- */

const BUILTINS: Record<
  string,
  { kind: "anthropic" | "openai-compatible"; baseUrl: string; apiKeyEnv: string }
> = {
  anthropic: { kind: "anthropic", baseUrl: "", apiKeyEnv: "" },
  openai: {
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_TRANSLATION_KEY",
  },
};

const instances = new Map<string, TranslationProvider>();

/**
 * Provider instance for a name, merging config over built-ins. Instances
 * are cached for the process (one HTTP client / SDK client per provider).
 */
export function resolveProvider(
  name: string,
  config: ResolvedConfig,
): TranslationProvider {
  const cached = instances.get(name);
  if (cached) return cached;

  const builtin = BUILTINS[name];
  const configured = config.translation.providers[name];
  if (!builtin && !configured) {
    throw new Error(
      `unknown translation provider "${name}" — add it under translation.providers in i18n.config.json`,
    );
  }
  const kind = configured?.kind ?? builtin?.kind ?? "openai-compatible";

  let provider: TranslationProvider;
  if (kind === "anthropic") {
    provider = new AnthropicProvider(configured?.apiKeyEnv || undefined);
  } else {
    const baseUrl = configured?.baseUrl ?? builtin?.baseUrl;
    if (!baseUrl) {
      throw new Error(
        `translation provider "${name}" needs a baseUrl in translation.providers`,
      );
    }
    let apiKeyEnv = configured?.apiKeyEnv ?? builtin?.apiKeyEnv ?? "";
    // The default OpenAI key falls back to the conventional variable name.
    if (name === "openai" && apiKeyEnv === "OPENAI_TRANSLATION_KEY" && !process.env[apiKeyEnv]) {
      apiKeyEnv = "OPENAI_API_KEY";
    }
    provider = new OpenAICompatibleProvider(name, baseUrl, apiKeyEnv);
  }
  instances.set(name, provider);
  return provider;
}
