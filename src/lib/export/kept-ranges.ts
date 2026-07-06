export type TimeRange = { startMs: number; endMs: number };

type DeletableWord = { startMs: number; endMs: number; effectiveDeleted: boolean };

/**
 * Computes the surviving sub-ranges of [sourceStartMs, sourceEndMs] after removing every
 * effectively-deleted word span (guide §12: "deleting words splits the render into sub-ranges,
 * concat at render time"). Only the deleted words' own spans are cut — silence/pauses between
 * surviving words is kept as part of the surrounding range, matching the editor's word-skip
 * preview behavior.
 */
export function computeKeptRanges(
  words: DeletableWord[],
  sourceStartMs: number,
  sourceEndMs: number,
): TimeRange[] {
  const deletedIntervals = words
    .filter((word) => word.effectiveDeleted)
    .map((word) => ({ start: word.startMs, end: word.endMs }))
    .sort((a, b) => a.start - b.start);

  const mergedCuts: Array<{ start: number; end: number }> = [];
  for (const interval of deletedIntervals) {
    const last = mergedCuts[mergedCuts.length - 1];
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      mergedCuts.push({ ...interval });
    }
  }

  const kept: TimeRange[] = [];
  let cursor = sourceStartMs;
  for (const cut of mergedCuts) {
    const cutStart = Math.max(cut.start, sourceStartMs);
    const cutEnd = Math.min(cut.end, sourceEndMs);
    if (cutStart > cursor) {
      kept.push({ startMs: cursor, endMs: cutStart });
    }
    cursor = Math.max(cursor, cutEnd);
  }
  if (cursor < sourceEndMs) {
    kept.push({ startMs: cursor, endMs: sourceEndMs });
  }

  return kept.filter((range) => range.endMs > range.startMs);
}

/**
 * Maps a timestamp on the original source timeline to its position on the concatenated
 * (post-cut) output timeline, given the same kept ranges passed to the render. Every caption
 * word's timestamp falls within some kept range by construction (captions are built only from
 * surviving words), so this always resolves to a value inside the mapped range.
 */
export function mapToKeptTimeline(ms: number, keptRanges: TimeRange[]): number {
  let cumulative = 0;
  for (const range of keptRanges) {
    if (ms >= range.startMs && ms <= range.endMs) {
      return cumulative + (ms - range.startMs);
    }
    cumulative += range.endMs - range.startMs;
  }
  return cumulative;
}
