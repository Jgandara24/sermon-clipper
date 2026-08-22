// A slider and a number field showing one value.
//
// The pair only works if both write the same value for the same intent, and if typing a number
// outside the slider's range is corrected rather than accepted or discarded. Keeping that here
// means the caption controls, and the title controls after them, cannot each invent their own
// answer to "what does 500 mean in a 100-900 field".

export type NumericRange = { min: number; max: number; step?: number };

/**
 * Rounds to the range's own step, measured from its minimum.
 *
 * A range input normalises whatever it is given to the step, so a typed value that skips the step
 * leaves the number field showing one number and the slider showing another. Chromium does this
 * silently: type 350 into a 100-900 field stepping by 100 and the slider sits at 400. Snapping
 * here means both controls are told the same number in the first place.
 */
function snapToStep(value: number, range: NumericRange): number {
  if (!range.step || range.step <= 0) return value;
  const steps = Math.round((value - range.min) / range.step);
  return range.min + steps * range.step;
}

export function clampToRange(value: number, range: NumericRange): number {
  if (!Number.isFinite(value)) return range.min;
  const snapped = snapToStep(value, range);
  return Math.min(range.max, Math.max(range.min, snapped));
}

/**
 * What a typed value means.
 *
 * An empty field is not zero — it is "no override", which is how a control returns to its preset's
 * value. Anything unparseable leaves the current value alone rather than snapping the caption to a
 * number the member never chose.
 */
export function parseNumericInput(
  raw: string,
  range: NumericRange,
  current: number | undefined,
): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return current;
  return clampToRange(parsed, range);
}

/** What both controls display: the override if there is one, otherwise the preset's value. */
export function displayedValue(override: number | undefined, presetValue: number): number {
  return override ?? presetValue;
}

/**
 * True when the two controls are showing the same thing. Used by the tests that guard the pair —
 * a slider that has drifted from its number field is the defect this module exists to prevent.
 */
export function isSynchronised(
  sliderValue: number,
  fieldValue: number | undefined,
  presetValue: number,
): boolean {
  return sliderValue === displayedValue(fieldValue, presetValue);
}
