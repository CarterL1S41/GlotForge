/**
 * Content hashing for message IDs.
 *
 * The hash IS the catalog key: identical English (plus optional context)
 * always produces the same ID, wherever it appears in the app, so repeated
 * strings dedupe to a single catalog entry. The same function runs in the
 * extractor, the build-time loader, and the runtime fallback — all three
 * MUST agree, so never change this without a full re-extract.
 *
 * cyrb53a: a fast, well-mixed 53-bit string hash (fits in a JS number, no
 * BigInt, no crypto dependency — works in browser and Node). Rendered in
 * base36 for compact, diff-friendly keys (~11 chars).
 */

function cyrb53a(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x85ebca77);
    h2 = Math.imul(h2 ^ ch, 0xc2b2ae3d);
  }
  h1 ^= Math.imul(h1 ^ (h2 >>> 15), 0x735a2d97);
  h2 ^= Math.imul(h2 ^ (h1 >>> 15), 0xcaf649a9);
  h1 ^= h2 >>> 16;
  h2 ^= h1 >>> 16;
  return 2097152 * (h2 >>> 0) + (h1 >>> 11);
}

/**
 * Compute the catalog ID for a canonical message + optional context.
 * Context participates in the hash, so the same English with different
 * contexts yields distinct catalog entries.
 */
export function hashMessage(message: string, context?: string): string {
  const input = context ? message + "\x1f" + context : message;
  return cyrb53a(input).toString(36);
}
