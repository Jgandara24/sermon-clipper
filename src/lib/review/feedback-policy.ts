import {
  ClipReviewDecision,
  ReviewFeedbackActionability,
  ReviewFeedbackCategory,
} from "@prisma/client";
import type { ReviewFeedbackInput } from "./types";

/**
 * What a finding demands: re-edit this clip, or pick a different one.
 *
 * The table is the point (Addendum S15). A reviewer says what is wrong; the table says what that
 * costs. Storing the answer on each feedback row rather than deriving it at read time means a
 * later change to this table cannot rewrite what a past finding demanded.
 *
 * The split is not about severity. A clip whose point never lands is a `CONTENT` defect and no
 * amount of re-editing fixes it, so it is replace-only however mild it sounds. A caption sitting
 * over the speaker's chin is fixable in the editor, so it is revisable however ugly it looks.
 */

/**
 * Categories whose defect is in the clip's *selection*, not its presentation. Nothing the editor
 * can do to this clip fixes them.
 */
const REPLACE_ONLY_CATEGORIES: ReadonlySet<ReviewFeedbackCategory> = new Set([
  ReviewFeedbackCategory.CONTENT,
]);

/**
 * Categories fixable by re-editing the same clip: boundaries, crop, captions, audio, and the
 * machine-written title and hook.
 */
const REVISABLE_CATEGORIES: ReadonlySet<ReviewFeedbackCategory> = new Set([
  ReviewFeedbackCategory.BOUNDARY,
  ReviewFeedbackCategory.VISUAL_CROP,
  ReviewFeedbackCategory.CAPTION,
  ReviewFeedbackCategory.AUDIO_LEVEL,
  ReviewFeedbackCategory.TITLE_HOOK,
]);

export type LocatedFinding = {
  category: ReviewFeedbackCategory;
  startMs?: number | null;
  endMs?: number | null;
};

/**
 * Whether a span can be excised by moving a boundary.
 *
 * This is P1.5's rule, reused rather than restated: an export must render as one continuous
 * range (`src/lib/exports/continuous-range.ts`). Cutting a span out of the middle leaves two
 * ranges, which the renderer refuses. Cutting one off either end leaves one. So "at the edge" is
 * not a tolerance somebody picked — it is exactly the set of spans a trim can remove.
 *
 * A finding with no position cannot be shown to be trimmable, so it is treated as mid-clip. That
 * fails closed: the cost of being wrong is one unnecessary replacement, against publishing a clip
 * with forbidden content still in it.
 */
export function isTrimmableAtEdge(finding: LocatedFinding, clipDurationMs: number): boolean {
  if (finding.startMs == null || finding.endMs == null) return false;
  if (!(clipDurationMs > 0)) return false;
  return finding.startMs <= 0 || finding.endMs >= clipDurationMs;
}

/**
 * The actionability the table gives a finding.
 *
 * `FORBIDDEN_CONTENT` is the one category the position decides. The editorial standard permits
 * excluding a short slide at the *edge* of a candidate by moving a boundary, "but only when the
 * resulting boundaries still contain a complete thought" (§5). Mid-clip, there is no boundary to
 * move, so the clip has to go.
 */
export function defaultActionability(
  finding: LocatedFinding,
  clipDurationMs: number,
): ReviewFeedbackActionability {
  if (finding.category === ReviewFeedbackCategory.FORBIDDEN_CONTENT) {
    return isTrimmableAtEdge(finding, clipDurationMs)
      ? ReviewFeedbackActionability.REVISABLE
      : ReviewFeedbackActionability.REPLACE_ONLY;
  }
  if (REPLACE_ONLY_CATEGORIES.has(finding.category)) {
    return ReviewFeedbackActionability.REPLACE_ONLY;
  }
  if (REVISABLE_CATEGORIES.has(finding.category)) {
    return ReviewFeedbackActionability.REVISABLE;
  }
  // A category added to the enum without a row here. Fail closed rather than guess it is cheap.
  return ReviewFeedbackActionability.REPLACE_ONLY;
}

/** The actionability a finding will be stored with: the reviewer's, or the table's. */
export function resolveActionability(
  finding: ReviewFeedbackInput,
  clipDurationMs: number,
): ReviewFeedbackActionability {
  return finding.actionability ?? defaultActionability(finding, clipDurationMs);
}

/**
 * The decision a set of findings requires.
 *
 * One replace-only finding is enough: a clip cannot be half-replaced. Everything else is
 * revisable, and no findings at all means nothing is being asked for, which is an ACCEPT.
 */
export function requiredDecision(
  feedback: ReviewFeedbackInput[],
  clipDurationMs: number,
): ClipReviewDecision {
  const resolved = feedback.map((finding) => resolveActionability(finding, clipDurationMs));
  if (resolved.includes(ReviewFeedbackActionability.REPLACE_ONLY)) {
    return ClipReviewDecision.REPLACE;
  }
  if (resolved.includes(ReviewFeedbackActionability.REVISABLE)) {
    return ClipReviewDecision.REVISE;
  }
  return ClipReviewDecision.ACCEPT;
}

/** The categories in this set that a REVISE cannot honour. Empty means the REVISE is valid. */
export function replaceOnlyCategories(
  feedback: ReviewFeedbackInput[],
  clipDurationMs: number,
): ReviewFeedbackCategory[] {
  return feedback
    .filter(
      (finding) =>
        resolveActionability(finding, clipDurationMs) ===
        ReviewFeedbackActionability.REPLACE_ONLY,
    )
    .map((finding) => finding.category);
}
