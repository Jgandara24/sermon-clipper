import { ClipReviewDecision, ReviewFeedbackCategory, ReviewFeedbackSeverity } from "@prisma/client";
import { z } from "zod";
import type { ReviewFeedbackInput } from "./types";

/**
 * Reading a decision out of a form.
 *
 * Separate from the Server Action that uses it because a `"use server"` module may only export
 * async functions, which makes everything in one unreachable from a unit test. The parsing is the
 * part worth testing on its own: it is the boundary where untrusted `FormData` becomes something
 * the service is allowed to see.
 */

/**
 * What a decision form hands back to the page.
 *
 * It lives here rather than beside the action because a `"use server"` module may export nothing
 * but async functions — a plain `const` in that file is a build error, and the message ("can only
 * export async functions, found object") arrives at request time rather than at compile time.
 */
export type ClipReviewActionState = {
  status: "idle" | "success" | "error";
  message: string;
};

export const CLIP_REVIEW_IDLE: ClipReviewActionState = { status: "idle", message: "" };

/**
 * The decisions the *append* path may write.
 *
 * `REPLACE` is absent, and still is now that P2.7 exists: an appended `REPLACE` would be a review
 * row with no supersession, no promotion, no rebinding and no render. A replacement goes through
 * `replaceScheduledClip`, which is the only code that writes one, and `appendClipReview` refuses
 * it a second time at the service.
 */
export const APPENDABLE_DECISIONS = [
  ClipReviewDecision.ACCEPT,
  ClipReviewDecision.REVISE,
] as const;

/** Every decision a reviewer may take from the page, including the one with its own command. */
export const SUBMITTABLE_DECISIONS = [
  ClipReviewDecision.ACCEPT,
  ClipReviewDecision.REVISE,
  ClipReviewDecision.REPLACE,
] as const;

export const decisionSchema = z.object({
  scheduledPostId: z.string().uuid(),
  decision: z.enum(SUBMITTABLE_DECISIONS),
  note: z.string().trim().max(4000).optional(),
  /**
   * What the reviewer had on screen. Client-supplied, and never used to select anything: the
   * service reads the slot's current identity and compares these four values to it, refusing if
   * they differ. Sending the current values instead of what was seen gains nothing an operator
   * did not already have — the check protects an honest reviewer from a race, not the system
   * from its operator.
   */
  clipId: z.string().uuid(),
  exportJobId: z.string().uuid(),
  editVersion: z.coerce.number().int().min(0),
  checksum: z.string().trim().min(1).max(200),
});

export const laterFeedbackSchema = z.object({
  clipReviewId: z.string().uuid(),
  scheduledPostId: z.string().uuid(),
});

const feedbackCategories = Object.values(ReviewFeedbackCategory) as [string, ...string[]];
const feedbackSeverities = Object.values(ReviewFeedbackSeverity) as [string, ...string[]];

const optionalMs = z
  .string()
  .trim()
  .transform((value) => (value === "" ? null : value))
  .nullable()
  .refine((value) => value === null || /^\d+$/.test(value), "A position must be whole milliseconds.")
  .transform((value) => (value === null ? null : Number(value)));

const feedbackRowSchema = z.object({
  category: z.enum(feedbackCategories),
  severity: z.enum(feedbackSeverities),
  note: z.string().trim().min(1).max(2000),
  startMs: optionalMs,
  endMs: optionalMs,
});

/**
 * Findings arrive as parallel arrays, which is how a repeated form field reaches `FormData`.
 *
 * A row with an empty note is dropped rather than refused. The form keeps a blank row at the
 * bottom for the next thought, and submitting with it untouched must not be an error — a reviewer
 * losing a written decision to a stray empty row would be a poor trade for strictness.
 */
export function readFeedbackRows(formData: FormData): ReviewFeedbackInput[] {
  const categories = formData.getAll("feedbackCategory").map(String);
  const notes = formData.getAll("feedbackNote").map(String);
  const severities = formData.getAll("feedbackSeverity").map(String);
  const starts = formData.getAll("feedbackStartMs").map(String);
  const ends = formData.getAll("feedbackEndMs").map(String);

  const findings: ReviewFeedbackInput[] = [];
  for (let index = 0; index < notes.length; index += 1) {
    if (notes[index].trim() === "") continue;
    findings.push(
      feedbackRowSchema.parse({
        category: categories[index],
        severity: severities[index],
        note: notes[index],
        startMs: starts[index] ?? "",
        endMs: ends[index] ?? "",
      }) as ReviewFeedbackInput,
    );
  }
  return findings;
}
