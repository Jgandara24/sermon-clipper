"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePlatformOperator } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  applyPriorServiceFill,
  PriorServiceFillRefusedError,
} from "@/lib/review/prior-service-fill";
import {
  readPriorServiceFill,
  type PriorServiceFillActionState,
} from "@/lib/review/prior-service-fill-input";

/**
 * Filling an empty date, from the operator's shortage page.
 *
 * A Server Action is a POST endpoint anyone can reach, not a function only your own form can call.
 * Next's guidance is blunt: rendering a form on an authenticated page is not a security boundary.
 * So this proves the platform-operator marker itself, and validates its input, before touching
 * anything — the same shape as `submitClipReviewAction`.
 *
 * **The confirmation is checked here, not only in the browser.** A form field is a claim about
 * what a person did, and a POST that skipped the form would simply omit it. Requiring it server
 * side is what makes "the operator confirmed" a fact rather than a hope.
 *
 * The state type, the idle constant and the schema live in `prior-service-fill-input.ts` because a
 * `"use server"` module may export nothing but async functions — and that failure arrives at
 * request time, past both typecheck and lint.
 */

export async function submitPriorServiceFillAction(
  _previous: PriorServiceFillActionState,
  formData: FormData,
): Promise<PriorServiceFillActionState> {
  const operator = await requirePlatformOperator();

  let scheduledPostId: string | null = null;
  try {
    const input = readPriorServiceFill(formData);
    scheduledPostId = input.scheduledPostId;

    const outcome = await applyPriorServiceFill(prisma, {
      scheduledPostId: input.scheduledPostId,
      candidateClipId: input.candidateClipId,
      operatorUserId: operator.id,
    });

    revalidatePath(`/app/operator/projects/${outcome.targetProjectId}`);
    revalidatePath("/app/operator/review");
    revalidatePath("/app/calendar");

    return {
      status: "success",
      message: outcome.alreadyFilled
        ? "This date was already filled with that clip. Nothing changed."
        : "Filled. A priority render is queued; the date opens for review once it finishes.",
    };
  } catch (error) {
    if (error instanceof PriorServiceFillRefusedError) {
      // The policy's own wording. It was written for the person choosing a clip.
      return { status: "error", message: error.message };
    }
    if (error instanceof z.ZodError) {
      const confirmation = error.issues.find((issue) => issue.path[0] === "confirmed");
      return {
        status: "error",
        message: confirmation
          ? "Tick the confirmation before filling this date."
          : "Choose one clip before filling this date.",
      };
    }
    console.error("[operator] prior-service fill failed", { scheduledPostId, error });
    return {
      status: "error",
      message: "Something went wrong filling that date. Nothing was changed.",
    };
  }
}
