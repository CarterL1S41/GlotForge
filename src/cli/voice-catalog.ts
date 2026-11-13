import fs from "fs";
import path from "path";
import type { ResolvedConfig, VoiceManifest } from "../shared/types";

/**
 * Audio catalogs live beside the text catalogs and are committed the same
 * way:
 *
 *   <catalogDir>/voice/<locale>.json   keys + hash -> clips (+ word timing)
 *   <audioDir>/<locale>/<hash>-<n>.mp3 one file per sentence
 *
 * `glotforge voice` only generates entries that are missing or stale, so
 * nothing already synthesized is paid for again. `glotforge extract` prunes
 * entries (and their files) whose message left the manifest.
 */

export function voiceManifestPath(
  config: ResolvedConfig,
  cwd: string,
  locale: string,
): string {
  return path.join(cwd, config.catalogDir, "voice", `${locale}.json`);
}

export function audioDir(config: ResolvedConfig, cwd: string): string {
  return path.join(cwd, config.voice.audioDir);
}

/** Relative clip path as stored in the manifest (forward slashes). */
export function clipFile(
  locale: string,
  hash: string,
  variant: string,
  index: number,
  format: "MP3" | "LINEAR16",
  /** A short hash of the audio, when file names carry one. */
  fingerprint?: string,
): string {
  return `${locale}/${hash}-${variant}-${index}${fingerprint ? `.${fingerprint}` : ""}.${format === "MP3" ? "mp3" : "wav"}`;
}

export function readVoiceManifest(
  config: ResolvedConfig,
  cwd: string,
  locale: string,
): VoiceManifest {
  const file = voiceManifestPath(config, cwd, locale);
  const variants = Object.keys(config.voice.voices[locale] ?? {});
  if (!fs.existsSync(file)) return { variants, keys: {}, entries: {} };
  let parsed: Partial<VoiceManifest>;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<VoiceManifest>;
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  return {
    variants: variants.length ? variants : (parsed.variants ?? []),
    keys: parsed.keys ?? {},
    entries: parsed.entries ?? {},
  };
}

export function writeVoiceManifest(
  config: ResolvedConfig,
  cwd: string,
  locale: string,
  manifest: VoiceManifest,
): void {
  const file = voiceManifestPath(config, cwd, locale);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sortedKeys: Record<string, string> = {};
  for (const key of Object.keys(manifest.keys).sort()) sortedKeys[key] = manifest.keys[key];
  const sortedEntries: VoiceManifest["entries"] = {};
  for (const hash of Object.keys(manifest.entries).sort()) {
    const variants = manifest.entries[hash];
    if (!Object.keys(variants).length) continue;
    sortedEntries[hash] = variants;
  }
  fs.writeFileSync(
    file,
    JSON.stringify(
      { variants: manifest.variants, keys: sortedKeys, entries: sortedEntries },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

/** Every clip file referenced by a manifest's entries (optionally one hash). */
export function manifestClipFiles(manifest: VoiceManifest, hash?: string): string[] {
  const files: string[] = [];
  for (const [h, variants] of Object.entries(manifest.entries)) {
    if (hash !== undefined && h !== hash) continue;
    for (const entry of Object.values(variants)) {
      for (const clip of entry.clips) files.push(clip.file);
    }
  }
  return files;
}

/** Delete every clip file of an entry; missing files are not an error. */
export function deleteClips(
  config: ResolvedConfig,
  cwd: string,
  files: string[],
): void {
  const root = audioDir(config, cwd);
  for (const file of files) {
    try {
      fs.unlinkSync(path.join(root, file));
    } catch {
      // Already gone.
    }
  }
}

export function writeClip(
  config: ResolvedConfig,
  cwd: string,
  file: string,
  bytes: Buffer,
): void {
  const full = path.join(audioDir(config, cwd), file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, bytes);
}

/** Every locale that gets audio: configured voices, source locale included. */
export function voicedLocales(config: ResolvedConfig): string[] {
  return [config.sourceLocale, ...config.locales].filter(
    (locale) => Object.keys(config.voice.voices[locale] ?? {}).length > 0,
  );
}

/** Every locale that has (or may have) a voice manifest on disk. */
export function voiceManifestLocales(config: ResolvedConfig, cwd: string): string[] {
  const dir = path.join(cwd, config.catalogDir, "voice");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length));
}
