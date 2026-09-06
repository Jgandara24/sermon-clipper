import type {
  ClipReviewDecision,
  ReviewFeedbackActionability,
  ReviewFeedbackCategory,
  ReviewFeedbackSeverity,
  ReviewerKind,
} from "@prisma/client";

/**
 * The vocabulary of a human editorial decision, and the errors that refuse a dishonest one.
 *
 * A delivered clip must have been accepted against the exact file that will publish — the exact
 * clip, the exact edit version, the exact rendered output
 * (`docs/PULPIT_ENGINE_EDITORIAL_STANDARD.md` §7). Everything here exists to make "exact"
 * checkable rather than assumed.
 */

/**
 * What a review was about, as four facts that must all match at publish time (P2.8).
 *
 * The reviewer sees one file. These name it: which clip, which saved edit version, which export
 * job produced the file, and the checksum computed when that file passed QC. Any one of them
 * moving invalidates the acceptance, which is why they are stored rather than re-derived.
 */
export type ReviewedRenderIdentity = {
  clipId: string;
  editVersion: number;
  exportJobId: string;
  checksum: string;
};

/** Where the reviewed clip sits, kept so the decision stays readable after the clip is gone. */
export type ReviewedClipSpan = {
  rank: number;
  startMs: number;
  endMs: number;
};

/** One finding. `actionability` is derived from the category and position unless stated. */
export type ReviewFeedbackInput = {
  category: ReviewFeedbackCategory;
  note: string;
  severity?: ReviewFeedbackSeverity;
  actionability?: ReviewFeedbackActionability;
  /** Clip-relative milliseconds. Both or neither; a finding without a position is not located. */
  startMs?: number | null;
  endMs?: number | null;
  authorKind?: ReviewerKind;
  authorUserId?: string | null;
};

/**
 * The decisions the base append service may write.
 *
 * `REPLACE` is a valid decision and is deliberately not in this union. A replacement is not a
 * record of a judgement, it is five writes that must all land together — supersession, reserve
 * promotion, slot rebinding, a priority export, and the review itself. Only P2.7's atomic command
 * may create one. See `BareReplaceForbiddenError`.
 */
export type AppendableDecision = Extract<ClipReviewDecision, "ACCEPT" | "REVISE">;

export type AppendClipReviewInput = {
  scheduledPostId: string;
  decision: AppendableDecision;
  /** What the reviewer had in front of them. Refused if it is no longer what the slot holds. */
  identity: ReviewedRenderIdentity;
  reviewerUserId?: string | null;
  reviewerKind?: ReviewerKind;
  note?: string | null;
  feedback?: ReviewFeedbackInput[];
};

/** The review moved on, or the file did, between the reviewer looking and the reviewer deciding. */
export class StaleRenderError extends Error {
  constructor(
    readonly scheduledPostId: string,
    readonly mismatch: string,
  ) {
    super(
      `The render under review is no longer what slot ${scheduledPostId} holds: ${mismatch}. ` +
        "Reload the review and decide against the current file.",
    );
    this.name = "StaleRenderError";
  }
}

/** A `REPLACE` was written on its own, outside P2.7's transaction. */
export class BareReplaceForbiddenError extends Error {
  constructor() {
    super(
      "A REPLACE cannot be appended on its own. It must be created by the atomic replacement " +
        "command, together with supersession, reserve promotion, slot rebinding and the priority " +
        "export, or it leaves the slot half-changed.",
    );
    this.name = "BareReplaceForbiddenError";
  }
}

/** A `REVISE` carried a finding that re-editing this clip cannot fix. */
export class NotRevisableError extends Error {
  constructor(readonly categories: ReviewFeedbackCategory[]) {
    super(
      `These findings cannot be fixed by re-editing this clip: ${categories.join(", ")}. ` +
        "They need a different clip, so the decision is REPLACE, not REVISE.",
    );
    this.name = "NotRevisableError";
  }
}

/** The slot, clip or export named by a review does not exist, or do not belong together. */
export class ReviewSubjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewSubjectError";
  }
}
