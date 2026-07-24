import type { TranscriptSegmentInput } from "../chunking";
import { isLikelyNonSermonText } from "../sermon-boundary";
import { clampSectionsMsMonotonic } from "./validate";
import type {
  ExclusionRange,
  ExclusionReason,
  OutlineSectionDraft,
  SermonOutlineDraft,
} from "./types";

// Phrases that mark the start of a numbered point or a structural move. Matched against
// lowercase unpunctuated ASR text, so multi-word phrases use plain substring matching.
const POINT_MARKERS = [
  "the first thing",
  "here's the first",
  "heres the first",
  "my first point",
  "first point",
  "point number one",
  "number one",
  "the second thing",
  "my second point",
  "second point",
  "point number two",
  "number two",
  "the third thing",
  "my third point",
  "third point",
  "point number three",
  "number three",
  "the fourth thing",
  "my fourth point",
  "fourth point",
  "here's what this means",
  "heres what this means",
  "turn with me to",
  "turn in your bibles",
];

const CONCLUSION_MARKERS = [
  "as i close",
  "in closing",
  "as we close",
  "let me close",
  "as i wrap up",
  "as we wrap up",
  "one final thing",
  "finally",
];

// Non-preaching activity that must never produce clips or outline sections. Checked per
// segment window; reasons feed SermonOutline.exclusions diagnostics.
const EXCLUSION_MARKERS: Array<{ reason: ExclusionReason; phrases: string[] }> = [
  {
    reason: "invitation",
    phrases: ["every head bowed", "every eye closed", "would you bow your heads", "pray this prayer with me", "repeat after me", "invite you to come"],
  },
  {
    reason: "altar_call",
    phrases: ["come forward", "come to the altar", "the altar is open", "altar call"],
  },
  {
    reason: "baptism",
    phrases: ["baptize", "baptism", "baptized"],
  },
];

// A silence this long inside preaching almost always separates structural units (transition,
// applause, walking to the pulpit) — used as a secondary boundary signal.
const SECTION_PAUSE_MS = 4_000;
// Heuristic sections shorter than this get merged forward; a 20-second "section" is noise.
const MIN_SECTION_MS = 60_000;
const HEURISTIC_CONFIDENCE = 0.4;
const FALLBACK_CONFIDENCE = 0.2;

function containsAny(text: string, phrases: string[]): boolean {
  return phrases.some((phrase) => text.includes(phrase));
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9' ]/g, " ");
}

/**
 * Lexical scan for spans of non-preaching activity (worship/announcements via the existing
 * sermon-boundary lexicon; invitation/altar-call/baptism via phrase markers). Consecutive
 * flagged segments coalesce into one range. Purely a fallback signal — the AI outline stage
 * produces sharper exclusions when it runs.
 */
export function detectHeuristicExclusions(segments: TranscriptSegmentInput[]): ExclusionRange[] {
  const flagged: Array<{ segment: TranscriptSegmentInput; reason: ExclusionReason }> = [];
  for (const segment of segments) {
    const normalized = normalize(segment.text);
    const marker = EXCLUSION_MARKERS.find((m) => containsAny(normalized, m.phrases));
    if (marker) {
      flagged.push({ segment, reason: marker.reason });
    } else if (isLikelyNonSermonText(segment.text)) {
      flagged.push({ segment, reason: "not_preaching" });
    }
  }

  const ranges: ExclusionRange[] = [];
  for (const { segment, reason } of flagged) {
    const last = ranges[ranges.length - 1];
    // Merge flags within 30s of each other into one range — a worship set or announcement
    // block trips the lexicon on scattered segments, not every single one.
    if (last && last.reason === reason && segment.startMs - last.endMs <= 30_000) {
      last.endMs = segment.endMs;
    } else {
      ranges.push({ startMs: segment.startMs, endMs: segment.endMs, reason });
    }
  }
  return ranges;
}

/**
 * Transition-phrase + pause fallback (reliability tier 2): splits the sermon at explicit point
 * markers, closing language, and long silences, then labels the pieces
 * introduction → point(s) → conclusion by position. Returns null when the signals are too thin
 * to justify a multi-section outline — the caller then falls to the single-section tier.
 */
