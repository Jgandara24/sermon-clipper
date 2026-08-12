/**
 * Pure metrics over one ANALYZE run.
 *
 * Two facts about the current pipeline cannot be charter-tested in CI, because they are properties
 * of the paid Claude provider rather than of the code: how much of the candidate pool survives
 * Stage A classification, and where in the service the surviving clips come from. They were
 * measured in production instead (see `evaluation/funnel-baseline-2026-08-12.json`).
 *
 * This module turns those measurements into computed values so the baseline is executable rather
 * than anecdotal, and so P5 has an instrument to prove improvement with rather than a new argument.
 * It reads only counts and timestamps — never media, never transcript text.
 */

export type FunnelRun = {
  /** Windows built from the transcript and offered to Stage A. */
  candidateCount: number;
  /** Candidates that survived Stage A and were scored by Stage B. */
  scoredCount: number;
  /** Candidates persisted as clips. */
  keptCount: number;
  sourceDurationMs: number;
  clips: { startMs: number; endMs: number }[];
};

export type FunnelMetrics = {
  /** Share of offered candidates that reach scoring. The current pipeline's binding constraint. */
  stageAPassRatio: number;
  /** Share of scored candidates that are kept. */
  keptRatio: number;
  /** Where the first and last kept clip begin, as a fraction of the service. */
  earliestStartFraction: number;
  latestStartFraction: number;
  /** Distance between them. 0 means every clip starts at the same moment. */
  coverageSpanFraction: number;
};

function fractionOf(ms: number, durationMs: number): number {
  return durationMs > 0 ? ms / durationMs : 0;
}

export function computeFunnelMetrics(run: FunnelRun): FunnelMetrics {
  const starts = run.clips.map((c) => fractionOf(c.startMs, run.sourceDurationMs));
  const earliest = starts.length > 0 ? Math.min(...starts) : 0;
  const latest = starts.length > 0 ? Math.max(...starts) : 0;

  return {
    stageAPassRatio: run.candidateCount > 0 ? run.scoredCount / run.candidateCount : 0,
    keptRatio: run.scoredCount > 0 ? run.keptCount / run.scoredCount : 0,
    earliestStartFraction: earliest,
    latestStartFraction: latest,
    coverageSpanFraction: latest - earliest,
  };
}

/**
 * How many kept clips begin within the leading `fraction` of the service.
 *
 * The current pipeline puts all of them in the opening fifth. P5's job is to lower this number for
 * a fixed fraction — that is the improvement, stated as something measurable.
 */
export function clipsWithinLeadingFraction(run: FunnelRun, fraction: number): number {
  if (fraction <= 0 || fraction > 1) throw new RangeError("fraction must be within (0, 1]");
  const cutoffMs = run.sourceDurationMs * fraction;
  return run.clips.filter((clip) => clip.startMs < cutoffMs).length;
}

/** True when every kept clip begins inside the leading `fraction`. The condition P5 must break. */
export function isFrontLoaded(run: FunnelRun, fraction: number): boolean {
  return run.clips.length > 0 && clipsWithinLeadingFraction(run, fraction) === run.clips.length;
}
