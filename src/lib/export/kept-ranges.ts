// The continuity gate's cut arithmetic (src/lib/exports/continuous-range.ts).
//
// The renderer no longer reads this. A deliverable is one unbroken span of the source, rendered
// in one pass (src/lib/export/render.ts). This module exists so the gate can decide, from a
// document that still carries word cuts, whether rendering it would have produced more than one
// span, or a span narrower than the clip — the two shapes the gate refuses. Refusal is decided
// against the ranges a cut would leave, not against the presence of a deleted id, so a cut that
// lies outside the clip's range refuses nothing (2026-08-20 decision, "The P1.4 Continuous-Range
// Export Gate Landed Early, With Slice 5").

import type { TimeRange } from "./output-timeline";

type DeletableWord = { startMs: number; endMs: number; effectiveDeleted: boolean };

/**
 * The sub-ranges of [sourceStartMs, sourceEndMs] that would survive removing every
 * effectively-deleted word span. Only the deleted words' own spans are cut; the silence between
 * surviving words stays with the surrounding range.
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
