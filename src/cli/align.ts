/**
 * Place the known words of a sentence onto the words Speech-to-Text heard.
 * The transcript is known, so this is alignment, not recognition: a
 * misheard word still takes its slot's timing, and a word the recogniser
 * dropped is interpolated between its placed neighbours and flagged.
 */

import { normalizeWord, type WordSpan } from "../shared/speech";
import type { VoiceWord } from "../shared/types";
import type { RecognizedWord } from "./google";

/** Standard edit-distance alignment over normalized tokens. */
function alignTokens(
  target: string[],
  heard: string[],
): (number | null)[] {
  const n = target.length;
  const m = heard.length;
  // dp[i][j] = cost aligning target[0..i) with heard[0..j)
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) dp[i][0] = i;
  for (let j = 1; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const same = target[i - 1] === heard[j - 1];
      const sub = dp[i - 1][j - 1] + (same ? 0 : similar(target[i - 1], heard[j - 1]) ? 0.5 : 1);
      dp[i][j] = Math.min(sub, dp[i - 1][j] + 1, dp[i][j - 1] + 1);
    }
  }
  const mapping: (number | null)[] = new Array(n).fill(null);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const same = target[i - 1] === heard[j - 1];
    const subCost = same ? 0 : similar(target[i - 1], heard[j - 1]) ? 0.5 : 1;
    if (dp[i][j] === dp[i - 1][j - 1] + subCost) {
      // A substitution of two unrelated tokens still shares a slot — the
      // recogniser heard *something* where this word was spoken.
      mapping[i - 1] = j - 1;
      i--;
      j--;
    } else if (dp[i][j] === dp[i - 1][j] + 1) {
      i--;
    } else {
      j--;
    }
  }
  return mapping;
}

/** Cheap similarity for homophone-ish mishearings: shared prefix or edit distance 1. */
function similar(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a.startsWith(b) || b.startsWith(a)) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let edits = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** How far past the measured end of a clip a word may be reported and still be believed. */
const END_TOLERANCE_MS = 250;

/**
 * Timing for every target word. Returns null when too little was heard to
 * anchor anything (the clip then keeps sentence-level timing).
 */
export function alignWords(
  words: WordSpan[],
  heard: RecognizedWord[],
  durationMs: number,
): VoiceWord[] | null {
  if (!words.length) return [];
  if (!heard.length) return null;
  const mapping = alignTokens(
    words.map((w) => normalizeWord(w.text)),
    heard.map((h) => normalizeWord(h.text)),
  );
  // The recogniser now and then reports an offset far past the end of the
  // clip. A start out there places nothing; an end out there leaves the
  // word's start standing and its end to be worked out below.
  const openEnded = new Set<number>();
  const out: (VoiceWord | null)[] = words.map((word, index) => {
    const slot = mapping[index];
    if (slot === null) return null;
    const { startMs, endMs } = heard[slot];
    if (startMs > durationMs) return null;
    if (endMs > durationMs + END_TOLERANCE_MS || endMs < startMs) {
      openEnded.add(index);
      return { text: word.text, startMs, endMs: startMs, estimated: true };
    }
    return { text: word.text, startMs, endMs };
  });
  if (!out.some((word) => word !== null)) return null;

  // Interpolate the unplaced words evenly across the gap between their
  // nearest placed neighbours (or the clip edges).
  let index = 0;
  while (index < out.length) {
    if (out[index]) {
      index++;
      continue;
    }
    let end = index;
    while (end < out.length && !out[end]) end++;
    const gapEnd = end === out.length ? durationMs : out[end]!.startMs;
    const count = end - index;
    // A word before the gap whose end is unknown shares the gap with the
    // unplaced words, starting from where it was heard to begin.
    const sharing = index > 0 && openEnded.has(index - 1);
    const gapStart = index === 0 ? 0 : sharing ? out[index - 1]!.startMs : out[index - 1]!.endMs;
    const shares = count + (sharing ? 1 : 0);
    const span = Math.max(gapEnd - gapStart, 0);
    if (sharing) {
      out[index - 1]!.endMs = Math.round(gapStart + span / shares);
      openEnded.delete(index - 1);
    }
    for (let k = 0; k < count; k++) {
      const share = k + (sharing ? 1 : 0);
      const startMs = Math.round(gapStart + (span * share) / shares);
      const endMs = Math.round(gapStart + (span * (share + 1)) / shares);
      out[index + k] = { text: words[index + k].text, startMs, endMs, estimated: true };
    }
    index = end;
  }

  // A word with an unknown end that a placed word follows ends where that
  // one starts; the last word of the clip ends with the clip.
  for (const at of openEnded) {
    const following = out[at + 1];
    out[at]!.endMs = Math.max(out[at]!.startMs, following ? following.startMs : durationMs);
  }

  // Keep the sequence monotonic: a placed word can never start before the
  // previous one ends (the recogniser occasionally overlaps tokens).
  const result = out as VoiceWord[];
  for (let k = 1; k < result.length; k++) {
    if (result[k].startMs < result[k - 1].endMs) result[k].startMs = result[k - 1].endMs;
    if (result[k].endMs < result[k].startMs) result[k].endMs = result[k].startMs;
  }
  return result;
}

/** Word timing from SSML mark timepoints (seconds, one mark before each word plus a closing mark). */
export function wordsFromMarks(
  words: WordSpan[],
  timepoints: Map<number, number>,
  durationMs: number,
): VoiceWord[] | null {
  if (!words.length) return [];
  const starts: (number | null)[] = words.map((_, i) => {
    const t = timepoints.get(i);
    return t === undefined ? null : Math.round(t * 1000);
  });
  if (starts.every((s) => s === null)) return null;
  const closingMark = timepoints.get(words.length);
  const closing = closingMark === undefined ? durationMs : Math.round(closingMark * 1000);

  // Fill missing marks by spreading them evenly between known neighbours.
  const estimated = starts.map((s) => s === null);
  let index = 0;
  while (index < starts.length) {
    if (starts[index] !== null) {
      index++;
      continue;
    }
    let end = index;
    while (end < starts.length && starts[end] === null) end++;
    const gapStart = index === 0 ? 0 : starts[index - 1]!;
    const gapEnd = end === starts.length ? closing : starts[end]!;
    const count = end - index;
    for (let k = 0; k < count; k++) {
      starts[index + k] = Math.round(gapStart + ((gapEnd - gapStart) * (k + 1)) / (count + 1));
    }
    index = end;
  }

  const result: VoiceWord[] = [];
  for (let i = 0; i < words.length; i++) {
    const startMs = starts[i]!;
    const endMs = Math.max(i + 1 < words.length ? starts[i + 1]! : closing, startMs);
    const word: VoiceWord = { text: words[i].text, startMs, endMs };
    if (estimated[i]) word.estimated = true;
    result.push(word);
  }
  return result;
}
