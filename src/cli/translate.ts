import readline from "readline";
import { globToRegExp, matchesAny } from "../shared/glob";
import { validateTranslation } from "../shared/message";
import type { Catalog, Manifest, ResolvedConfig } from "../shared/types";
import { readCatalog, readManifest, writeCatalog } from "./catalog";
import { costUsd, resolvePricing, type PricingSpec } from "./models";
import { ProgressBar } from "./progress";
import {
  parseModelRef,
  resolveProvider,
  type ModelRef,
  type ProviderResult,
  type TranslationProvider,
} from "./providers";
import { languageLabel } from "./status";

export interface TranslateOptions {
  /** Restrict to these locales (default: all configured). */
  locales?: string[];
  /** Only messages with an origin matching these globs. */
  include?: string[];
  /** Skip messages whose origins all match these globs. */
  exclude?: string[];
  /** Retranslate even already-translated messages (within scope). */
  force?: boolean;
  /** Skip the confirmation prompt. */
  yes?: boolean;
  /** Print the estimate and exit without calling the API. */
  dryRun?: boolean;
  /** Force thinking OFF for every locale this run (outranks config). */
  noThinking?: boolean;
  /** Force thinking ON for every locale this run (outranks config). */
  forceThinking?: boolean;
  /** Reasoning effort override (low|medium|high|xhigh|max), all locales. */
  effort?: string;
  /** Model override for every locale this run — "model" or
   *  "provider:model" (outranks config). */
  model?: string;
  batchSize?: number;
}

/** Effective model/thinking/effort for one locale: CLI > override > global. */
interface LocaleSettings {
  ref: ModelRef;
  provider: TranslationProvider;
  label: string;
  pricing: PricingSpec;
  thinking: boolean;
  effort?: string;
}

interface WorkItem {
  hash: string;
  message: string;
  context?: string;
}

interface LocaleWork {
  locale: string;
  language: string;
  items: WorkItem[];
  settings: LocaleSettings;
}

const SYSTEM_CACHE_HEADER = "You are the translation engine for a web application.";

function buildSystemPrompt(
  config: ResolvedConfig,
  locale: string,
  language: string,
): string {
  const appContext = config.translation.appContext
    ? `\n\nAbout this application:\n${config.translation.appContext}`
    : "";
  const glossaryEntries = Object.entries(config.translation.glossary);
  const glossary = glossaryEntries.length
    ? `\n\nTerminology glossary — follow these rulings exactly:\n${glossaryEntries
        .map(([term, guidance]) => `- "${term}": ${guidance}`)
        .join("\n")}`
    : "";
  return `${SYSTEM_CACHE_HEADER} Translate user-interface strings from English (${config.sourceLocale}) into ${language} (${locale}).

Input: a JSON array of objects with "id", "message", and sometimes "context".
Output: ONLY a JSON object mapping every input id to its translated string — no commentary, no code fences, no ids missing.

Message format rules — these are structural tokens, not text:
- {name} placeholders must appear in the translation exactly as written, character for character.
- <tag>...</tag> pairs wrap the corresponding words. Keep tag names unchanged, reposition them as ${language} grammar requires, and keep self-closing tags like <br/>.
- Plural blocks look like {name, plural, one {text} other {text}}. Keep the outer structure and the argument name; translate only the branch text; use the plural categories ${language} grammar actually requires (always include "other"); # renders the number — keep it where the number belongs.
- Backslash escapes (\\{ \\< \\\\ \\#) must stay escaped.

Translation guidance:
- These are concise UI strings for professional software. Match the register, capitalization, and length conventions of high-quality ${language} interfaces.
- "context" disambiguates meaning ("Wire" as in a wire transfer, not a cable). Follow it; never translate it or echo it into the output.
- Keep product names, brand names, and technical identifiers in their original form.
- TRANSLATE ordinary UI vocabulary (module, admin, mailbox, settings) into natural ${language} — leaving such words in English is wrong unless the glossary says to keep them.
- Be terminologically consistent: once you render a recurring term one way, use exactly that rendering in every string of this task, including loanword spellings.
- Prefer natural phrasing over literal word order.${appContext}${glossary}`;
}

function buildUserPayload(items: WorkItem[]): string {
  return JSON.stringify(
    items.map((item) => ({
      id: item.hash,
      message: item.message,
      ...(item.context ? { context: item.context } : {}),
    })),
    null,
    1,
  );
}

function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/** Rough token estimate for text we don't countTokens (output-side). */
function approxTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

interface BatchTask {
  locale: string;
  language: string;
  items: WorkItem[];
  settings: LocaleSettings;
}

interface RunTotals {
  inputTokens: number;
  outputTokens: number;
  /** Accumulated per response at each task's own model pricing. */
  costUsd: number;
  translated: number;
  failed: { locale: string; hash: string; reason: string }[];
}

