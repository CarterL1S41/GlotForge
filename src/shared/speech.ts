/**
 * Text rules shared by the voice command (which decides what to synthesize
 * and what the aligner must place) and the runtime (which wraps rendered
 * text in word spans for highlighting). Both sides must tokenize the same
 * way or word N in the catalog is not word N on screen.
 */

import type { MessageNode } from "./message";

/**
 * A message can be spoken only when it is fixed text: no arguments, no
 * plural/select. Tags are fine — their words are spoken in place.
 */
export function unspeakableReason(nodes: MessageNode[]): string | null {
  for (const node of nodes) {
    if (node.type === "arg") return `placeholder {${node.name}}`;
    if (node.type === "plural" || node.type === "select") {
      return `${node.type} argument {${node.name}}`;
    }
    if (node.type === "tag") {
      const inner = unspeakableReason(node.children);
      if (inner) return inner;
    }
  }
  return null;
}

/** The spoken text of a static message: tags flattened, escapes resolved. */
export function plainTextOf(nodes: MessageNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") out += node.value;
    else if (node.type === "tag") out += plainTextOf(node.children);
  }
  return out;
}

type SegmenterCtor = new (
  locale: string,
  options: { granularity: "sentence" | "word" },
) => {
  segment(text: string): Iterable<{ segment: string; isWordLike?: boolean }>;
};

function segmenter(
  locale: string,
  granularity: "sentence" | "word",
): InstanceType<SegmenterCtor> | null {
  const ctor = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
  if (!ctor) return null;
  try {
    return new ctor(locale, { granularity });
  } catch {
    try {
      return new ctor("und", { granularity });
    } catch {
      return null;
    }
  }
}

/**
 * Split spoken text into sentences, locale-aware (Japanese 。, Thai spacing,
 * abbreviations where ICU knows them). Each sentence becomes one clip.
 */
export function splitSentences(text: string, locale: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const seg = segmenter(locale, "sentence");
  const parts: string[] = [];
  if (seg) {
    for (const { segment } of seg.segment(normalized)) {
      const sentence = segment.trim();
      if (sentence) parts.push(sentence);
    }
  } else {
    for (const piece of normalized.split(/(?<=[.!?。！？])\s+/)) {
      const sentence = piece.trim();
      if (sentence) parts.push(sentence);
    }
  }
  return parts;
}

export interface WordSpan {
  /** The word as written, punctuation attached ("training."). */
  text: string;
  /** Character offset of the word in the text it was split from. */
  start: number;
  end: number;
}

/**
 * Split text into spoken words with their character offsets. Whitespace is
 * the separator for scripts that use it; for scripts that do not (Chinese,
 * Japanese, Thai) ICU word segmentation decides. Punctuation stays glued to
 * the word it follows, so the span under a highlight reads naturally.
 */
export function splitWords(text: string, locale: string): WordSpan[] {
  const words: WordSpan[] = [];
  if (!text) return words;
  if (!needsSegmenter(text)) {
    const re = /\S+/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      words.push({ text: match[0], start: match.index, end: match.index + match[0].length });
    }
    return words;
  }
  const seg = segmenter(locale, "word");
  if (!seg) {
    words.push({ text, start: 0, end: text.length });
    return words;
  }
  let offset = 0;
  for (const { segment, isWordLike } of seg.segment(text)) {
    const start = offset;
    offset += segment.length;
    if (isWordLike) {
      words.push({ text: segment, start, end: offset });
    } else if (words.length && segment.trim()) {
      // Trailing punctuation glues to the previous word.
      const last = words[words.length - 1];
      if (last.end === start) {
        last.text += segment;
        last.end = offset;
      }
    }
  }
  return words;
}

/** True when the text contains characters from a script written without spaces. */
function needsSegmenter(text: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u.test(
    text,
  );
}

/** Lowercase, strip punctuation and diacritics — the aligner's match key. */
export function normalizeWord(word: string): string {
  return word
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}