export function buildHeuristicOutline(
  segments: TranscriptSegmentInput[],
): SermonOutlineDraft | null {
  if (segments.length === 0) return null;

  const boundaries: Array<{ segmentArrayIdx: number; isConclusion: boolean }> = [];
  for (let i = 1; i < segments.length; i += 1) {
    const normalized = normalize(segments[i].text);
    const gap = segments[i].startMs - segments[i - 1].endMs;
    if (containsAny(normalized, CONCLUSION_MARKERS)) {
      boundaries.push({ segmentArrayIdx: i, isConclusion: true });
    } else if (containsAny(normalized, POINT_MARKERS) || gap >= SECTION_PAUSE_MS) {
      boundaries.push({ segmentArrayIdx: i, isConclusion: false });
    }
  }

  // Drop boundaries that would create a section shorter than MIN_SECTION_MS.
  const kept: typeof boundaries = [];
  let lastStartMs = segments[0].startMs;
  for (const boundary of boundaries) {
    const startMs = segments[boundary.segmentArrayIdx].startMs;
    if (startMs - lastStartMs >= MIN_SECTION_MS) {
      kept.push(boundary);
      lastStartMs = startMs;
    }
  }

  if (kept.length < 2) return null;

  const cuts = [0, ...kept.map((b) => b.segmentArrayIdx), segments.length];
  const sections: OutlineSectionDraft[] = [];
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const slice = segments.slice(cuts[i], cuts[i + 1]);
    if (slice.length === 0) continue;
    const isFirst = sections.length === 0;
    const isLast = i === cuts.length - 2;
    const followsConclusionMarker = i > 0 && kept[i - 1]?.isConclusion;
    const type = isFirst
      ? "introduction"
      : isLast || followsConclusionMarker
        ? "conclusion"
        : "point";
    const pointNumber = sections.filter((s) => s.type === "point").length + 1;
    sections.push({
      position: sections.length,
      type,
      heading:
        type === "introduction"
          ? "Introduction"
          : type === "conclusion"
            ? "Conclusion"
            : `Point ${pointNumber}`,
      summary: buildSectionSummary(slice),
      startSegmentIdx: slice[0].idx,
      endSegmentIdx: slice[slice.length - 1].idx,
      startMs: slice[0].startMs,
      endMs: slice[slice.length - 1].endMs,
      confidence: HEURISTIC_CONFIDENCE,
    });
  }

  if (sections.length < 2) return null;
  clampSectionsMsMonotonic(sections);

  return {
    mainIdea: buildSectionSummary(segments),
    generatedTitle: null,
    modelVersion: "heuristic-outline-v1",
    confidence: HEURISTIC_CONFIDENCE,
    status: "heuristic",
    sections,
    exclusions: detectHeuristicExclusions(segments),
  };
}

/**
 * Final reliability tier: one "Main Message" section covering the whole sermon, so downstream
 * stages and the outline UI always have a structure to hang clips on.
 */
export function buildSingleSectionOutline(
  segments: TranscriptSegmentInput[],
): SermonOutlineDraft {
  const first = segments[0];
  const last = segments[segments.length - 1];
  return {
    mainIdea: buildSectionSummary(segments),
    generatedTitle: null,
    modelVersion: "fallback-single-v1",
    confidence: FALLBACK_CONFIDENCE,
    status: "fallback_single",
    sections: [
      {
        position: 0,
        type: "main_message",
        heading: "Main Message",
        summary: buildSectionSummary(segments),
        startSegmentIdx: first.idx,
        endSegmentIdx: last.idx,
        startMs: first.startMs,
        endMs: last.endMs,
        confidence: FALLBACK_CONFIDENCE,
      },
    ],
    exclusions: detectHeuristicExclusions(segments),
  };
}

/** First ~20 words of a span — a deterministic stand-in for an AI summary in fallback tiers. */
function buildSectionSummary(segments: TranscriptSegmentInput[]): string {
  const words = segments
    .map((s) => s.text)
    .join(" ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 20)
    .join(" ");
  return words.length > 0 ? `${words}…` : "…";
}
