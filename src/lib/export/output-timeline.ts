// The output timeline: where a source-timeline instant lands in the rendered file.
//
// A deliverable is one unbroken span of the source — the continuity gate in
// src/lib/exports/continuous-range.ts refuses anything else — so the file's own clock is the
// source clock with the range's start subtracted. Every time in the editor document is on the
// source timeline (a word, a caption line, the title) and the burn-in draws on the file's, so
// this one function is the whole conversion. The render plan and the parity gate both read it.

export type TimeRange = { startMs: number; endMs: number };

export function rangeDurationMs(range: TimeRange): number {
  return range.endMs - range.startMs;
}

/**
 * A source-timeline instant on the output timeline, clamped to the file.
 *
 * A word that starts inside the range and runs past its end is kept by `wordsInRange`, so its
 * caption is not lost; it ends where the file ends. An instant before the range — a title timed
 * against a start the trim has since moved past — is drawn from the first frame, which is what
 * the preview does with it, rather than pushed to the end of the file and never shown.
 */
export function toOutputTimeline(ms: number, range: TimeRange): number {
  return Math.min(Math.max(ms - range.startMs, 0), rangeDurationMs(range));
}
