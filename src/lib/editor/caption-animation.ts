// The pop curve, defined once and evaluated the same way by both renderers.
//
// Two things make that harder than it sounds.
//
// **The clock.** Word intervals nest: "alpha" can run 0–1000ms with "beta" inside it at 200–400ms,
// so alpha is active, then beta, then alpha again. Timed from alpha's own start, that second
// activation is already 400ms old; timed from the event that draws it, it has just begun. The
// activation is the clock — both renderers measure from the start of the stretch over which the
// highlight does not change, which is exactly a `HighlightSlice`.
//
// **The transform.** libass interpolates `\t(t1,t2,accel,...)` by raising normalised time to
// `accel`, and two `\t` over the same property overlap in a way renderers do not agree on. So the
// curve is expressed as a sequence of phases, one Dialogue event each, each carrying a single
// transform from a known starting value. The preview evaluates the same phases directly.
//
// Slice 7 owns the pop. Slice 8 owns the neighbour micro-shift: nothing here moves a word other
// than the active one, and nothing here reserves permanent room.

/**
 * Shape of the pop. Provisional, for the manual visual pass — in one place so that pass can move
 * them once. Parity between the renderers does not depend on the values.
 */
export const POP = {
  riseMs: 90,
  settleMs: 120,
  returnMs: 90,
  peakScale: 1.18,
  heldScale: 1.06,
  /** libass `\t` acceleration, an exponent. Below 1 leaves fast and eases in. */
  riseAccel: 0.5,
  settleAccel: 1,
  returnAccel: 1,
} as const;

export type PopPhase = {
  /** Milliseconds since the activation began. */
  startMs: number;
  endMs: number;
  fromScale: number;
  toScale: number;
  /** The exponent libass applies. Irrelevant when `fromScale === toScale`. */
  accel: number;
};

/**
 * The phases of one activation, in order and covering it end to end.
 *
 * A short activation cannot fit every phase, and the one that must never be dropped is the return:
 * a word cut off at full size leaves the caption jumping. So the return is reserved first, out of
 * whatever the activation has, and the rise and settle take what is left.
 */
export function popPhases(activeDurationMs: number): PopPhase[] {
  const duration = Number.isFinite(activeDurationMs) ? Math.max(0, activeDurationMs) : 0;
  if (duration <= 0) return [];

  const returnMs = Math.min(POP.returnMs, duration);
  const beforeReturn = duration - returnMs;
  const riseMs = Math.min(POP.riseMs, beforeReturn);
  const settleMs = Math.min(POP.settleMs, beforeReturn - riseMs);

  // Where the return begins from depends on how much of the curve had room to happen.
  const afterRise = riseMs === POP.riseMs ? POP.peakScale : scaleAfterPartial(1, POP.peakScale, riseMs, POP.riseMs, POP.riseAccel);
  const afterSettle =
    settleMs <= 0
      ? afterRise
      : scaleAfterPartial(afterRise, POP.heldScale, settleMs, POP.settleMs, POP.settleAccel);

  const phases: PopPhase[] = [];
  if (riseMs > 0) {
    phases.push({ startMs: 0, endMs: riseMs, fromScale: 1, toScale: afterRise, accel: POP.riseAccel });
  }
  if (settleMs > 0) {
    phases.push({
      startMs: riseMs,
      endMs: riseMs + settleMs,
      fromScale: afterRise,
      toScale: afterSettle,
      accel: POP.settleAccel,
    });
  }
  const holdStart = riseMs + settleMs;
  const returnStart = beforeReturn;
  if (returnStart > holdStart) {
    phases.push({
      startMs: holdStart,
      endMs: returnStart,
      fromScale: afterSettle,
      toScale: afterSettle,
      accel: 1,
    });
  }
  phases.push({
    startMs: returnStart,
    endMs: duration,
    fromScale: afterSettle,
    toScale: 1,
    accel: POP.returnAccel,
  });

  return phases;
}

/** Where a phase reaches when it only gets part of its time. */
function scaleAfterPartial(
  from: number,
  to: number,
  granted: number,
  full: number,
  accel: number,
): number {
  if (granted <= 0) return from;
  if (granted >= full) return to;
  return from + (to - from) * Math.pow(granted / full, accel);
}

/**
 * The scale of the active word `elapsedMs` into an activation lasting `activeDurationMs`.
 *
 * Before it begins, and for any nonsense input, the answer is 1 — rest. That matters: the preview
 * asks this every frame, including frames where nothing is active.
 */
export function popScaleAt(elapsedMs: number, activeDurationMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 1;
  const phases = popPhases(activeDurationMs);
  if (phases.length === 0) return 1;
  if (elapsedMs >= phases[phases.length - 1].endMs) return 1;

  const phase = phases.find((p) => elapsedMs >= p.startMs && elapsedMs < p.endMs);
  if (!phase) return 1;
  if (phase.fromScale === phase.toScale) return phase.fromScale;

  const span = phase.endMs - phase.startMs;
  if (span <= 0) return phase.toScale;
  const t = (elapsedMs - phase.startMs) / span;
  return phase.fromScale + (phase.toScale - phase.fromScale) * Math.pow(t, phase.accel);
}

/** libass percentages, which is what `\fscx`/`\fscy` take. */
const pct = (scale: number) => Math.round(scale * 100);

/**
 * The tags that make libass draw one phase, relative to the start of the event drawing it. The
 * static `\fscx`/`\fscy` is the transform's starting value; x and y move together so the word
 * grows without distorting.
 */
export function popPhaseTags(phase: PopPhase): string {
  const from = pct(phase.fromScale);
  const base = `\\fscx${from}\\fscy${from}`;
  if (phase.fromScale === phase.toScale) return base;
  const to = pct(phase.toScale);
  const span = Math.max(1, Math.round(phase.endMs - phase.startMs));
  return `${base}\\t(0,${span},${phase.accel},\\fscx${to}\\fscy${to})`;
}

/** Returns the run to rest, so the words after the active one are not scaled with it. */
export function popResetTags(): string {
  return `\\fscx100\\fscy100`;
}
