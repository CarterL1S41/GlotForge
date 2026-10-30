import fs from "fs";
import path from "path";
import { analyzeSource } from "../compiler/analyze";
import { globToRegExp, matchesAny } from "../shared/glob";
import type { Manifest, MessageEntry, ResolvedConfig } from "../shared/types";
import {
  readCatalog,
  readManifest,
  writeCatalog,
  writeManifest,
} from "./catalog";
import {
  deleteClips,
  readVoiceManifest,
  voiceManifestLocales,
  writeVoiceManifest,
} from "./voice-catalog";

export interface ExtractOptions {
  /** CLI --include: scan only these globs (a SCOPED run). */
  include?: string[];
  /** CLI --exclude: additionally skip these globs. */
  exclude?: string[];
}

export interface ExtractSummary {
  filesScanned: number;
  totalMessages: number;
  added: string[];
  removed: string[];
  diagnostics: { file: string; line: number; problem: string }[];
  missingPerLocale: Record<string, number>;
  scoped: boolean;
}

const ALWAYS_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "out",
  "coverage",
]);

function walkFiles(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ALWAYS_SKIP_DIRS.has(entry.name)) visit(full);
      } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        found.push(path.relative(root, full).replace(/\\/g, "/"));
      }
    }
  };
  visit(root);
  return found;
}

/**
 * Scan the source tree, canonicalize + hash every message, and reconcile
 * the committed manifest and per-locale catalogs against what the code
 * actually contains. The active set is rebuilt from source on every run —
 * a pure function of the code, no incremental bookkeeping to corrupt.
 *
 * A SCOPED run (CLI --include/--exclude) only reconciles within its scope:
 * it never prunes an entry that has any origin in a file it didn't scan.
 */
export function runExtract(
  config: ResolvedConfig,
  cwd: string,
  options: ExtractOptions = {},
): ExtractSummary {
  const includeGlobs = options.include?.length ? options.include : config.include;
  const excludeGlobs = [...config.exclude, ...(options.exclude ?? [])];
  const scoped = Boolean(options.include?.length || options.exclude?.length);

  const includeRes = includeGlobs.map(globToRegExp);
  const excludeRes = excludeGlobs.map(globToRegExp);

  const files = walkFiles(cwd).filter(
    (file) => matchesAny(file, includeRes) && !matchesAny(file, excludeRes),
  );
  const scannedSet = new Set(files);

  const extracted: Manifest = {};
  const diagnostics: ExtractSummary["diagnostics"] = [];

  for (const file of files) {
    const source = fs.readFileSync(path.join(cwd, file), "utf8");
    const result = analyzeSource(source, file);
    for (const diagnostic of result.diagnostics) {
      diagnostics.push({ file, line: diagnostic.line, problem: diagnostic.problem });
    }
    for (const found of result.messages) {
      const origin = `${file}:${found.line}`;
      const existing = extracted[found.hash];
      if (existing) {
        if (existing.message !== found.message) {
          throw new Error(
            `hash collision: "${existing.message}" and "${found.message}" both hash to ${found.hash} — add a context to one of them`,
          );
        }
        if (!existing.origins.includes(origin)) existing.origins.push(origin);
        // A keyed voice marker wins over a bare one; two different keys on
        // the same message is a mistake worth stopping on.
        if (found.voice !== undefined) {
          if (
            typeof existing.voice === "string" &&
            typeof found.voice === "string" &&
            existing.voice !== found.voice
          ) {
            throw new Error(
              `"${found.message}" carries two voice keys ("${existing.voice}" and "${found.voice}") — a message has one key`,
            );
          }
          if (typeof found.voice === "string" || existing.voice === undefined) {
            existing.voice = found.voice;
          }
        }
      } else {
        const entry: MessageEntry = {
          message: found.message,
          origins: [origin],
        };
        if (found.context) entry.context = found.context;
        if (found.voice !== undefined) entry.voice = found.voice;
        extracted[found.hash] = entry;
      }
    }
  }

  // Voice keys are how the app addresses audio, so they must be unique.
  const keyOwners = new Map<string, string>();
  for (const [hash, entry] of Object.entries(extracted)) {
    if (typeof entry.voice !== "string") continue;
    const owner = keyOwners.get(entry.voice);
    if (owner && owner !== hash) {
      throw new Error(
        `voice key "${entry.voice}" is used by two different messages ("${extracted[owner].message}" and "${entry.message}") — keys must be unique`,
      );
    }
    keyOwners.set(entry.voice, hash);
  }

  const previous = readManifest(config, cwd);
  let next: Manifest;

  if (!scoped) {
    next = extracted;
  } else {
    // Keep everything, then overlay the scoped scan: replace in-scope
    // origins, and drop an entry only when ALL its origins were in scope
    // and the scan no longer found it.
    next = {};
    const originInScope = (origin: string) =>
      scannedSet.has(origin.slice(0, origin.lastIndexOf(":")));
    for (const [hash, entry] of Object.entries(previous)) {
      const outOfScope = entry.origins.filter((o) => !originInScope(o));
      const rescanned = extracted[hash];
      if (rescanned) {
        const merged = [...new Set([...outOfScope, ...rescanned.origins])];
        next[hash] = { ...rescanned, origins: merged };
      } else if (outOfScope.length > 0) {
        next[hash] = { ...entry, origins: outOfScope };
      }
      // else: every origin was in scope and it's gone — pruned.
    }
    for (const [hash, entry] of Object.entries(extracted)) {
      if (!next[hash]) next[hash] = entry;
    }
  }

  const added = Object.keys(next).filter((hash) => !previous[hash]);
  const removed = Object.keys(previous).filter((hash) => !next[hash]);

  writeManifest(config, cwd, next);

  // Prune orphaned hashes from every locale catalog. No graveyard — git
  // history keeps every removed translation, and retranslation is cheap.
  const missingPerLocale: Record<string, number> = {};
  for (const locale of config.locales) {
    const catalog = readCatalog(config, cwd, locale);
    let changed = false;
    for (const hash of Object.keys(catalog)) {
      if (!next[hash]) {
        delete catalog[hash];
        changed = true;
      }
    }
    if (changed || !fs.existsSync(path.join(cwd, config.catalogDir))) {
      writeCatalog(config, cwd, locale, catalog);
    }
    missingPerLocale[locale] = Object.keys(next).filter(
      (hash) => !catalog[hash],
    ).length;
  }

  // Audio catalogs: drop entries (and their clip files) whose message is
  // gone or no longer voiced, and keep the key map in step with the code.
  for (const locale of voiceManifestLocales(config, cwd)) {
    const voiceManifest = readVoiceManifest(config, cwd, locale);
    let changed = false;
    for (const [hash, byVariant] of Object.entries(voiceManifest.entries)) {
      if (!next[hash] || next[hash].voice === undefined) {
        for (const entry of Object.values(byVariant)) {
          deleteClips(config, cwd, entry.clips.map((clip) => clip.file));
        }
        delete voiceManifest.entries[hash];
        changed = true;
      }
    }
    const keys: Record<string, string> = {};
    for (const [hash, entry] of Object.entries(next)) {
      if (typeof entry.voice === "string") keys[entry.voice] = hash;
    }
    if (JSON.stringify(keys) !== JSON.stringify(voiceManifest.keys)) {
      voiceManifest.keys = keys;
      changed = true;
    }
    if (changed) writeVoiceManifest(config, cwd, locale, voiceManifest);
  }

  return {
    filesScanned: files.length,
    totalMessages: Object.keys(next).length,
    added,
    removed,
    diagnostics,
    missingPerLocale,
    scoped,
  };
}
