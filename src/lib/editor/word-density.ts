// The Audio row's stand-in for a waveform until Slice 11 draws real peaks: how many words begin
// in each slice of the visible window. Speech is where the words are, so the shape follows the
// audio closely enough to find a pause or a run of speech by eye. Pure, so the bucketing is
// tested without a DOM and the row only draws what it is handed.

import type { TrimViewport } from "./trim";

/** The narrowest bucket worth drawing: below this a bar is thinner than a word is long. */
export const DENSITY_BUCKET_MIN_MS = 100;
/** The most bars a row draws. A wider window gets wider buckets, not more bars. */
export const DENSITY_MAX_BARS = 160;

/**
 * The bucket width for a window: at least the minimum, widened in whole minimums so the window
 * never needs more bars than the row can show.
 */
export function chooseDensityBucketMs(spanMs: number, maxBars = DENSITY_MAX_BARS): number {
  const needed = Math.ceil(spanMs / maxBars / DENSITY_BUCKET_MIN_MS) * DENSITY_BUCKET_MIN_MS;
  return Math.max(DENSITY_BUCKET_MIN_MS, needed);
}

/**
 * One bar height in 0..1 per bucket across `[view.start, view.end)`, the last bucket partial.
 *
 * Each bar is the number of words beginning in its bucket over the busiest bucket's count, so
 * the fullest bar is always full height and a silent window is all zeros. Words outside the
 * window are ignored and `wordStartsMs` need not be sorted.
 */
export function wordDensityBars(
  wordStartsMs: readonly number[],
  view: TrimViewport,
  bucketMs: number,
): number[] {
  const span = view.end - view.start;
  if (!(span > 0) || !(bucketMs > 0)) return [];

  const counts = new Array<number>(Math.ceil(span / bucketMs)).fill(0);
  for (const ms of wordStartsMs) {
    if (ms < view.start || ms >= view.end) continue;
    const index = Math.min(counts.length - 1, Math.floor((ms - view.start) / bucketMs));
    counts[index] += 1;
  }

  let peak = 0;
  for (const count of counts) peak = Math.max(peak, count);
  return peak === 0 ? counts : counts.map((count) => count / peak);
}
