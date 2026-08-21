// The pop curve, defined once.
//
// The browser preview evaluates it per frame; the burn-in expresses the same shape with libass
// `\t` transforms. Two definitions would drift the moment either is touched, and a caption that
// pops on screen but not in the file is the defect this module exists to prevent.
//
// Slice 7 owns the pop. Slice 8 owns the neighbour micro-shift: nothing here moves a word other
// than the active one, and nothing here reserves permanent room. Words sit at rest spacing, which
// is why an active word can overlap its neighbours slightly at large sizes until Slice 8 lands —
// the plan calls that out as a deliberate, short-lived intermediate state.

/**
 * Shape of the pop. A fast attack, a shorter settle, then a flat hold — so a long word does not
 * keep growing, and a short one still reaches its peak.
 *
 * These numbers are a starting point for the manual visual pass, not a measured result. They are
 * in one place so that pass can move them once.
 */
export const POP = {
  riseMs: 90,
  settleMs: 120,
  peakScale: 1.18,
  heldScale: 1.06,
} as const;

/** Decelerating: fast off the mark, easing into the peak. */
function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

/**
 * The scale of the active word `elapsedMs` after it became active.
 *
 * Before it is active, and for any nonsense input, the answer is 1 — rest. That matters: the
 * preview asks this every frame, including frames where nothing is active.
 */
export function popScaleAt(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 1;
  if (elapsedMs < POP.riseMs) {
    return 1 + (POP.peakScale - 1) * easeOut(elapsedMs / POP.riseMs);
  }
  if (elapsedMs < POP.riseMs + POP.settleMs) {
    const t = (elapsedMs - POP.riseMs) / POP.settleMs;
    return POP.peakScale + (POP.heldScale - POP.peakScale) * easeOut(t);
  }
  return POP.heldScale;
}

/** libass percentages, which is what `\fscx`/`\fscy` take. */
const pct = (scale: number) => Math.round(scale * 100);

/**
 * The libass tags that draw the same curve, relative to the start of the event the word is in.
 *
 * `\t`'s third parameter is an acceleration: below 1 starts fast, which is the decelerating attack
 * `easeOut` describes. The settle runs linear, which is close enough at this duration to read as
 * one motion rather than two.
 */
export function popTags(): string {
  return (
    `\\fscx100\\fscy100` +
    `\\t(0,${POP.riseMs},0.5,\\fscx${pct(POP.peakScale)}\\fscy${pct(POP.peakScale)})` +
    `\\t(${POP.riseMs},${POP.riseMs + POP.settleMs},1,\\fscx${pct(POP.heldScale)}\\fscy${pct(POP.heldScale)})`
  );
}

/** Returns the run to rest, so the words after the active one are not scaled with it. */
export function popResetTags(): string {
  return `\\fscx100\\fscy100`;
}
