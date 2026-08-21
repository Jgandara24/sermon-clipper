// Which word is highlighted, and when.
//
// One resolver, used by the browser preview and by the burn-in. That is the whole point of the
// module: a caption that highlights one word on screen and a different word in the exported file
// is worse than one that highlights neither, and two implementations of "which word is active"
// drift the moment either is touched.
//
// Source intervals overlap. Forced alignment and ASR both emit words whose spans run into each
// other, and a naive `find` over them silently picks whichever came first in the array — so two
// words can look active at the same instant depending on who is asking. The rule here is total and
// deterministic: at any timestamp there is exactly one active word, or none.

import type { CaptionLine, CaptionWord } from "./caption-lines";

/**
 * The word being spoken at `ms`, or null.
 *
 * Among the words whose interval contains the timestamp, the one that started most recently wins —
 * speech moves forward, so the latest word to begin is the one now being said. Ties are broken by
 * the shorter interval and then by the later position, which are arbitrary but fixed: what matters
 * is that the same timestamp always resolves to the same single word.
 */
export function resolveActiveWord(words: CaptionWord[], ms: number): CaptionWord | null {
  let best: CaptionWord | null = null;
  for (const word of words) {
    if (ms < word.startMs || ms >= word.endMs) continue;
    if (best === null) {
      best = word;
      continue;
    }
    if (word.startMs > best.startMs) {
      best = word;
      continue;
    }
    if (word.startMs === best.startMs && word.endMs <= best.endMs) {
      best = word;
    }
  }
  return best;
}

/** The active word's position in the line, or -1. Convenient for rendering a run of words. */
export function activeWordIndex(words: CaptionWord[], ms: number): number {
  const active = resolveActiveWord(words, ms);
  if (!active) return -1;
  return words.findIndex((word) => word.id === active.id);
}

/** A stretch of a caption line over which one word — or no word — is highlighted. */
export type HighlightSlice = {
  startMs: number;
  endMs: number;
  /** null means the line is on screen with nothing highlighted. */
  activeWordId: string | null;
};

/**
 * Cuts a caption line into the stretches over which the highlight does not change.
 *
 * The burn-in cannot ask a question at playback time the way the preview can, so it needs the
 * answer precomputed — one subtitle event per stretch. Boundaries are every word start and end in
 * the line, and each stretch is resolved at its own midpoint through the same resolver the preview
 * calls, so the two cannot disagree about any instant.
 */
export function highlightSlices(line: CaptionLine): HighlightSlice[] {
  const boundaries = new Set<number>([line.startMs, line.endMs]);
  for (const word of line.words) {
    if (word.startMs > line.startMs && word.startMs < line.endMs) boundaries.add(word.startMs);
    if (word.endMs > line.startMs && word.endMs < line.endMs) boundaries.add(word.endMs);
  }

  const edges = [...boundaries].sort((a, b) => a - b);
  const slices: HighlightSlice[] = [];
  for (let i = 0; i < edges.length - 1; i += 1) {
    const startMs = edges[i];
    const endMs = edges[i + 1];
    if (endMs <= startMs) continue;
    const active = resolveActiveWord(line.words, (startMs + endMs) / 2);
    const previous = slices[slices.length - 1];
    // Adjacent stretches with the same answer are one stretch; emitting both would put two
    // identical subtitle events back to back for no reason.
    if (previous && previous.activeWordId === (active?.id ?? null)) {
      previous.endMs = endMs;
      continue;
    }
    slices.push({ startMs, endMs, activeWordId: active?.id ?? null });
  }

  return slices;
}
