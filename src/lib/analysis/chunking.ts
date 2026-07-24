export type TranscriptSegmentInput = {
  idx: number;
  startMs: number;
  endMs: number;
  text: string;
};

export type CandidateWindow = {
  startMs: number;
  endMs: number;
  text: string;
  segmentIndexes: number[];
};

// Real ASR output is not reliably punctuated or capitalized (confirmed against real whisper.cpp
// output during testing — a run against a multi-minute fixture came back fully lowercase with no
// punctuation at all). Requiring both used to reject every candidate on that kind of output. So
// segment boundaries are trusted as-is (whisper/SRT segments already reflect natural speech
// pauses) and only a soft continuation-word check filters obviously mid-clause starts.
const CONTINUATION_START_WORDS = new Set([
  "and",
  "but",
  "so",
  "because",
  "or",
  "which",
  "who",
  "that",
  "then",
]);

function looksLikeSentenceStart(text: string): boolean {
  const firstWord = text.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z']/g, "");
  return !firstWord || !CONTINUATION_START_WORDS.has(firstWord);
}

// Number of window durations generated per start position, spaced evenly between minMs and
// maxMs. Whisper segments run ~2s, so emitting a window at EVERY segment end (the old behavior)
// produced ~35 near-identical windows per start — a 500-candidate cap then covered only the
// first ~40 seconds of a 50-minute sermon, and every suggested clip came from the opening.
const DURATION_TARGETS_PER_START = 3;

/**
 * Builds candidate clip windows by sliding over transcript segments, skipping starts that look
 * like a mid-clause continuation (guide §10 step 1). Segment boundaries themselves are trusted as
 * candidate endpoints — see the note above. Each start position emits at most a few windows at
 * spread-out durations, and when the pool still exceeds maxCandidates it is sampled evenly across
 * the whole transcript rather than truncated at the front — the pool must represent the entire
 * recording, not just its opening. Overlap between surviving candidates is resolved after scoring
 * (see dedupByOverlap), not here.
 */
export function buildCandidateWindows(
  segments: TranscriptSegmentInput[],
  options: { minMs?: number; maxMs?: number; maxCandidates?: number } = {},
): CandidateWindow[] {
  const minMs = options.minMs ?? 20_000;
  const maxMs = options.maxMs ?? 90_000;
  const maxCandidates = options.maxCandidates ?? 500;

  const targets = Array.from(
    { length: DURATION_TARGETS_PER_START },
    (_, i) => minMs + ((maxMs - minMs) * i) / (DURATION_TARGETS_PER_START - 1),
  );

  const candidates: CandidateWindow[] = [];

  for (let startIdx = 0; startIdx < segments.length; startIdx += 1) {
    const startSegment = segments[startIdx];
    if (!looksLikeSentenceStart(startSegment.text)) continue;

    let targetIdx = 0;
    for (let endIdx = startIdx; endIdx < segments.length && targetIdx < targets.length; endIdx += 1) {
      const duration = segments[endIdx].endMs - startSegment.startMs;
      if (duration > maxMs) break;
      if (duration < targets[targetIdx]) continue;

      candidates.push({
        startMs: startSegment.startMs,
        endMs: segments[endIdx].endMs,
        text: segments
          .slice(startIdx, endIdx + 1)
          .map((s) => s.text)
          .join(" "),
        segmentIndexes: segments.slice(startIdx, endIdx + 1).map((s) => s.idx),
      });

      // One window per segment end; a single end may satisfy several duration targets at once.
      while (targetIdx < targets.length && duration >= targets[targetIdx]) targetIdx += 1;
    }
  }

  if (candidates.length <= maxCandidates) return candidates;

  const step = candidates.length / maxCandidates;
  return Array.from({ length: maxCandidates }, (_, i) => candidates[Math.floor(i * step)]);
}

/** Pads a candidate's edges (guide §10 step 4), clamped to the source video's duration. */
export function refineBoundaries<T extends { startMs: number; endMs: number }>(
  candidate: T,
  sourceDurationMs: number,
  padMs = 150,
): T {
  return {
    ...candidate,
    startMs: Math.max(0, candidate.startMs - padMs),
    endMs: Math.min(sourceDurationMs, candidate.endMs + padMs),
  };
}

export function computeIoU(
  a: { startMs: number; endMs: number },
  b: { startMs: number; endMs: number },
): number {
  const overlapStart = Math.max(a.startMs, b.startMs);
  const overlapEnd = Math.min(a.endMs, b.endMs);
  const overlap = Math.max(0, overlapEnd - overlapStart);
  const union = a.endMs - a.startMs + (b.endMs - b.startMs) - overlap;
  return union <= 0 ? 0 : overlap / union;
}

/**
 * Greedily keeps the highest-scored candidate in each overlapping cluster (guide §10 step 5):
 * sort by score descending, reject anything whose time range overlaps an already-kept clip by
 * more than the IoU threshold.
 */
export function dedupByOverlap<T extends { startMs: number; endMs: number; score: number }>(
  candidates: T[],
  iouThreshold = 0.5,
): T[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const kept: T[] = [];

  for (const candidate of sorted) {
    const overlapsKept = kept.some((k) => computeIoU(candidate, k) > iouThreshold);
    if (!overlapsKept) {
      kept.push(candidate);
    }
  }

  return kept;
}
