import { z } from "zod";
import { requireApiWorkspace } from "@/lib/api/auth";
import { apiData, apiError } from "@/lib/api/response";
import { buildReviewUrl } from "@/lib/approval";
import { requestClipApproval } from "@/lib/approval";
import { prisma } from "@/lib/prisma";
import { assertWorkspaceScope } from "@/lib/project-service";

const requestBodySchema = z.object({
  reviewerEmail: z.string().trim().email().optional().or(z.literal("")),
  reviewerPhone: z.string().trim().min(7).max(32).optional().or(z.literal("")),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiWorkspace("REQUEST_APPROVAL");
  if ("error" in auth) return auth.error;

  const json = await request.json().catch(() => ({}));
  const parsed = requestBodySchema.safeParse(json ?? {});
  if (!parsed.success) {
    return apiError("INVALID_REQUEST", "Enter a valid reviewer email or phone number.");
  }

  const { id } = await params;
  const clip = await prisma.generatedClip.findUnique({ where: { id } });
  if (!clip) {
    return apiError("PERMISSION_DENIED", "You don't have access to that workspace.", { status: 404 });
  }
  try {
    assertWorkspaceScope(clip.workspaceId, auth.workspace.id, "clip");
  } catch {
    return apiError("PERMISSION_DENIED", "You don't have access to that workspace.", { status: 403 });
  }

  const approval = await requestClipApproval({
    prisma,
    clipId: clip.id,
    workspaceId: auth.workspace.id,
    requesterId: auth.user.id,
    reviewerEmail: parsed.data.reviewerEmail || null,
    reviewerPhone: parsed.data.reviewerPhone || null,
  });
  const notifications = await prisma.approvalNotification.findMany({
    where: { approvalId: approval.id },
    orderBy: { createdAt: "desc" },
    take: 2,
  });

  return apiData({
    id: approval.id,
    state: approval.state,
    reviewUrl: buildReviewUrl(approval.reviewToken),
    reviewTokenExpiresAt: approval.reviewTokenExpiresAt,
    notifications: notifications.map((notification) => ({
      channel: notification.channel,
      recipient: notification.recipient,
      status: notification.status,
      provider: notification.provider,
      errorMessage: notification.errorMessage,
    })),
  });
}
