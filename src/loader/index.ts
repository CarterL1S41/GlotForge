/**
 * Build-time transform: injects precomputed hashes (and canonical messages +
 * value maps) into <Trans>, <Plural>, and t-forms so the runtime does zero
 * hashing and zero serialization — a plain object lookup per render.
 *
 * Wire it up in next.config (webpack):
 *
 *   webpack(config) {
 *     config.module.rules.push({
 *       test: /\.(ts|tsx|js|jsx)$/,
 *       exclude: /node_modules/,
 *       enforce: "pre",
 *       use: ["glotforge/loader"],
 *     });
 *     return config;
 *   },
 *
 * or for Turbopack, under `turbopack.rules` with the same loader path.
 */

import { analyzeSource, mightUseI18n } from "../compiler/analyze";

interface LoaderContext {
  resourcePath: string;
  emitWarning?: (warning: Error) => void;
}

export default function glotforgeLoader(
  this: LoaderContext,
  source: string,
): string {
  if (!mightUseI18n(source)) return source;
  const { code, diagnostics } = analyzeSource(source, this.resourcePath);
  if (diagnostics.length && this.emitWarning) {
    for (const diagnostic of diagnostics) {
      this.emitWarning(
        new Error(
          `[glotforge] ${this.resourcePath}:${diagnostic.line} ${diagnostic.problem}`,
        ),
      );
    }
  }
  return code;
}

/** Standalone transform, for tests or custom build integrations. */
export function transform(
  source: string,
  filePath: string,
): { code: string; diagnostics: { line: number; problem: string }[] } {
  const { code, diagnostics } = analyzeSource(source, filePath);
  return { code, diagnostics };
}
