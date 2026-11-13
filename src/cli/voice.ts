import fs from "fs";
import path from "path";
import readline from "readline";
import { parseMessage } from "../shared/message";
import { plainTextOf, splitSentences, splitWords, unspeakableReason } from "../shared/speech";
import {
  DEFAULT_VOICE_VARIANT,
  type ResolvedConfig,
  type ResolvedVoice,
  type VoiceClip,
  type VoiceEntry,
  type VoiceManifest,
  type VoiceTiming,
} from "../shared/types";
import { alignWords, wordsFromMarks } from "./align";
import { audioDurationMs, mp3FromPcm, readPcm, wavFromPcm } from "./audio";
import { readCatalog, readManifest } from "./catalog";
import {
  CHARS_PER_TOKEN,
  GoogleApiError,
  familyHonoursMarks,
  generateSpeech,
  pricePerMillionChars,
  pricePerMillionTokens,
  recognizeWords,
  resolveCredentials,
  synthesize,
} from "./google";
import { ProgressBar } from "./progress";
import { languageLabel } from "./status";
import {
  audioDir,
  clipFile,
  deleteClips,
  readVoiceManifest,
  voicedLocales,
  writeClip,
  writeVoiceManifest,
} from "./voice-catalog";

export interface VoiceOptions {
  /** Restrict to these locales (default: every locale with a configured voice). */
  locales?: string[];
  /** Regenerate entries that are already current. */
  force?: boolean;
  /** Skip the confirmation prompt. */
  yes?: boolean;
  /** Print the estimate and exit without calling the API. */
  dryRun?: boolean;
}

type TimingMode = "marks" | "align" | "none";

interface EntryTask {
  locale: string;
  variant: string;
  hash: string;
  key?: string;
  sentences: string[];
  /** The voice with its model, style and API. */
  spec: ResolvedVoice;
  timingMode: TimingMode;
  /** Current entry whose audio can be kept — only the timing is stale. */
  reuse?: VoiceEntry;
  /** Files of the entry being replaced. */
  previousFiles: string[];
}

