/**
 * Model registry for the translate command. Pricing is USD list price per
 * million tokens, used for the pre-run estimate and the post-run actuals.
 * Thinking is ON by default (translation quality is the whole point);
 * --no-thinking exists for cheap fast passes.
 */

export type ThinkingMode =
  | "adaptiveDefaultOn" // omitting `thinking` runs adaptive (Claude Opus 5, Sonnet 5)
  | "adaptiveDefaultOff" // must pass {type:"adaptive"} explicitly (Opus 4.8)
  | "alwaysOn" // cannot be disabled (Fable 5)
  | "extendedBudget"; // pre-4.6 style {type:"enabled", budget_tokens} (Haiku 4.5)

export interface ModelSpec {
  id: string;
  label: string;
  pricing: { inputPerMTok: number; outputPerMTok: number };
  thinking: ThinkingMode;
}

export const MODELS: Record<string, ModelSpec> = {
  "claude-opus-5": {
    id: "claude-opus-5",
    label: "Claude Opus 5",
    pricing: { inputPerMTok: 5, outputPerMTok: 25 },
    thinking: "adaptiveDefaultOn",
  },
  "claude-sonnet-5": {
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    pricing: { inputPerMTok: 2, outputPerMTok: 10 },
    thinking: "adaptiveDefaultOn",
  },
  "claude-opus-4-8": {
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8",
    pricing: { inputPerMTok: 5, outputPerMTok: 25 },
    thinking: "adaptiveDefaultOff",
  },
  "claude-haiku-4-5": {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    pricing: { inputPerMTok: 1, outputPerMTok: 5 },
    thinking: "extendedBudget",
  },
  "claude-fable-5": {
    id: "claude-fable-5",
    label: "Claude Fable 5",
    pricing: { inputPerMTok: 10, outputPerMTok: 50 },
    thinking: "alwaysOn",
  },
};

const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

export function resolveModel(id: string): ModelSpec {
  const spec = MODELS[id];
  if (spec) return spec;
  warnOnce(
    `model:${id}`,
    `[glotforge] Anthropic model "${id}" is not in the registry — cost estimates will assume Opus-tier pricing ($5/$25 per MTok).`,
  );
  return {
    id,
    label: id,
    pricing: { inputPerMTok: 5, outputPerMTok: 25 },
    thinking: "adaptiveDefaultOn",
  };
}

export interface PricingSpec {
  inputPerMTok: number;
  outputPerMTok: number;
}

/**
 * Label + pricing for any provider:model reference. Order: an explicit
 * entry in translation.models (keyed by the full reference), then the
 * built-in Anthropic registry, then $0 with a warning — the run still
 * works, the dollar figures just read 0.
 */
export function resolvePricing(
  raw: string,
  provider: string,
  model: string,
  configured: Record<
    string,
    { inputPerMTok: number; outputPerMTok: number; label?: string }
  >,
): { label: string; pricing: PricingSpec } {
  const entry = configured[raw] ?? configured[model];
  if (entry) {
    return {
      label: entry.label ?? raw,
      pricing: {
        inputPerMTok: entry.inputPerMTok,
        outputPerMTok: entry.outputPerMTok,
      },
    };
  }
  if (provider === "anthropic") {
    const spec = resolveModel(model);
    return { label: spec.label, pricing: spec.pricing };
  }
  warnOnce(
    `pricing:${raw}`,
    `[glotforge] no pricing for "${raw}" — add it under translation.models in i18n.config.json for cost estimates; showing $0.`,
  );
  return { label: raw, pricing: { inputPerMTok: 0, outputPerMTok: 0 } };
}

const THINKING_BUDGET = 8192;

/** The `thinking` request parameter for a model, or undefined to omit it. */
export function thinkingParam(
  spec: ModelSpec,
  enabled: boolean,
): { type: string; budget_tokens?: number } | undefined {
  switch (spec.thinking) {
    case "alwaysOn":
      if (!enabled) {
        console.warn(
          `[glotforge] ${spec.label} cannot run with thinking off — ignoring --no-thinking.`,
        );
      }
      return undefined; // always thinking; omit the parameter
    case "adaptiveDefaultOn":
      return enabled ? { type: "adaptive" } : { type: "disabled" };
    case "adaptiveDefaultOff":
      return enabled ? { type: "adaptive" } : undefined;
    case "extendedBudget":
      return enabled
        ? { type: "enabled", budget_tokens: THINKING_BUDGET }
        : undefined;
  }
}

export function costUsd(
  pricing: PricingSpec,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    (inputTokens * pricing.inputPerMTok + outputTokens * pricing.outputPerMTok) /
    1_000_000
  );
}
