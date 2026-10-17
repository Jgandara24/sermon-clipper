import { getStorageProvider, storageProviderKind } from "@/lib/storage";
import { multipartUploadSettings } from "@/lib/uploads/multipart-config";
import { registerMultipartUpload } from "@/lib/uploads/multipart-session";
import { multipartErrorResponse } from "@/lib/uploads/multipart-response";
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
  size: z.number().int().positive().safe(),
  transport: z.literal("relay").optional(),
  type: z.string().trim().min(1).max(255).optional(),
});

export async function POST(request: Request) {
  const auth = await requireApiWorkspace("IMPORT_MEDIA");
  if ("error" in auth) return auth.error!;
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

  if (storageProviderKind() === "s3" && parsed.data.transport !== "relay") {
    try {
      const settings = multipartUploadSettings();
      if (settings) {
        const expiresAt = new Date(Date.now() + settings.lifetimeSeconds * 1000);
        const row = await registerMultipartUpload(prisma, getStorageProvider(), {
          id: uploadId, workspaceId: workspace.id, filename: parsed.data.filename,
          totalBytes: parsed.data.size, partBytes: settings.partBytes, expiresAt,
        });
        return apiData({ uploadId: row.id, transport: "multipart", partBytes: Number(row.partBytes),
          totalBytes: Number(row.totalBytes), expiresAt: row.expiresAt.toISOString() });
      }
    } catch (error) { return multipartErrorResponse(error); }
  }

  return apiData({
    transport: "relay",
    uploadId,
    uploadUrl: createSignedUploadUrl({ uploadId, workspaceId: workspace.id, maxBytes: plan.maxUploadBytes }),
    method: "PUT",
    maxBytes: plan.maxUploadBytes,
    expiresInSeconds: DEFAULT_UPLOAD_URL_TTL_SECONDS,
  });
}