interface Totals {
  chars: number;
  sttMs: number;
  costUsd: number;
  generated: number;
  failed: { locale: string; hash: string; reason: string }[];
  /** Locales whose word timing fell back to sentence level, with why. */
  downgraded: Map<string, string>;
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

/** Speech runs about fifteen characters a second — good enough for an estimate. */
const CHARS_PER_SECOND = 15;

function timingModeFor(config: ResolvedConfig, spec: ResolvedVoice): TimingMode {
  if (config.voice.wordTiming === "none") return "none";
  // A speech model takes plain text and a style, never SSML, so marks are
  // not an option for it whatever the setting says.
  if (spec.model) return "align";
  switch (config.voice.wordTiming) {
    case "marks":
      return "marks";
    case "align":
      return "align";
    default:
      return familyHonoursMarks(spec.voice) ? "marks" : "align";
  }
}

/** How a voice reads in the plan and in notes: its name, with its model when it has one. */
function voiceLabel(spec: ResolvedVoice): string {
  return spec.model ? `${spec.voice} (${spec.model})` : spec.voice;
}

/**
 * What synthesizing text costs. A voice family is priced by the
 * character; a speech model by the token, from the counts the API
 * reported when it gave them, otherwise from the text and the seconds of
 * speech. A model with no known price costs nothing here.
 */
function synthesisCost(
  config: ResolvedConfig,
  spec: ResolvedVoice,
  chars: number,
  seconds: number,
  tokens?: { input: number; output: number },
): number {
  if (!spec.model) {
    return (chars * pricePerMillionChars(spec.voice, config.voice.pricing)) / 1_000_000;
  }
  const price = pricePerMillionTokens(spec.model, config.voice.tokenPricing);
  if (!price) return 0;
  const input = tokens?.input ?? (chars + spec.style.length) / CHARS_PER_TOKEN;
  const output = tokens?.output ?? seconds * config.voice.audioTokensPerSecond;
  return (input * price.input + output * price.output) / 1_000_000;
}

function entryIsCurrent(
  entry: VoiceEntry | undefined,
  task: Omit<EntryTask, "reuse" | "previousFiles">,
  config: ResolvedConfig,
): "current" | "stale" | "timing-only" {
  if (!entry) return "stale";
  if (
    entry.voice !== task.spec.voice ||
    (entry.model ?? "") !== task.spec.model ||
    (entry.style ?? "") !== task.spec.style ||
    entry.format !== config.voice.format ||
    entry.speakingRate !== config.voice.speakingRate ||
    entry.clips.length !== task.sentences.length ||
    entry.clips.some((clip, i) => clip.text !== task.sentences[i])
  ) {
    return "stale";
  }
  const wantsWords = task.timingMode !== "none";
  const hasWords = entry.timing !== "sentence";
  if (wantsWords === hasWords) return "current";
  return "timing-only";
}

export async function runVoice(
  config: ResolvedConfig,
  cwd: string,
  options: VoiceOptions = {},
): Promise<void> {
  const configuredLocales = voicedLocales(config);
  if (!configuredLocales.length) {
    throw new Error(
      'no voices configured — add "voice": { "voices": { "en-US": "en-US-Chirp3-HD-Aoede", ... } } to i18n.config.json, or a "model" with its speaker names',
    );
  }
  const targetLocales = options.locales?.length ? options.locales : configuredLocales;
  for (const locale of targetLocales) {
    if (!configuredLocales.includes(locale)) {
      throw new Error(`locale "${locale}" has no voice in i18n.config.json (voice.voices)`);
    }
  }

  const manifest = readManifest(config, cwd);
  const voiced = Object.entries(manifest).filter(([, entry]) => entry.voice !== undefined);
  if (!voiced.length) {
    console.log(
      'Nothing to voice — mark messages with <Trans voice="key"> or t("...", { voice: "key" }) and run "glotforge extract".',
    );
    return;
  }

  // ---- build the work list ------------------------------------------------
  const voiceManifests = new Map<string, VoiceManifest>();
  const tasks: EntryTask[] = [];
  const skippedMissing: { locale: string; hash: string }[] = [];
  let alreadyCurrent = 0;

  for (const locale of targetLocales) {
    const variants = config.voice.voices[locale];
    const existing = readVoiceManifest(config, cwd, locale);
    const catalog = locale === config.sourceLocale ? null : readCatalog(config, cwd, locale);

    // Keys are rebuilt from the manifest every run so renames never leave a
    // stale key behind; variants no longer configured are dropped with
    // their files.
    const keys: Record<string, string> = {};
    for (const [hash, entry] of voiced) {
      if (typeof entry.voice === "string") keys[entry.voice] = hash;
    }
    const next: VoiceManifest = {
      variants: Object.keys(variants),
      keys,
      entries: {},
    };
    for (const [hash, byVariant] of Object.entries(existing.entries)) {
      const kept: Record<string, VoiceEntry> = {};
      for (const [name, entry] of Object.entries(byVariant)) {
        if (variants[name]) kept[name] = entry;
        else deleteClips(config, cwd, entry.clips.map((clip) => clip.file));
      }
      if (Object.keys(kept).length) next.entries[hash] = kept;
    }
    voiceManifests.set(locale, next);

    for (const [hash, entry] of voiced) {
      const message = catalog ? catalog[hash] : entry.message;
      if (!message) {
        skippedMissing.push({ locale, hash });
        continue;
      }
      let sentences: string[];
      try {
        const nodes = parseMessage(message);
        const reason = unspeakableReason(nodes);
        if (reason) {
          skippedMissing.push({ locale, hash });
          continue;
        }
        const spoken = plainTextOf(nodes);
        // One clip per sentence, or the whole message as a single clip.
        sentences =
          config.voice.clips === "message"
            ? [spoken.trim()].filter(Boolean)
            : splitSentences(spoken, locale);
      } catch {
        skippedMissing.push({ locale, hash });
        continue;
      }
      if (!sentences.length) continue;
      for (const [variant, spec] of Object.entries(variants)) {
        const timingMode = timingModeFor(config, spec);
        const base = {
          locale,
          variant,
          hash,
          key: typeof entry.voice === "string" ? entry.voice : undefined,
          sentences,
          spec,
          timingMode,
        };
        const current = next.entries[hash]?.[variant];
        const state = options.force ? "stale" : entryIsCurrent(current, base, config);
        if (state === "current") {
          alreadyCurrent++;
          continue;
        }
        // Existing audio can be kept when only the timing changed — except
        // for marks, which only come back from a fresh synthesis.
        const filesOnDisk =
          state === "timing-only" &&
          timingMode !== "marks" &&
          current !== undefined &&
          current.clips.every((clip) => fs.existsSync(path.join(audioDir(config, cwd), clip.file)));
        tasks.push({
          ...base,
          reuse: filesOnDisk ? current : undefined,
          previousFiles: current ? current.clips.map((clip) => clip.file) : [],
        });
      }
    }
  }

  if (!tasks.length) {
    console.log(
      `Nothing to generate — ${alreadyCurrent} voiced entr${alreadyCurrent === 1 ? "y is" : "ies are"} current.` +
        (skippedMissing.length
          ? ` ${skippedMissing.length} skipped for missing translations — run "glotforge translate" first.`
          : ""),
    );
    return;
  }

  // ---- estimate ------------------------------------------------------------
  let estChars = 0;
  let estSttSeconds = 0;
  let estCost = 0;
  let estFamilyChars = 0;
  const unpriced = new Set<string>();
  const perLocale = new Map<string, { entries: number; clips: number; chars: number; voice: string; mode: TimingMode }>();
  for (const task of tasks) {
    const rowKey = `${task.locale}${task.variant === DEFAULT_VOICE_VARIANT ? "" : ` / ${task.variant}`}`;
    const chars = task.reuse ? 0 : task.sentences.reduce((sum, s) => sum + s.length, 0);
    const sttSeconds =
      task.timingMode === "align"
        ? task.sentences.reduce((sum, s) => sum + s.length, 0) / CHARS_PER_SECOND
        : 0;
    estChars += chars;
    estSttSeconds += sttSeconds;
    if (!task.spec.model) estFamilyChars += chars;
    else if (chars > 0 && !pricePerMillionTokens(task.spec.model, config.voice.tokenPricing)) {
      unpriced.add(task.spec.model);
    }
    estCost +=
      // The style travels with every clip, so it is counted once per clip.
      (task.reuse
        ? 0
        : task.sentences.reduce(
            (sum, s) => sum + synthesisCost(config, task.spec, s.length, s.length / CHARS_PER_SECOND),
            0,
          )) +
      (sttSeconds / 60) * config.voice.sttPerMinuteUsd;
    const row = perLocale.get(rowKey) ?? {
      entries: 0,
      clips: 0,
      chars: 0,
      voice: voiceLabel(task.spec),
      mode: task.timingMode,
    };
    row.entries++;
    row.clips += task.sentences.length;
    row.chars += chars;
    perLocale.set(rowKey, row);
  }

  console.log("\nPlanned work:");
  const rowWidth = Math.max(...[...perLocale.keys()].map((k) => k.length), 8);
  for (const [rowKey, row] of perLocale) {
    const locale = rowKey.split(" / ")[0];
    console.log(
      `  ${rowKey.padEnd(rowWidth)} ${String(row.entries).padStart(5)} messages / ${String(row.clips).padStart(5)} clips  (${languageLabel(locale)})  — ${row.voice}, ${config.voice.format}, word timing: ${row.mode === "none" ? "off" : row.mode}`,
    );
  }
  if (skippedMissing.length) {
    console.log(
      `  ${skippedMissing.length} message(s) skipped for missing translations — run "glotforge translate" first.`,
    );
  }
  console.log(
    `\nEstimate: ${estChars.toLocaleString()} characters synthesized` +
      (estSttSeconds > 0 ? ` + ~${Math.ceil(estSttSeconds / 60)} min aligned` : "") +
      ` ≈ $${estCost.toFixed(4)}` +
      (estFamilyChars > 0 ? " (Google's monthly free tier may cover it)" : ""),
  );
  for (const model of unpriced) {
    console.log(
      `  ${model} has no price on file, so its speech is not in the estimate — add it to voice.tokenPricing.`,
    );
  }

  if (options.dryRun) return;
  if (!options.yes) {
    const ok = await confirm("\nProceed? [y/N] ");
    if (!ok) {
      console.log("Aborted — nothing was generated or spent.");
      return;
    }
  }

  // ---- execute ------------------------------------------------------------
  const creds = resolveCredentials(config);
  const totals: Totals = {
    chars: 0,
    sttMs: 0,
    costUsd: 0,
    generated: 0,
    failed: [],
    downgraded: new Map(),
  };
  const bar = new ProgressBar(tasks.length);
  let done = 0;

  const runEntry = async (task: EntryTask): Promise<void> => {
    const clips: VoiceClip[] = [];
    const newFiles: string[] = [];
    const sources: ("marks" | "align")[] = [];
    let localeMode: TimingMode = task.timingMode;
    const { spec } = task;
    if (spec.api === "generate-content" && config.voice.speakingRate !== 1) {
      totals.downgraded.set(
        `${spec.model}:rate`,
        `${spec.model} takes no speaking rate, so voice.speakingRate was not applied — set the pace in voice.style`,
      );
    }

    try {
      for (let index = 0; index < task.sentences.length; index++) {
        const sentence = task.sentences[index];
        const words = splitWords(sentence, task.locale);
        const file = clipFile(task.locale, task.hash, task.variant, index, config.voice.format);

        let audio: Buffer;
        let durationMs: number;
        let timepoints: Map<number, number> | null = null;
        const reused = task.reuse?.clips[index];
        if (reused && reused.file === file) {
          audio = fs.readFileSync(path.join(audioDir(config, cwd), file));
          durationMs = reused.durationMs;
        } else {
          let tokens: { input: number; output: number } | undefined;
          if (spec.api === "generate-content") {
            // The model returns uncompressed audio: keep it as WAV, or
            // encode it when the clips are MP3.
            const spoken = await generateSpeech(creds, config, {
              text: sentence,
              voice: spec.voice,
              model: spec.model,
              style: spec.style,
            });
            const pcm = readPcm(spoken.audio, spoken.mimeType);
            audio =
              config.voice.format === "MP3"
                ? await mp3FromPcm(pcm, config.voice.mp3Bitrate)
                : wavFromPcm(pcm);
            tokens = spoken.tokens;
          } else {
            const result = await synthesize(creds, {
              text: sentence,
              markWords: localeMode === "marks" ? words : undefined,
              locale: task.locale,
              voice: spec.voice,
              model: spec.model,
              style: spec.style,
              format: config.voice.format,
              speakingRate: config.voice.speakingRate,
            });
            audio = result.audio;
            timepoints = result.timepoints;
            tokens = result.tokens;
          }
          durationMs = audioDurationMs(audio, config.voice.format);
          totals.chars += sentence.length;
          totals.costUsd += synthesisCost(config, spec, sentence.length, durationMs / 1000, tokens);
          writeClip(config, cwd, file, audio);
          newFiles.push(file);
        }

        const clip: VoiceClip = { file, text: sentence, durationMs };

        if (localeMode === "marks") {
          const fromMarks = timepoints ? wordsFromMarks(words, timepoints, durationMs) : null;
          if (fromMarks) {
            clip.words = fromMarks;
            sources.push("marks");
          } else {
            // The voice ignored the marks — align this and the rest instead.
            if (!totals.downgraded.has(`${spec.voice}:marks`)) {
              totals.downgraded.set(
                `${spec.voice}:marks`,
                `${spec.voice} ignores SSML marks — word timing comes from Speech-to-Text alignment instead`,
              );
            }
            localeMode = "align";
          }
        }
        if (localeMode === "align" && !clip.words) {
          try {
            const heard = await recognizeWords(creds, config, audio, task.locale);
            totals.sttMs += durationMs;
            totals.costUsd += (durationMs / 60_000) * config.voice.sttPerMinuteUsd;
            const aligned = alignWords(words, heard, durationMs);
            if (aligned) {
              clip.words = aligned;
              sources.push("align");
            }
          } catch (err) {
            if (err instanceof GoogleApiError && err.status === 400) {
              // Language not supported by the recogniser — sentence timing.
              if (!totals.downgraded.has(`${task.locale}:align`)) {
                totals.downgraded.set(
                  `${task.locale}:align`,
                  `Speech-to-Text rejected ${task.locale} (${err.message}) — sentence-level timing only`,
                );
              }
              localeMode = "none";
            } else {
              throw err;
            }
          }
        }
        clips.push(clip);
      }
    } catch (err) {
      deleteClips(config, cwd, newFiles);
      totals.failed.push({
        locale: `${task.locale}/${task.variant}`,
        hash: task.hash,
        reason: (err as Error).message,
      });
      done++;
      bar.update(done, `${task.locale}/${task.variant}  (failed ${task.hash})`);
      return;
    }

    // Replace the entry: drop files the new clip set no longer uses.
    const keep = new Set(clips.map((clip) => clip.file));
    deleteClips(
      config,
      cwd,
      task.previousFiles.filter((file) => !keep.has(file)),
    );
    // Word timing counts only when every clip has it; the method recorded
    // is the weaker of the two when they were mixed.
    const timing: VoiceTiming = clips.every((clip) => clip.words)
      ? sources.includes("align")
        ? "align"
        : "marks"
      : "sentence";
    const entry: VoiceEntry = {
      voice: spec.voice,
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.style ? { style: spec.style } : {}),
      format: config.voice.format,
      speakingRate: config.voice.speakingRate,
      timing,
      clips,
    };
    const vm = voiceManifests.get(task.locale)!;
    vm.entries[task.hash] = { ...(vm.entries[task.hash] ?? {}), [task.variant]: entry };
    // Persist after every entry — a crash loses nothing done.
    writeVoiceManifest(config, cwd, task.locale, vm);
    totals.generated++;
    done++;
    const preview =
      task.sentences[0].length > 34 ? task.sentences[0].slice(0, 33) + "…" : task.sentences[0];
    bar.update(done, `${task.locale}/${task.variant}  $${totals.costUsd.toFixed(4)}  "${preview}"`);
  };

