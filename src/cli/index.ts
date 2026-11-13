#!/usr/bin/env node
/**
 * glotforge — catalog CLI.
 *
 *   glotforge init                       scaffold i18n.config.json + catalog dir
 *   glotforge extract [--include g] [--exclude g]
 *   glotforge translate [--locale a,b] [--include g] [--exclude g]
 *                      [--force] [--yes] [--dry-run] [--no-thinking]
 *                      [--effort low|medium|high|xhigh|max]
 *                      [--model id] [--batch-size n]
 *   glotforge voice [--locale a,b] [--force] [--yes] [--dry-run]
 *   glotforge voice --sync | --prune [--locale a,b] [--yes] [--dry-run]
 *   glotforge status [--json]
 */

import fs from "fs";
import path from "path";
import { CONFIG_FILE, loadConfig } from "./config";
import { loadEnvFiles } from "./env";
import { runExtract } from "./extract";
import { runTranslate } from "./translate";
import { runVoice } from "./voice";
import { computeStatus, printStatus } from "./status";

interface ParsedArgs {
  command: string;
  flags: Map<string, string[]>;
  booleans: Set<string>;
}

const BOOLEAN_FLAGS = new Set([
  "force",
  "yes",
  "dry-run",
  "no-thinking",
  "thinking",
  "sync",
  "prune",
  "json",
  "help",
]);

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "help";
  const flags = new Map<string, string[]>();
  const booleans = new Set<string>();
  const rest = argv[0] && !argv[0].startsWith("-") ? argv.slice(1) : argv;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) {
      if (arg === "-y") booleans.add("yes");
      continue;
    }
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      booleans.add(name);
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) {
      console.error(`Flag --${name} requires a value.`);
      process.exit(2);
    }
    i++;
    const list = flags.get(name) ?? [];
    // Comma-separated and repeated flags both accumulate.
    list.push(...value.split(",").map((v) => v.trim()).filter(Boolean));
    flags.set(name, list);
  }
  return { command, flags, booleans };
}

const HELP = `glotforge — keyless, source-language-in-code translation catalogs

Commands:
  init        Scaffold ${CONFIG_FILE} and the catalog directory
  extract     Scan source, reconcile messages.json, prune orphaned translations
  translate   Fill missing catalog entries via the Claude API (thinking on by default)
  voice       Generate spoken audio (+ word timing) for messages marked voice
  status      Per-locale translation and audio coverage

Common flags:
  --include <glob>[,glob]   Limit extract/translate to matching files
  --exclude <glob>[,glob]   Skip matching files
  translate and voice:
  --locale <a,b>            Target specific locales
  --force                   Regenerate entries already in the catalog (in scope)
  --dry-run                 Show the cost estimate and exit
  --yes / -y                Skip the confirmation prompt
  translate only:
  --no-thinking             Force thinking OFF for all locales this run
  --thinking                Force thinking ON for all locales this run
  --effort <level>          low | medium | high | xhigh | max
  --model <ref>             Override the configured model for all locales —
                            "claude-opus-5" or "provider:model"
                            ("openai:gpt-5.2", "ollama:qwen3", ...)

Per-locale defaults live in i18n.config.json under translation.overrides,
e.g. "overrides": { "am-ET": { "thinking": true } } — CLI flags outrank them.
  --batch-size <n>          Messages per API request
  voice only:
  --sync                    Upload clips from the audio directory that the
                            storage bucket does not have yet
  --prune                   Delete clip files in storage that no catalog records
  status only:
  --json                    Machine-readable output

Catalog files (messages.json, catalog/<locale>.json, voice/<locale>.json and
the clip files) are committed to git — they ARE the cache; never gitignore
them. With voice.storage set to a bucket the clip files live there and only
the catalogs are committed. voice needs Google credentials: GOOGLE_APPLICATION_CREDENTIALS (a
service-account key) or GOOGLE_TTS_KEY (an API key, plus voice.project).`;

