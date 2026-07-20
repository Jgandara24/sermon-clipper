"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireCurrentUser, requirePrimaryWorkspacePermission } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { updateWorkspaceSettings } from "@/lib/workspace-settings";

const facebookConnectionSchema = z.object({
  pageId: z
    .string()
    .trim()
    .regex(/^\d+$/, "Facebook Page ID must be numeric.")
    .optional()
    .or(z.literal("")),
  autoPostEnabled: z.coerce.boolean(),
});

/**
 * Tier 3 go-live gate (DECISIONS.md, "Tier 3 Freeze Lifted"): flipping `autoPostEnabled` to
 * true is the one action in this codebase that makes a real, scheduled Graph API call happen
 * later, unattended, from the worker. OWNER-only (MANAGE_FACEBOOK_CONNECTION), deliberately
 * stricter than every other workspace setting.
 */
export async function updateFacebookConnectionAction(formData: FormData) {
  const user = await requireCurrentUser();
  const membership = await requirePrimaryWorkspacePermission(user.id, "MANAGE_FACEBOOK_CONNECTION");

  const parsed = facebookConnectionSchema.safeParse({
    pageId: formData.get("pageId") ?? undefined,
    autoPostEnabled: formData.get("autoPostEnabled") === "on",
  });

  if (!parsed.success) {
    redirect("/app/settings?facebook=invalid");
  }

  const pageId = parsed.data.pageId?.trim() || null;

  await updateWorkspaceSettings(prisma, membership.workspace.id, (settings) => ({
    ...settings,
    facebookConnection: {
      pageId,
      // A workspace can't go live without a Page ID configured, regardless of the
      // checkbox — closes the "checked the box, forgot to set the page" gap.
      autoPostEnabled: parsed.data.autoPostEnabled && pageId !== null,
    },
  }));

  revalidatePath("/app/settings");
  redirect("/app/settings?facebook=saved");
}