  const concurrency = Math.max(1, config.voice.concurrency);
  let nextTask = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (nextTask < tasks.length) {
      const task = tasks[nextTask++];
      await runEntry(task);
    }
  });
  await Promise.all(workers);
  bar.finish();

  // Locales with no new entries still get their key map refreshed.
  for (const [locale, vm] of voiceManifests) {
    writeVoiceManifest(config, cwd, locale, vm);
  }

  // ---- report --------------------------------------------------------------
  console.log(
    `\nDone: ${totals.generated}/${tasks.length} message voices generated · ${totals.chars.toLocaleString()} characters` +
      (totals.sttMs > 0 ? ` · ${(totals.sttMs / 60_000).toFixed(1)} min aligned` : "") +
      ` · cost $${totals.costUsd.toFixed(4)}`,
  );
  for (const note of totals.downgraded.values()) console.log(`  note: ${note}`);
  if (totals.failed.length) {
    console.log(`\n${totals.failed.length} message(s) failed:`);
    for (const failure of totals.failed.slice(0, 20)) {
      console.log(`  ${failure.locale} ${failure.hash}: ${failure.reason}`);
    }
    if (totals.failed.length > 20) {
      console.log(`  ...and ${totals.failed.length - 20} more`);
    }
    console.log('Re-run "glotforge voice" to retry the failed messages.');
    process.exitCode = 1;
  }
}
