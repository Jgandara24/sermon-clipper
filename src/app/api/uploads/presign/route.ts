import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireApiWorkspace } from "@/lib/api/auth";
import { apiData, apiError } from "@/lib/api/response";
import { formatBytes, planForCode } from "@/lib/billing/plans";
import { createSignedUploadUrl, DEFAULT_UPLOAD_URL_TTL_SECONDS } from "@/lib/media/signed-url";
import {
  recordOperationalEvent,
  recordOperationalEventSafely,
} from "@/lib/observability/operational-events";
import { prisma } from "@/lib/prisma";
import { checkUploadPresignLimit } from "@/lib/rate-limit";

const bodySchema = z.object({
  filename: z.string().trim().min(1).max(255),
  size: z.number().int().positive(),
  type: z.string().trim().min(1).max(255).optional(),
});

export async function POST(request: Request) {
  const auth = await requireApiWorkspace("IMPORT_MEDIA");
  if ("error" in auth) return auth.error;
  const { workspace } = auth;

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return apiError("INVALID_FILE_TYPE", "That file isn't a video we can read.");
  }

  const plan = planForCode(workspace.planCode);
  if (parsed.data.size > plan.maxUploadBytes) {
    await recordOperationalEventSafely(prisma, {
      workspaceId: workspace.id,
      category: "upload",
      eventType: "upload_rejected_plan_limit",
      severity: "warning",
      message: "Upload presign rejected because file size exceeded the workspace plan limit.",
      metadata: {
        filename: parsed.data.filename,
        requestedBytes: parsed.data.size,
        maxBytes: plan.maxUploadBytes,
        planCode: plan.code,
      },
    });
    return apiError(
      "PLAN_LIMIT_EXCEEDED",
      `${plan.name} plan uploads are limited to ${formatBytes(plan.maxUploadBytes)}.`,
      { status: 413 },
    );
  }

  if (workspace.minuteBalance.lessThanOrEqualTo(0)) {
    await recordOperationalEventSafely(prisma, {
      workspaceId: workspace.id,
      category: "billing",
      eventType: "upload_rejected_insufficient_minutes",
      severity: "warning",
      message: "Upload presign rejected because the workspace had no processing minutes.",
      metadata: {
        filename: parsed.data.filename,
        minuteBalance: workspace.minuteBalance.toString(),
      },
    });
    return apiError(
      "INSUFFICIENT_MINUTES",
      `This needs minutes to process; you have ${workspace.minuteBalance.toString()}.`,
      { status: 402 },
    );
  }

  const rateLimit = await checkUploadPresignLimit(prisma, workspace.id);
  if (!rateLimit.allowed) {
    await recordOperationalEventSafely(prisma, {
      workspaceId: workspace.id,
      category: "upload",
      eventType: "upload_rejected_rate_limited",
      severity: "warning",
      message: "Upload presign rejected by the workspace hourly rate limit.",
      metadata: {
        filename: parsed.data.filename,
        reason: rateLimit.reason,
        limit: rateLimit.limit,
        current: rateLimit.current,
      },
    });
    return apiError("RATE_LIMITED", rateLimit.message, { status: 429, retryable: true });
  }

  const uploadId = randomUUID();
  // This event is also the rate-limit counter (checkUploadPresignLimit counts it), so it must
  // fail closed: if the counter can't be written, no URL is issued — otherwise a failing events
  // table would silently disable the hourly cap while presigns keep flowing.
  try {
    await recordOperationalEvent(prisma, {
      workspaceId: workspace.id,
      category: "upload",
      eventType: "upload_presigned",
      message: "Signed upload URL issued.",
      metadata: {
        uploadId,
        filename: parsed.data.filename,
        requestedBytes: parsed.data.size,
        maxBytes: plan.maxUploadBytes,
        planCode: plan.code,
      },
    });
  } catch (error) {
    console.error("[uploads] failed to record presign counter event", error);
    return apiError("INTERNAL_ERROR", "Uploads are briefly unavailable — try again in a minute.", {
      status: 500,
      retryable: true,
    });
  }

  return apiData({
    uploadId,
    uploadUrl: createSignedUploadUrl({ uploadId, workspaceId: workspace.id, maxBytes: plan.maxUploadBytes }),
    method: "PUT",
    maxBytes: plan.maxUploadBytes,
    expiresInSeconds: DEFAULT_UPLOAD_URL_TTL_SECONDS,
  });
}
