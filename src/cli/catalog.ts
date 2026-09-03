import fs from "fs";
import path from "path";
import type { Catalog, Manifest, ResolvedConfig } from "../shared/types";

/**
 * Catalog files live IN THE CONSUMING APP'S REPO and are committed:
 *
 *   <catalogDir>/messages.json        hash -> { message, context?, origins }
 *   <catalogDir>/catalog/<locale>.json  hash -> translated message
 *
 * Committed catalogs are the "translation cache": `translate` only fills
 * hashes missing from a locale's catalog, so nothing already translated is
 * ever paid for again, and git history doubles as the graveyard.
 */

export function manifestPath(config: ResolvedConfig, cwd: string): string {
  return path.join(cwd, config.catalogDir, "messages.json");
}

export function catalogPath(
  config: ResolvedConfig,
  cwd: string,
  locale: string,
): string {
  return path.join(cwd, config.catalogDir, "catalog", `${locale}.json`);
}

function readJson<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
}

function writeJsonSorted(file: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(data).sort()) sorted[key] = data[key];
  // LF endings and a trailing newline for clean git diffs on Windows too.
  fs.writeFileSync(file, JSON.stringify(sorted, null, 2) + "\n", "utf8");
}

export function readManifest(config: ResolvedConfig, cwd: string): Manifest {
  return readJson<Manifest>(manifestPath(config, cwd), {});
}

export function writeManifest(
  config: ResolvedConfig,
  cwd: string,
  manifest: Manifest,
): void {
  writeJsonSorted(manifestPath(config, cwd), manifest);
}

export function readCatalog(
  config: ResolvedConfig,
  cwd: string,
  locale: string,
): Catalog {
  return readJson<Catalog>(catalogPath(config, cwd, locale), {});
}

export function writeCatalog(
  config: ResolvedConfig,
  cwd: string,
  locale: string,
  catalog: Catalog,
): void {
  writeJsonSorted(catalogPath(config, cwd, locale), catalog);
}
