import type { TranscriptSegmentInput } from "../chunking";

/**
 * Why a span of the recording is ineligible for clips. Kept as internal diagnostics on
 * SermonOutline.exclusions — excluded spans never become sections, candidates, or scores.
 */
export type ExclusionReason =
  | "worship"
  | "announcement"
  | "baptism"
  | "invitation"
  | "altar_call"
  | "prayer"
  | "not_preaching"
  | "preacher_not_visible";

export type ExclusionRange = {
  startMs: number;
  endMs: number;
  reason: ExclusionReason;
};

/** Mirrors the Prisma SermonSectionType enum values (lowercase DB spellings). */
export type OutlineSectionType = "introduction" | "point" | "conclusion" | "main_message";

/** Mirrors the Prisma SermonOutlineStatus enum values. */
export type OutlineStatus = "generated" | "heuristic" | "fallback_single";

export type OutlineSectionDraft = {
  position: number;
  type: OutlineSectionType;
  heading: string;
  summary: string;
  startSegmentIdx: number;
  endSegmentIdx: number;
  startMs: number;
  endMs: number;
  confidence: number;
};

export type SermonOutlineDraft = {
  mainIdea: string;
  generatedTitle: string | null;
  modelVersion: string;
  confidence: number;
  status: OutlineStatus;
  sections: OutlineSectionDraft[];
  exclusions: ExclusionRange[];
};

/** A 3–5 minute run of consecutive transcript segments used as the outline analysis unit. */
export type AnalysisBlock = {
  blockIdx: number;
  startSegmentIdx: number;
  endSegmentIdx: number;
  startMs: number;
  endMs: number;
  segments: TranscriptSegmentInput[];
};

export class OutlineGenerationError extends Error {}
