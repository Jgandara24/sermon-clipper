// The pop curve, defined once and evaluated the same way by both renderers.
//
// The browser preview calls `popScaleAt` per frame; the burn-in emits `popTags`, and libass
// evaluates those tags with its own interpolation. "Both pop" is not the requirement — they have
// to draw the same number at the same millisecond, so the function below is libass's formula
// rather than something that merely resembles it.
//
// libass interpolates `\t(t1,t2,accel,...)` by raising the normalised time to `accel`:
//
//     k = ((t - t1) / (t2 - t1)) ^ accel        clamped to [0, 1]
//     value = from + (to - from) * k
//
// An `accel` below 1 leaves fast and eases in, which is the shape a pop wants. That exponent is
// why a quadratic ease-out in the preview and an `accel` in the tags are different curves however
// alike they look on paper.
//
// The pop is one transform, not a rise followed by a settle. Two `\t` over the same property
// overlap in a way renderers do not agree on — the second one's starting value is either the
// static base or whatever the first had reached, and the answer decides the whole shape. A curve
// nobody can state exactly is not a shared curve, so the settle is left for the visual pass to ask
// for deliberately, as a second event rather than a second transform.
//
// Slice 7 owns the pop. Slice 8 owns the neighbour micro-shift: nothing here moves a word other
// than the active one, and nothing here reserves permanent room.

/**
 * Shape of the pop: how long it takes, how big it gets, and how it accelerates.
 *
 * Provisional, for the manual visual pass — in one place so that pass can move them once. The
 * parity between the two renderers does not depend on the values.
 */
export const POP = {
  riseMs: 90,
  peakScale: 1.18,
  /** libass `\t` acceleration. Below 1 leaves fast and eases into the peak. */
  accel: 0.5,
} as const;

/** libass's own interpolation, clamped exactly as libass clamps it. */
function interpolate(elapsedMs: number, durationMs: number, accel: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  if (elapsedMs >= durationMs) return 1;
  return Math.pow(elapsedMs / durationMs, accel);
}

/**
 * The scale of the active word `elapsedMs` after it became active.
 *
 * Before it is active, and for any nonsense input, the answer is 1 — rest. That matters: the
 * preview asks this every frame, including frames where nothing is active.
 */
export function popScaleAt(elapsedMs: number): number {
  return 1 + (POP.peakScale - 1) * interpolate(elapsedMs, POP.riseMs, POP.accel);
}

/** libass percentages, which is what `\fscx`/`\fscy` take. */
const pct = (scale: number) => Math.round(scale * 100);

/**
 * The tags that make libass draw the same curve, relative to the start of the event the word is
 * in. The static `\fscx100\fscy100` is the transform's starting value; x and y move together so
 * the word grows without distorting.
 */
export function popTags(): string {
  const peak = pct(POP.peakScale);
  return (
    `\\fscx100\\fscy100` +
    `\\t(0,${POP.riseMs},${POP.accel},\\fscx${peak}\\fscy${peak})`
  );
}

/** Returns the run to rest, so the words after the active one are not scaled with it. */
export function popResetTags(): string {
  return `\\fscx100\\fscy100`;
}
