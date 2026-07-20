"use server";

import { SocialPlatform } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireCurrentUser, requirePrimaryWorkspacePermission } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const updatePlatformSchema = z.object({
  scheduledPostId: z.string().uuid(),
  platform: z.enum([
    SocialPlatform.FACEBOOK,
    SocialPlatform.INSTAGRAM,
    SocialPlatform.TIKTOK,
    SocialPlatform.YOUTUBE,
  ]),
});

/**
 * Tier 2 only records a platform preference on the calendar slot — it does not post
 * anywhere. Facebook is the only platform with a real posting integration planned;
 * Instagram/TikTok/YouTube are selectable now so the schedule is ready when they land.
 */
export async function updateScheduledPostPlatformAction(formData: FormData) {
  const user = await requireCurrentUser();
  const membership = await requirePrimaryWorkspacePermission(user.id, "MANAGE_SCHEDULE");

  const parsed = updatePlatformSchema.safeParse({
    scheduledPostId: formData.get("scheduledPostId"),
    platform: formData.get("platform"),
  });

  if (!parsed.success) {
    redirect("/app/calendar?error=invalid");
  }

  // Nonexistent and cross-workspace IDs get the same denial so the response
  // doesn't reveal whether the post exists.
  const scheduledPost = await prisma.scheduledPost.findUnique({
    where: { id: parsed.data.scheduledPostId },
  });
  if (!scheduledPost || scheduledPost.workspaceId !== membership.workspace.id) {
    redirect("/app/calendar?error=invalid");
  }

  await prisma.scheduledPost.update({
    where: { id: parsed.data.scheduledPostId },
    data: { platform: parsed.data.platform },
  });

  revalidatePath("/app/calendar");
}