const CONFIG_TEMPLATE = {
  locales: ["es-ES", "fr-FR", "pt-BR", "id-ID", "ja-JP", "ko-KR"],
  sourceLocale: "en-US",
  include: ["src/**/*.{ts,tsx,js,jsx}"],
  exclude: [],
  catalogDir: "i18n",
  translation: {
    model: "claude-opus-5",
    batchSize: 20,
    appContext:
      "Describe the app here — audience, tone, and domain terms. This text is included in every translation prompt.",
  },
};

function runInit(cwd: string): void {
  const configPath = path.join(cwd, CONFIG_FILE);
  if (fs.existsSync(configPath)) {
    console.log(`${CONFIG_FILE} already exists — leaving it alone.`);
  } else {
    fs.writeFileSync(
      configPath,
      JSON.stringify(CONFIG_TEMPLATE, null, 2) + "\n",
      "utf8",
    );
    console.log(`Created ${CONFIG_FILE} — edit the locales and appContext.`);
  }
  const catalogDir = path.join(cwd, CONFIG_TEMPLATE.catalogDir, "catalog");
  fs.mkdirSync(catalogDir, { recursive: true });
  const manifest = path.join(cwd, CONFIG_TEMPLATE.catalogDir, "messages.json");
  if (!fs.existsSync(manifest)) {
    fs.writeFileSync(manifest, "{}\n", "utf8");
  }
  console.log(
    `Catalog directory ready at ${CONFIG_TEMPLATE.catalogDir}/ — commit it; it is the translation cache.`,
  );
}

async function main(): Promise<void> {
  const { command, flags, booleans } = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();

  // Pick up ANTHROPIC_TRANSLATION_KEY (etc.) from the app's own
  // .env.local / .env — real environment variables always win over file
  // values.
  loadEnvFiles(cwd);

  if (booleans.has("help") || command === "help") {
    console.log(HELP);
    return;
  }

  if (command === "init") {
    runInit(cwd);
    return;
  }

  const config = loadConfig(cwd);

  if (command === "extract") {
    const summary = runExtract(config, cwd, {
      include: flags.get("include"),
      exclude: flags.get("exclude"),
    });
    console.log(
      `\nScanned ${summary.filesScanned} files${summary.scoped ? " (scoped run)" : ""} — ${summary.totalMessages} messages` +
        `, ${summary.added.length} new, ${summary.removed.length} removed`,
    );
    for (const [locale, missing] of Object.entries(summary.missingPerLocale)) {
      if (missing > 0) console.log(`  ${locale}: ${missing} missing translations`);
    }
    if (summary.diagnostics.length) {
      console.log(`\n${summary.diagnostics.length} warning(s):`);
      for (const diagnostic of summary.diagnostics) {
        console.log(`  ${diagnostic.file}:${diagnostic.line} ${diagnostic.problem}`);
      }
    }
    const totalMissing = Object.values(summary.missingPerLocale).reduce(
      (a, b) => a + b,
      0,
    );
    if (totalMissing > 0) {
      console.log(`\nRun "glotforge translate" to fill the gaps.`);
    }
    return;
  }

  if (command === "translate") {
    await runTranslate(config, cwd, {
      locales: flags.get("locale"),
      include: flags.get("include"),
      exclude: flags.get("exclude"),
      force: booleans.has("force"),
      yes: booleans.has("yes"),
      dryRun: booleans.has("dry-run"),
      noThinking: booleans.has("no-thinking"),
      forceThinking: booleans.has("thinking"),
      effort: flags.get("effort")?.[0],
      model: flags.get("model")?.[0],
      batchSize: flags.get("batch-size")
        ? Number(flags.get("batch-size")![0])
        : undefined,
    });
    return;
  }

  if (command === "voice") {
    await runVoice(config, cwd, {
      sync: booleans.has("sync"),
      prune: booleans.has("prune"),
      locales: flags.get("locale"),
      force: booleans.has("force"),
      yes: booleans.has("yes"),
      dryRun: booleans.has("dry-run"),
    });
    return;
  }

  if (command === "status") {
    const summary = computeStatus(config, cwd);
    if (booleans.has("json")) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      printStatus(summary);
    }
    return;
  }

  console.error(`Unknown command "${command}".\n`);
  console.log(HELP);
  process.exit(2);
}

main().catch((err) => {
  console.error(`\n[glotforge] ${(err as Error).message}`);
  process.exit(1);
});
