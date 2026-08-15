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
