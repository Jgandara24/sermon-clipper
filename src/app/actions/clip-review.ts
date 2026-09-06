"use server";

import { ClipReviewDecision } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePlatformOperator } from "@/lib/auth";
import { recordOperationalEventSafely } from "@/lib/observability/operational-events";
import { prisma } from "@/lib/prisma";
import {
  decisionSchema,
  laterFeedbackSchema,
  readFeedbackRows,
  type ClipReviewActionState,
} from "@/lib/review/decision-input";
import {
  replaceScheduledClip,
  ReplacementRefusedError,
} from "@/lib/review/replace-scheduled-clip";
import { appendClipReview, appendReviewFeedback } from "@/lib/review/service";
import {
  BareReplaceForbiddenError,
  NotRevisableError,
  ReviewSubjectError,
  StaleRenderError,
} from "@/lib/review/types";

/**
 * Recording a decision from the operator review page.
 *
 * A Server Action is a POST endpoint that anyone can reach, not a function only your own form can
 * call. Next's own guidance is blunt about it: "Render-time gating (only rendering a form on an
 * authenticated page) is not a security boundary." So every action here proves the platform
 * operator marker itself, and validates its input, before touching anything.
 */

/** Turns a refusal into something a reviewer can act on, without leaking internals. */
function explain(error: unknown): string {
  if (error instanceof StaleRenderError) {
    return "This slot moved on while you were watching. Reload and decide against the file it holds now.";
  }
  if (error instanceof NotRevisableError) {
    return (
      "One of these findings cannot be fixed by re-editing this clip, so the decision is a " +
      "replacement rather than a revision. Replacement arrives with the next release."
    );
  }
  if (error instanceof ReplacementRefusedError) {
    return error.message;
  }
  if (error instanceof BareReplaceForbiddenError) {
    return "A replacement has to go through the replacement command, not the append path.";
  }
  if (error instanceof ReviewSubjectError) {
    return error.message;
  }
  if (error instanceof z.ZodError) {
    return "That decision couldn't be read. Check the findings and try again.";
  }
  return "Something went wrong recording that decision. Nothing was saved.";
}

export async function submitClipReviewAction(
  _previous: ClipReviewActionState,
  formData: FormData,
): Promise<ClipReviewActionState> {
  // Authorization inside the action, not merely on the page that renders the form.
  const operator = await requirePlatformOperator();

  try {
    const input = decisionSchema.parse({
      scheduledPostId: formData.get("scheduledPostId"),
      decision: formData.get("decision"),
      note: formData.get("note") ?? undefined,
      clipId: formData.get("clipId"),
      exportJobId: formData.get("exportJobId"),
      editVersion: formData.get("editVersion"),
      checksum: formData.get("checksum"),
    });

    // A replacement is not an appended decision. It promotes a reserve, supersedes the rejected
    // clip, rebinds the slot and queues a priority render, all in one transaction — so it has its
    // own command, and the append path refuses it.
    if (input.decision === ClipReviewDecision.REPLACE) {
      const replacement = await replaceScheduledClip(prisma, {
        scheduledPostId: input.scheduledPostId,
        reviewerUserId: operator.id,
        note: input.note || null,
        identity: {
          clipId: input.clipId,
          exportJobId: input.exportJobId,
          editVersion: input.editVersion,
          checksum: input.checksum,
        },
        feedback: readFeedbackRows(formData),
      });

      revalidatePath(`/app/operator/review/${input.scheduledPostId}`);
      revalidatePath("/app/operator/review");

      return {
        status: "success",
        message: replacement.promotedClipId
          ? "Replaced. The next reserve is queued for a priority render and holds this date."
          : "Replaced, but this sermon had no clip left. The date is unfilled and an exception is open.",
      };
    }

    const review = await appendClipReview(prisma, {
      scheduledPostId: input.scheduledPostId,
      decision: input.decision,
      reviewerUserId: operator.id,
      note: input.note || null,
      identity: {
        clipId: input.clipId,
        exportJobId: input.exportJobId,
        editVersion: input.editVersion,
        checksum: input.checksum,
      },
      feedback: readFeedbackRows(formData),
    });

    await recordOperationalEventSafely(prisma, {
      workspaceId: review.workspaceId,
      category: "approval",
      eventType: "clip_review_recorded",
      message: `An operator recorded ${review.decision} against the exact render.`,
      projectId: review.projectId,
      clipId: review.clipId,
      exportJobId: review.exportJobId,
      metadata: {
        scheduledPostId: review.scheduledPostIdSnapshot,
        decision: review.decision,
        editVersion: review.editVersion,
        feedbackCount: review.feedback.length,
      },
    });

    revalidatePath(`/app/operator/review/${input.scheduledPostId}`);
    revalidatePath("/app/operator/review");

    return {
      status: "success",
      message:
        review.decision === ClipReviewDecision.ACCEPT
          ? "Accepted. This exact file is the one that may publish."
          : "Revision requested. Delivery stays blocked until a new render is accepted.",
    };
  } catch (error) {
    return { status: "error", message: explain(error) };
  }
}

/**
 * Findings added after the decision, however long afterwards.
 *
 * The decision itself does not move — correcting one means appending a new review — so this
 * writes only feedback. That is the product owner's rule: a reviewer watching a service back a
 * week later can still say what they noticed.
 */
export async function addReviewFeedbackAction(
  _previous: ClipReviewActionState,
  formData: FormData,
): Promise<ClipReviewActionState> {
  const operator = await requirePlatformOperator();

  try {
    const input = laterFeedbackSchema.parse({
      clipReviewId: formData.get("clipReviewId"),
      scheduledPostId: formData.get("scheduledPostId"),
    });
    const feedback = readFeedbackRows(formData);
    if (feedback.length === 0) {
      return { status: "error", message: "Write the finding before adding it." };
    }

    await appendReviewFeedback(prisma, {
      clipReviewId: input.clipReviewId,
      authorUserId: operator.id,
      feedback,
    });

    revalidatePath(`/app/operator/review/${input.scheduledPostId}`);
    return { status: "success", message: `Added ${feedback.length} finding(s).` };
  } catch (error) {
    return { status: "error", message: explain(error) };
  }
}
