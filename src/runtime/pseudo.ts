/**
 * Pseudo-locale: English rendered with accented glyphs and ~40% extra width,
 * so layout breakage from text expansion (German runs ~35% longer) shows up
 * in development without waiting for real translations. Select it from the
 * devtools locale switcher; it never ships in the locale config.
 */

export const PSEUDO_LOCALE = "pseudo";

const GLYPHS: Record<string, string> = {
  a: "á", b: "ƀ", c: "ç", d: "ð", e: "é", f: "ƒ", g: "ĝ", h: "ĥ",
  i: "î", j: "ĵ", k: "ķ", l: "ĺ", m: "ɱ", n: "ñ", o: "ö", p: "þ",
  q: "ǫ", r: "ŕ", s: "š", t: "ţ", u: "û", v: "ṽ", w: "ŵ", x: "ẋ",
  y: "ý", z: "ž",
  A: "Å", B: "Ɓ", C: "Ç", D: "Ð", E: "É", F: "Ƒ", G: "Ĝ", H: "Ĥ",
  I: "Î", J: "Ĵ", K: "Ķ", L: "Ĺ", M: "M", N: "Ñ", O: "Ö", P: "Þ",
  Q: "Q", R: "Ŕ", S: "Š", T: "Ţ", U: "Û", V: "V", W: "Ŵ", X: "X",
  Y: "Ý", Z: "Ž",
};

/** Pseudoize one text segment (placeholders/tags are handled by the renderer). */
export function pseudoize(text: string): string {
  let mapped = "";
  for (const ch of text) {
    mapped += GLYPHS[ch] ?? ch;
  }
  const letters = text.replace(/[^a-zA-Z]/g, "").length;
  const padding = Math.round(letters * 0.4);
  return padding > 0 ? mapped + "·".repeat(padding) : mapped;
}
