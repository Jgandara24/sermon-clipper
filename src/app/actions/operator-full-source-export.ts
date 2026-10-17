"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePlatformOperator } from "@/lib/auth";
import { readFullSourceFallbackForm, type FullSourceFallbackActionState } from "@/lib/exports/full-source-fallback-input";
import { requestFullSourceFallback } from "@/lib/exports/full-source-fallback-request";
import { prisma } from "@/lib/prisma";

/**
 * Requesting a full-source export fallback from the operator's project page.
 * Authorization is proved here: a Server Action is a POST endpoint anyone can reach.
 */
export async function submitFullSourceFallbackAction(
  _previous: FullSourceFallbackActionState,
  formData: FormData,
): Promise<FullSourceFallbackActionState> {
  const operator = await requirePlatformOperator();
  try {
    const input = readFullSourceFallbackForm(formData);
    const outcome = await requestFullSourceFallback(prisma, { clipId: input.clipId, operatorUserId: operator.id, reason: input.reason });
    if (!outcome.ok) return { status: "error", message: outcome.message };
    revalidatePath("/app/operator/projects/[projectId]", "page");
    return { status: "success", message: outcome.created
      ? "Full-source export queued. Its review exception stays open until a person resolves it."
      : "This fallback was already queued. Nothing new was created." };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const confirmation = error.issues.find((issue) => issue.path[0] === "confirmed");
      return { status: "error", message: confirmation
        ? "Tick the confirmation before requesting a full-source export."
        : "Give a reason of 1 to 500 characters." };
    }
    console.error("[operator] full-source fallback failed", error);
    return { status: "error", message: "Something went wrong. Nothing was queued." };
  }
}
