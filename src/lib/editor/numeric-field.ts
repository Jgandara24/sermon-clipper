// A slider and a number field showing one value.
//
// The pair only works if both write the same value for the same intent, and if typing a number
// outside the slider's range is corrected rather than accepted or discarded. Keeping that here
// means the caption controls, and the title controls after them, cannot each invent their own
// answer to "what does 500 mean in a 100-900 field".

export type NumericRange = { min: number; max: number; step?: number };

export function clampToRange(value: number, range: NumericRange): number {
  if (!Number.isFinite(value)) return range.min;
  return Math.min(range.max, Math.max(range.min, value));
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
