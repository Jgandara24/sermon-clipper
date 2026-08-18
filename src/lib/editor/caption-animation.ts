/**
 * The active-word pop curve — single source of truth for both renderers. The ASS generator
 * expresses it as two \t(...) transforms; the browser preview evaluates wordScaleAt() per
 * frame. Both reimplement libass's \t accel semantics (progress = (t/dur)^accel) so the two
 * outputs animate identically.
 */

export const POP_IN_MS = 90;
export const POP_SETTLE_MS = 130;
/** accel < 1 = ease-out (fast start), matching libass \t's accel parameter. */
export const POP_IN_ACCEL = 0.6;
export const POP_SETTLE_ACCEL = 1.4;

type TimedCaptionWord = { id: string; startMs: number; endMs: number };

/**
 * Returns one active word. If source timestamps overlap, the word that started most recently
 * wins because it is the newest spoken word at that frame.
 */
export function activeCaptionWordId(words: TimedCaptionWord[], currentMs: number): string | null {
  let active: TimedCaptionWord | null = null;
  for (const word of words) {
    if (currentMs < word.startMs || currentMs >= word.endMs) continue;
    if (!active || word.startMs >= active.startMs) active = word;
  }
  return active?.id ?? null;
}

/** End one word's active window when the next word starts, even if source intervals overlap. */
export function exclusiveCaptionWordEnds(words: TimedCaptionWord[]): Map<string, number> {
  const ordered = [...words].sort((a, b) => a.startMs - b.startMs);
  return new Map(
    ordered.map((word, index) => {
      const nextStartMs = ordered[index + 1]?.startMs;
      return [
        word.id,
        nextStartMs === undefined ? word.endMs : Math.min(word.endMs, nextStartMs),
      ];
    }),
  );
}

/** The pop overshoots its resting scale, then settles — the CapCut-style "pop". */
export function overshootScale(highlightScale: number): number {
  return 1 + (highlightScale - 1) * 1.5;
}

/** libass \t interpolation within one segment: from + (to - from) * (t/dur)^accel. */
function accelLerp(from: number, to: number, t: number, dur: number, accel: number): number {
  const p = Math.pow(Math.min(Math.max(t / dur, 0), 1), accel);
  return from + (to - from) * p;
}

/**
 * Scale of the active word `elapsedMs` after its start: 1 → overshoot over POP_IN_MS, then
 * overshoot → highlightScale over POP_SETTLE_MS, then constant. highlightScale 1 (legacy
 * presets) yields a constant 1 — no animation, one code path.
 */
export function wordScaleAt(elapsedMs: number, highlightScale: number): number {
  if (highlightScale === 1) return 1;
  const overshoot = overshootScale(highlightScale);
  if (elapsedMs <= 0) return 1;
  if (elapsedMs < POP_IN_MS) return accelLerp(1, overshoot, elapsedMs, POP_IN_MS, POP_IN_ACCEL);
  if (elapsedMs < POP_IN_MS + POP_SETTLE_MS) {
    return accelLerp(overshoot, highlightScale, elapsedMs - POP_IN_MS, POP_SETTLE_MS, POP_SETTLE_ACCEL);
  }
  return highlightScale;
}
