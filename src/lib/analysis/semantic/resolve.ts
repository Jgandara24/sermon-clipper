import { computeIoU, looksLikeSentenceStart, type TranscriptSegmentInput } from "../chunking";
import type { ExclusionRange } from "../outline/types";
import { overlapsExclusion } from "../outline/validate";
import type { DiscoveredMoment } from "./discovery";

export type ResolvedCandidate = {
  startMs: number;
  endMs: number;
  text: string;
  segmentIndexes: number[];
  sectionPosition: number;
  momentType: DiscoveredMoment["momentType"];
  note: string;
};

// How far (in segments) the start may be nudged to land on a sentence start.
const SNAP_SEARCH_SEGMENTS = 3;
// A following silence at least this long marks a natural place to end a clip.
const PAUSE_MS = 700;
const DEDUP_IOU = 0.5;

/**
 * Deterministically turns model-nominated segment anchors into usable clip windows:
 * anchors resolve to real segments, starts snap to natural sentence boundaries, durations are
 * clamped into [minMs, maxMs] (preferring ends followed by a pause), anything overlapping an
 * exclusion range is trimmed clear or rejected (the content gate, fail-closed), and
 * near-duplicate windows collapse. The model chooses WHAT; this code alone decides WHERE the
 * cut lands.
 */
export function resolveMomentAnchors(
  moments: DiscoveredMoment[],
  segments: TranscriptSegmentInput[],
  options: { minMs: number; maxMs: number; exclusions: ExclusionRange[] },
): ResolvedCandidate[] {
  const { minMs, maxMs, exclusions } = options;
  const arrayIdxByIdx = new Map(segments.map((s, arrayIdx) => [s.idx, arrayIdx]));

  const resolved: ResolvedCandidate[] = [];
  for (const moment of moments) {
    let start = arrayIdxByIdx.get(moment.startSegmentIdx) ?? nearest(arrayIdxByIdx, moment.startSegmentIdx);
    let end = arrayIdxByIdx.get(moment.endSegmentIdx) ?? nearest(arrayIdxByIdx, moment.endSegmentIdx);
    if (start === null || end === null) continue;
    if (start > end) [start, end] = [end, start];

    start = snapToSentenceStart(segments, start, end);
    ({ start, end } = clampDuration(segments, start, end, minMs, maxMs));
    if (start === null || end === null || start > end) continue;

    const trimmed = trimClearOfExclusions(segments, start, end, minMs, exclusions);
    if (!trimmed) continue;
    ({ start, end } = trimmed);

    const duration = segments[end].endMs - segments[start].startMs;
    if (duration < minMs || duration > maxMs) continue;

    const slice = segments.slice(start, end + 1);
    resolved.push({
      startMs: slice[0].startMs,
      endMs: slice[slice.length - 1].endMs,
      text: slice.map((s) => s.text).join(" "),
      segmentIndexes: slice.map((s) => s.idx),
      sectionPosition: moment.sectionPosition,
      momentType: moment.momentType,
      note: moment.note,
    });
  }

  // Sections are processed in sermon order, so on a near-duplicate the earlier nomination wins;
  // the final post-scoring dedup still guards whatever survives.
  const deduped: ResolvedCandidate[] = [];
  for (const candidate of resolved) {
    if (!deduped.some((kept) => computeIoU(kept, candidate) > DEDUP_IOU)) {
      deduped.push(candidate);
    }
  }
  return deduped;
}

function nearest(arrayIdxByIdx: Map<number, number>, idx: number): number | null {
  // Segment idx gaps are legal; search outward a short distance for a real neighbor.
  for (let offset = 1; offset <= 10; offset += 1) {
    const before = arrayIdxByIdx.get(idx - offset);
    if (before !== undefined) return before;
    const after = arrayIdxByIdx.get(idx + offset);
    if (after !== undefined) return after;
  }
  return null;
}

function snapToSentenceStart(
  segments: TranscriptSegmentInput[],
  start: number,
  end: number,
): number {
  if (looksLikeSentenceStart(segments[start].text)) return start;
  // Prefer widening backward (keeps the nominated opening words in the clip) over narrowing.
  for (let offset = 1; offset <= SNAP_SEARCH_SEGMENTS; offset += 1) {
    const back = start - offset;
    if (back >= 0 && looksLikeSentenceStart(segments[back].text)) return back;
  }
  for (let offset = 1; offset <= SNAP_SEARCH_SEGMENTS; offset += 1) {
    const forward = start + offset;
    if (forward <= end && looksLikeSentenceStart(segments[forward].text)) return forward;
  }
  return start;
}

function gapAfter(segments: TranscriptSegmentInput[], arrayIdx: number): number {
  if (arrayIdx + 1 >= segments.length) return Infinity;
  return segments[arrayIdx + 1].startMs - segments[arrayIdx].endMs;
}

function clampDuration(
  segments: TranscriptSegmentInput[],
  start: number,
  end: number,
  minMs: number,
  maxMs: number,
): { start: number; end: number } {
  const duration = () => segments[end].endMs - segments[start].startMs;

  // Too short: extend the ending forward (finishing the thought beats starting it earlier),
  // then the start backward if the transcript ran out.
  while (duration() < minMs && end + 1 < segments.length) end += 1;
  while (duration() < minMs && start > 0) start -= 1;

  if (duration() > maxMs) {
    // Too long: among ends that keep the clip within range, prefer one followed by a real
    // pause — a breath is a far cleaner out-point than a mid-sentence segment boundary.
    const validEnds: number[] = [];
    for (let candidateEnd = start; candidateEnd <= end; candidateEnd += 1) {
      const d = segments[candidateEnd].endMs - segments[start].startMs;
      if (d > maxMs) break;
      if (d >= minMs) validEnds.push(candidateEnd);
    }
    if (validEnds.length === 0) {
      // Nothing fits from this start — walk the end back to the last segment inside maxMs.
      while (end > start && segments[end].endMs - segments[start].startMs > maxMs) end -= 1;
    } else {
      const withPause = validEnds.filter((e) => gapAfter(segments, e) >= PAUSE_MS);
      const pool = withPause.length > 0 ? withPause : validEnds;
      end = pool[pool.length - 1];
    }
  }

  return { start, end };
}

function trimClearOfExclusions(
  segments: TranscriptSegmentInput[],
  start: number,
  end: number,
  minMs: number,
  exclusions: ExclusionRange[],
): { start: number; end: number } | null {
  const startMs = () => segments[start].startMs;
  const endMs = () => segments[end].endMs;
  if (!overlapsExclusion(startMs(), endMs(), exclusions)) return { start, end };

  // Shrink from whichever side touches excluded material (e.g. a conclusion drifting into an
  // invitation gets its tail cut before the drift). Fail closed if no clean cut remains.
  while (end > start && overlapsExclusion(segments[end].startMs, endMs(), exclusions)) end -= 1;
  while (start < end && overlapsExclusion(startMs(), segments[start].endMs, exclusions)) start += 1;

  if (overlapsExclusion(startMs(), endMs(), exclusions)) return null;
  if (endMs() - startMs() < minMs) return null;
  return { start, end };
}
