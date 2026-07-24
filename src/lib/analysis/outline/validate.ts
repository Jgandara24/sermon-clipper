import type { TranscriptSegmentInput } from "../chunking";
import {
  OutlineGenerationError,
  type ExclusionRange,
  type OutlineSectionDraft,
  type OutlineSectionType,
} from "./types";

export type RawSectionAnchor = {
  type: OutlineSectionType;
  heading: string;
  summary: string;
  startSegmentIdx: number;
  endSegmentIdx: number;
  confidence: number;
};

// The union of sections + exclusions must span at least this fraction of the sermon's duration,
// otherwise the model's outline missed too much of the recording to be trusted.
const MIN_COVERAGE_FRACTION = 0.85;

/**
 * Resolves model-emitted segment anchors into validated, ordered, non-overlapping sections that
 * (together with exclusion ranges) cover the sermon (guardrails for the "hierarchical outline
 * detection" stage). Repairs what it safely can — clamping anchors, trimming overlaps, absorbing
 * small uncovered gaps into the preceding section — and throws OutlineGenerationError for
 * structural failures (no sections, unordered beyond repair, poor coverage) so the caller can
 * fall to the next reliability tier.
 */
export function resolveSectionAnchors(
  rawSections: RawSectionAnchor[],
  segments: TranscriptSegmentInput[],
  exclusions: ExclusionRange[],
): OutlineSectionDraft[] {
  if (segments.length === 0) throw new OutlineGenerationError("No transcript segments.");
  if (rawSections.length === 0) throw new OutlineGenerationError("Model returned no sections.");

  const byIdx = new Map(segments.map((s) => [s.idx, s]));
  const minIdx = segments[0].idx;
  const maxIdx = segments[segments.length - 1].idx;

  const clamped = rawSections
    .map((section) => ({
      ...section,
      startSegmentIdx: clampToExisting(section.startSegmentIdx, minIdx, maxIdx, byIdx, +1),
      endSegmentIdx: clampToExisting(section.endSegmentIdx, minIdx, maxIdx, byIdx, -1),
      confidence: Math.min(1, Math.max(0, section.confidence)),
    }))
    .filter((section) => section.startSegmentIdx <= section.endSegmentIdx)
    .sort((a, b) => a.startSegmentIdx - b.startSegmentIdx);

  if (clamped.length === 0) {
    throw new OutlineGenerationError("No section anchors survived clamping.");
  }

  // Trim overlaps in favor of the earlier section's stated end; drop sections a predecessor
  // fully swallows.
  const ordered: RawSectionAnchor[] = [];
  for (const section of clamped) {
    const prev = ordered[ordered.length - 1];
    if (prev && section.startSegmentIdx <= prev.endSegmentIdx) {
      const trimmedStart = prev.endSegmentIdx + 1;
      if (trimmedStart > section.endSegmentIdx) continue;
      ordered.push({ ...section, startSegmentIdx: trimmedStart });
    } else {
      ordered.push(section);
    }
  }

  // Absorb uncovered gaps into the preceding section unless an exclusion range occupies the
  // gap — excluded material must stay outside every section.
  for (let i = 0; i < ordered.length - 1; i += 1) {
    const gapStart = ordered[i].endSegmentIdx + 1;
    const gapEnd = ordered[i + 1].startSegmentIdx - 1;
    if (gapStart > gapEnd) continue;
    const gapStartMs = byIdx.get(nearestExisting(gapStart, byIdx, maxIdx, +1))?.startMs ?? 0;
    const gapEndMs = byIdx.get(nearestExisting(gapEnd, byIdx, minIdx, -1))?.endMs ?? 0;
    if (!overlapsExclusion(gapStartMs, gapEndMs, exclusions)) {
      ordered[i] = { ...ordered[i], endSegmentIdx: gapEnd };
    }
  }

  const sections: OutlineSectionDraft[] = ordered.map((section, position) => {
    const startSeg = byIdx.get(nearestExisting(section.startSegmentIdx, byIdx, maxIdx, +1));
    const endSeg = byIdx.get(nearestExisting(section.endSegmentIdx, byIdx, minIdx, -1));
    if (!startSeg || !endSeg || startSeg.startMs > endSeg.endMs) {
      throw new OutlineGenerationError("Section anchors resolve to an invalid segment range.");
    }
    return {
      position,
      type: section.type,
      heading: section.heading.trim() || fallbackHeading(section.type, position),
      summary: section.summary.trim(),
      startSegmentIdx: startSeg.idx,
      endSegmentIdx: endSeg.idx,
      startMs: startSeg.startMs,
      endMs: endSeg.endMs,
      confidence: section.confidence,
    };
  });

  clampSectionsMsMonotonic(sections);

  const sermonStart = segments[0].startMs;
  const sermonEnd = segments[segments.length - 1].endMs;
  const sermonSpan = Math.max(1, sermonEnd - sermonStart);
  const coveredMs =
    sections.reduce((sum, s) => sum + (s.endMs - s.startMs), 0) +
    exclusions.reduce(
      (sum, e) => sum + Math.max(0, Math.min(e.endMs, sermonEnd) - Math.max(e.startMs, sermonStart)),
      0,
    );
  if (coveredMs / sermonSpan < MIN_COVERAGE_FRACTION) {
    throw new OutlineGenerationError(
      `Outline covers only ${Math.round((coveredMs / sermonSpan) * 100)}% of the sermon.`,
    );
  }

  return sections;
}

/**
 * Sections are non-overlapping in segment space by construction, but transcript segments
 * themselves can overlap in TIME (YouTube auto-caption cues do; whisper's don't), which would
 * leak small millisecond overlaps between adjacent sections. Clamp each section's start to its
 * predecessor's end so the ordered/non-overlapping invariant holds in both spaces.
 */
export function clampSectionsMsMonotonic(sections: OutlineSectionDraft[]): void {
  for (let i = 1; i < sections.length; i += 1) {
    const prevEnd = sections[i - 1].endMs;
    if (sections[i].startMs < prevEnd && prevEnd < sections[i].endMs) {
      sections[i].startMs = prevEnd;
    }
  }
}

export function overlapsExclusion(
  startMs: number,
  endMs: number,
  exclusions: ExclusionRange[],
): boolean {
  return exclusions.some((e) => Math.min(endMs, e.endMs) - Math.max(startMs, e.startMs) > 0);
}

function fallbackHeading(type: OutlineSectionType, position: number): string {
  if (type === "introduction") return "Introduction";
  if (type === "conclusion") return "Conclusion";
  if (type === "main_message") return "Main Message";
  return `Point ${position}`;
}

function clampToExisting(
  idx: number,
  minIdx: number,
  maxIdx: number,
  byIdx: Map<number, TranscriptSegmentInput>,
  direction: 1 | -1,
): number {
  const clamped = Math.min(maxIdx, Math.max(minIdx, Math.round(idx)));
  return nearestExisting(clamped, byIdx, direction === 1 ? maxIdx : minIdx, direction);
}

/** Walks from idx in `direction` until a segment with that idx exists (idx gaps are legal). */
function nearestExisting(
  idx: number,
  byIdx: Map<number, TranscriptSegmentInput>,
  limit: number,
  direction: 1 | -1,
): number {
  let current = idx;
  while (!byIdx.has(current) && current !== limit) current += direction;
  return current;
}
