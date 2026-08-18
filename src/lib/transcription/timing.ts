/**
 * Distributes a time span across tokens by visual weight, so interpolated word timing reads
 * naturally instead of jerking through equal slices. Longer words get proportionally more
 * time; sentence-ending punctuation earns a pause. Shared by SRT interpolation and caption
 * text-override re-timing — both need "plausible spoken pacing" from text alone.
 */

// A single word holding the highlight much longer than real speech looks like a stall, so
// cap it and hand the excess to the neighbours.
const MAX_WORD_MS = 1200;

function tokenWeight(token: string): number {
  // Minimum 2 keeps one-letter words ("a", "I") visible; punctuation bonuses approximate the
  // pause a reader/speaker makes after clause and sentence ends.
  let weight = Math.max(2, token.length);
  if (/[.!?]["')\]]?$/.test(token)) weight += 4;
  else if (/,["')\]]?$/.test(token)) weight += 2;
  return weight;
}

export type TimedToken = { token: string; startMs: number; endMs: number };

/**
 * Allocates [startMs, endMs] contiguously across tokens: no gaps, no overlap, and the last
 * token ends exactly at endMs. Returns [] for an empty token list.
 */
export function distributeDurationByWeight(
  tokens: string[],
  startMs: number,
  endMs: number,
): TimedToken[] {
  if (tokens.length === 0) return [];

  const duration = Math.max(endMs - startMs, tokens.length);
  const weights = tokens.map(tokenWeight);

  // Proportional allocation with a per-word cap, water-filling style: capped words take
  // MAX_WORD_MS, the freed surplus redistributes over uncapped words by weight, repeating
  // until stable (at most tokens.length rounds). If the span is so long that every word hits
  // the cap, the remainder spreads proportionally over all words — this keeps heavier words
  // always at least as long as lighter ones, so ordering never inverts.
  let durations = allocate(weights, duration);
  for (let round = 0; round < tokens.length; round += 1) {
    if (!durations.some((ms) => ms > MAX_WORD_MS)) break;
    const capped = durations.map((ms) => ms >= MAX_WORD_MS);
    const surplus = durations.reduce((sum, ms) => sum + Math.max(0, ms - MAX_WORD_MS), 0);
    durations = durations.map((ms) => Math.min(ms, MAX_WORD_MS));
    const freeWeights = weights.map((w, i) => (capped[i] ? 0 : w));
    const receivers = freeWeights.some((w) => w > 0) ? freeWeights : weights;
    const extra = allocate(receivers, surplus);
    durations = durations.map((ms, i) => ms + extra[i]);
    if (receivers === weights) break; // everyone capped: proportional remainder, done
  }

  // Walk the spans contiguously; rounding drift lands on the last token, which is then
  // clamped so the sequence covers the range exactly.
  const result: TimedToken[] = [];
  let cursor = startMs;
  for (let i = 0; i < tokens.length; i += 1) {
    const isLast = i === tokens.length - 1;
    const end = isLast ? endMs : Math.min(endMs, Math.round(cursor + durations[i]));
    result.push({ token: tokens[i], startMs: Math.round(cursor), endMs: end });
    cursor = end;
  }
  return result;
}

/** Splits totalMs across weights proportionally (unrounded; callers round at the walk). */
function allocate(weights: number[], totalMs: number): number[] {
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (totalWeight === 0) return weights.map(() => 0);
  return weights.map((w) => (w / totalWeight) * totalMs);
}
