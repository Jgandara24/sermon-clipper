"use server";

import { ClipApprovalState } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { decideClipApproval } from "@/lib/approval";
import { prisma } from "@/lib/prisma";

const reviewDecisionSchema = z.object({
  token: z.string().min(20),
  decision: z.enum(["approve", "changes"]),
  approverName: z.string().trim().max(80).optional().or(z.literal("")),
  comment: z.string().trim().max(1000).optional().or(z.literal("")),
});

export async function decideClipReviewAction(formData: FormData) {
  const parsed = reviewDecisionSchema.safeParse({
    token: formData.get("token"),
    decision: formData.get("decision"),
    approverName: formData.get("approverName"),
    comment: formData.get("comment"),
  });

  if (!parsed.success) {
    redirect("/");
  }

  const state =
    parsed.data.decision === "approve"
      ? ClipApprovalState.APPROVED
      : ClipApprovalState.CHANGES_REQUESTED;

  await decideClipApproval({
    prisma,
    reviewToken: parsed.data.token,
    state,
    approverName: parsed.data.approverName || null,
    comment: parsed.data.comment || null,
  });

  revalidatePath(`/review/${parsed.data.token}`);
  redirect(`/review/${parsed.data.token}?saved=1`);
}
