import { describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    scheduledPost: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("@/lib/auth", () => ({
  requireCurrentUser: vi.fn(async () => ({ id: "user-1" })),
  requirePrimaryWorkspacePermission: vi.fn(async () => ({
    role: "OWNER",
    workspace: { id: "ws-1" },
  })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

import { prisma } from "@/lib/prisma";
import { updateScheduledPostPlatformAction } from "@/app/actions/schedule";

function platformFormData(scheduledPostId: string) {
  const formData = new FormData();
  formData.set("scheduledPostId", scheduledPostId);
  formData.set("platform", "FACEBOOK");
  return formData;
}

const FORGED_ID = "11111111-2222-4333-8444-555555555555";

describe("updateScheduledPostPlatformAction denial paths", () => {
  it("redirects to the calendar error state for a nonexistent scheduledPostId", async () => {
    (prisma.scheduledPost.findUnique as Mock).mockResolvedValue(null);

    await expect(updateScheduledPostPlatformAction(platformFormData(FORGED_ID))).rejects.toThrow(
      /^REDIRECT:\/app\/calendar\?error=invalid$/,
    );

    expect(prisma.scheduledPost.update).not.toHaveBeenCalled();
  });

  it("redirects identically for a post belonging to another workspace", async () => {
    (prisma.scheduledPost.findUnique as Mock).mockResolvedValue({
      id: FORGED_ID,
      workspaceId: "ws-other",
    });

    await expect(updateScheduledPostPlatformAction(platformFormData(FORGED_ID))).rejects.toThrow(
      /^REDIRECT:\/app\/calendar\?error=invalid$/,
    );

    expect(prisma.scheduledPost.update).not.toHaveBeenCalled();
  });

  it("updates the platform when the post belongs to the caller's workspace", async () => {
    (prisma.scheduledPost.findUnique as Mock).mockResolvedValue({
      id: FORGED_ID,
      workspaceId: "ws-1",
    });
    (prisma.scheduledPost.update as Mock).mockResolvedValue({});

    await updateScheduledPostPlatformAction(platformFormData(FORGED_ID));

    expect(prisma.scheduledPost.update).toHaveBeenCalledWith({
      where: { id: FORGED_ID },
      data: { platform: "FACEBOOK" },
    });
  });
});