export async function runTranslate(
  config: ResolvedConfig,
  cwd: string,
  options: TranslateOptions = {},
): Promise<void> {
  const batchSize = options.batchSize ?? config.translation.batchSize;

  const settingsFor = (locale: string): LocaleSettings => {
    const override = config.translation.overrides[locale] ?? {};
    const modelId = options.model ?? override.model ?? config.translation.model;
    let thinking = options.noThinking
      ? false
      : options.forceThinking
        ? true
        : (override.thinking ?? config.translation.thinking);
    const effort =
      options.effort ?? override.effort ?? config.translation.effort ?? "";
    if (!thinking && (effort === "xhigh" || effort === "max")) {
      console.warn(
        `[glotforge] ${locale}: thinking cannot be disabled at effort "${effort}" — keeping thinking on.`,
      );
      thinking = true;
    }
    const ref = parseModelRef(modelId);
    const { label, pricing } = resolvePricing(
      ref.raw,
      ref.provider,
      ref.model,
      config.translation.models,
    );
    return {
      ref,
      provider: resolveProvider(ref.provider, config),
      label,
      pricing,
      thinking,
      effort: effort || undefined,
    };
  };

  const manifest = readManifest(config, cwd);
  const scopeRes = {
    include: (options.include ?? []).map(globToRegExp),
    exclude: (options.exclude ?? []).map(globToRegExp),
  };
  const inScope = (entry: Manifest[string]): boolean => {
    const files = entry.origins.map((o) => o.slice(0, o.lastIndexOf(":")));
    if (scopeRes.include.length && !files.some((f) => matchesAny(f, scopeRes.include))) {
      return false;
    }
    if (scopeRes.exclude.length && files.every((f) => matchesAny(f, scopeRes.exclude))) {
      return false;
    }
    return true;
  };

  const targetLocales = options.locales?.length
    ? options.locales
    : config.locales;
  for (const locale of targetLocales) {
    if (!config.locales.includes(locale)) {
      throw new Error(`locale "${locale}" is not in i18n.config.json`);
    }
  }

  // ---- build the work list ------------------------------------------------
  const catalogs = new Map<string, Catalog>();
  const work: LocaleWork[] = [];
  for (const locale of targetLocales) {
    const catalog = readCatalog(config, cwd, locale);
    catalogs.set(locale, catalog);
    const items: WorkItem[] = [];
    for (const [hash, entry] of Object.entries(manifest)) {
      if (!inScope(entry)) continue;
      if (!options.force && catalog[hash]) continue;
      items.push({ hash, message: entry.message, context: entry.context });
    }
    if (items.length) {
      work.push({
        locale,
        language: languageLabel(locale),
        items,
        settings: settingsFor(locale),
      });
    }
  }

  if (!work.length) {
    console.log("Nothing to translate — every in-scope message is already in the catalogs.");
    return;
  }

  const tasks: BatchTask[] = work.flatMap((lw) =>
    chunk(lw.items, batchSize).map((items) => ({
      locale: lw.locale,
      language: lw.language,
      items,
      settings: lw.settings,
    })),
  );
  const totalMessages = work.reduce((sum, lw) => sum + lw.items.length, 0);

  // ---- estimate ------------------------------------------------------------
  console.log("\nEstimating cost...");

  let estInput = 0;
  let estOutput = 0;
  let estCost = 0;
  const COUNT_LIMIT = 30; // countTokens the first N batches, extrapolate the rest
  let counted = 0;
  let countedChars = 0;
  let countedTokens = 0;
  for (const task of tasks) {
    const system = buildSystemPrompt(config, task.locale, task.language);
    const payload = buildUserPayload(task.items);
    const outGuess = Math.round(
      task.items.reduce((sum, item) => sum + approxTokens(item.message) + 14, 0) *
        1.25 +
        (task.settings.thinking ? 300 : 0),
    );
    let inGuess: number | null = null;
    // Providers with a free counting endpoint get exact numbers for the
    // first batches; everything else extrapolates by observed chars/token.
    if (counted < COUNT_LIMIT && task.settings.provider.countInputTokens) {
      try {
        inGuess = await task.settings.provider.countInputTokens(
          task.settings.ref.model,
          system,
          payload,
        );
        counted++;
        countedChars += system.length + payload.length;
        countedTokens += inGuess;
      } catch {
        inGuess = null;
      }
    }
    if (inGuess === null) {
      const ratio = countedChars > 0 ? countedTokens / countedChars : 1 / 3.6;
      inGuess = Math.round((system.length + payload.length) * ratio);
    }
    estInput += inGuess;
    estOutput += outGuess;
    estCost += costUsd(task.settings.pricing, inGuess, outGuess);
  }

  console.log("\nPlanned work:");
  for (const lw of work) {
    const s = lw.settings;
    console.log(
      `  ${lw.locale.padEnd(8)} ${String(lw.items.length).padStart(5)} messages  (${lw.language})  — ${s.label} [${s.ref.provider}], thinking ${s.thinking ? "on" : "off"}${s.effort ? `, effort ${s.effort}` : ""}`,
    );
  }
  console.log(
    `\nEstimate: ${totalMessages} messages · ${tasks.length} requests · ~${estInput.toLocaleString()} input + ~${estOutput.toLocaleString()} output tokens ≈ $${estCost.toFixed(4)}`,
  );
  console.log("(Output and thinking are estimates; actuals are reported when the run finishes.)");

  if (options.dryRun) return;
  if (!options.yes) {
    const ok = await confirm("\nProceed? [y/N] ");
    if (!ok) {
      console.log("Aborted — nothing was translated or spent.");
      return;
    }
  }

  // ---- execute ------------------------------------------------------------
  const totals: RunTotals = {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    translated: 0,
    failed: [],
  };
  const bar = new ProgressBar(totalMessages);
  let done = 0;

  const runBatch = async (task: BatchTask): Promise<void> => {
    const { provider, ref, pricing } = task.settings;
    const system = buildSystemPrompt(config, task.locale, task.language);
    let pending = task.items;
    for (let attempt = 0; attempt < 2 && pending.length; attempt++) {
      const retryNote =
        attempt === 0
          ? ""
          : "\n\nYour previous answer for these ids was missing or structurally invalid (placeholders/tags must match the source exactly). Return corrected translations for ALL ids.";

      let result: ProviderResult;
      try {
        result = await provider.translateBatch({
          model: ref.model,
          system,
          user: buildUserPayload(pending) + retryNote,
          maxTokens: config.translation.maxTokens,
          thinking: task.settings.thinking,
          effort: task.settings.effort,
        });
      } catch (err) {
        if (attempt === 0) continue; // one retry on transport/API errors
        for (const item of pending) {
          totals.failed.push({
            locale: task.locale,
            hash: item.hash,
            reason: (err as Error).message,
          });
        }
        return;
      }

      totals.inputTokens += result.inputTokens;
      totals.outputTokens += result.outputTokens;
      // Priced at THIS task's model — locales may run on different models.
      totals.costUsd += costUsd(pricing, result.inputTokens, result.outputTokens);

      if (result.kind === "refusal") {
        for (const item of pending) {
          totals.failed.push({
            locale: task.locale,
            hash: item.hash,
            reason: "model refused the request",
          });
        }
        return;
      }
      if (result.kind === "truncated") {
        for (const item of pending) {
          totals.failed.push({
            locale: task.locale,
            hash: item.hash,
            reason: "output truncated — raise translation.maxTokens or lower batchSize",
          });
        }
        return;
      }

      const parsed = extractJson(result.text) ?? {};

      const stillPending: WorkItem[] = [];
      const catalog = catalogs.get(task.locale)!;
      for (const item of pending) {
        const translation = parsed[item.hash];
        if (typeof translation !== "string" || !translation.trim()) {
          stillPending.push(item);
          continue;
        }
        const problem = validateTranslation(item.message, translation);
        if (problem) {
          stillPending.push(item);
          continue;
        }
        catalog[item.hash] = translation;
        totals.translated++;
        done++;
        const preview =
          item.message.length > 34 ? item.message.slice(0, 33) + "…" : item.message;
        bar.update(
          done,
          `${task.locale}  $${totals.costUsd.toFixed(4)}  "${preview}"`,
        );
      }
      // Persist progress after every batch — a crash loses nothing done.
      writeCatalog(config, cwd, task.locale, catalog);
      pending = stillPending;
    }
    for (const item of pending) {
      totals.failed.push({
        locale: task.locale,
        hash: item.hash,
        reason: "translation missing or structurally invalid after retry",
      });
      done++;
      bar.update(done, `${task.locale}  (skipped ${item.hash})`);
    }
  };

  // Simple concurrency pool.
  const concurrency = Math.max(1, config.translation.concurrency);
  let nextTask = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (nextTask < tasks.length) {
      const task = tasks[nextTask++];
      await runBatch(task);
    }
  });
  await Promise.all(workers);
  bar.finish();

  // ---- report --------------------------------------------------------------
  console.log(
    `\nDone: ${totals.translated}/${totalMessages} translated · ${totals.inputTokens.toLocaleString()} input + ${totals.outputTokens.toLocaleString()} output tokens · actual cost $${totals.costUsd.toFixed(4)}`,
  );
  if (totals.failed.length) {
    console.log(`\n${totals.failed.length} message(s) skipped:`);
    for (const failure of totals.failed.slice(0, 20)) {
      console.log(`  ${failure.locale} ${failure.hash}: ${failure.reason}`);
    }
    if (totals.failed.length > 20) {
      console.log(`  ...and ${totals.failed.length - 20} more`);
    }
    console.log('Re-run "glotforge translate" to retry the skipped messages.');
    process.exitCode = 1;
  }
}
