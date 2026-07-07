import { apiData, apiError } from "@/lib/api/response";
import { verifySignedUploadUrl } from "@/lib/media/signed-url";
import { recordOperationalEventSafely } from "@/lib/observability/operational-events";
import { prisma } from "@/lib/prisma";
import { getStorageProvider, StorageLimitExceededError } from "@/lib/storage";

export async function PUT(request: Request, { params }: { params: Promise<{ uploadId: string }> }) {
  const { uploadId } = await params;
  const url = new URL(request.url);
  const verified = verifySignedUploadUrl(uploadId, url.searchParams);
  if (!verified.ok) {
    return apiError(
      verified.reason === "expired" ? "SIGNED_URL_EXPIRED" : "PERMISSION_DENIED",
      verified.reason === "expired" ? "This upload link expired. Request a fresh upload." : "Invalid upload link.",
      { status: verified.reason === "expired" ? 410 : 403, retryable: verified.reason === "expired" },
    );
  }

  if (!request.body) {
    await recordOperationalEventSafely(prisma, {
      workspaceId: verified.workspaceId,
      category: "upload",
      eventType: "upload_interrupted",
      severity: "warning",
      message: "Upload request did not include a request body.",
      metadata: { uploadId },
    });
    return apiError("UPLOAD_INTERRUPTED", "Upload lost connection — resume?");
  }

  const storage = getStorageProvider();
  const tempKey = `tmp/${verified.workspaceId}/${uploadId}`;

  try {
    const bytesWritten = await storage.writeFromWebStream(tempKey, request.body, verified.maxBytes);
    await recordOperationalEventSafely(prisma, {
      workspaceId: verified.workspaceId,
      category: "upload",
      eventType: "upload_bytes_written",
      message: "Uploaded bytes written to temporary storage.",
      metadata: { uploadId, bytesWritten, maxBytes: verified.maxBytes },
    });
    return apiData({ uploadId, bytesWritten });
  } catch (error) {
    if (error instanceof StorageLimitExceededError) {
      await recordOperationalEventSafely(prisma, {
        workspaceId: verified.workspaceId,
        category: "upload",
        eventType: "upload_rejected_signed_limit",
        severity: "warning",
        message: "Upload stream exceeded the signed plan byte limit.",
        metadata: { uploadId, maxBytes: verified.maxBytes },
      });
      return apiError("PLAN_LIMIT_EXCEEDED", "That upload is larger than this workspace plan allows.", {
        status: 413,
      });
    }
    console.error("[uploads] failed to write upload", error);
    await recordOperationalEventSafely(prisma, {
      workspaceId: verified.workspaceId,
      category: "upload",
      eventType: "upload_storage_failed",
      severity: "error",
      message: "Upload failed while writing to storage.",
      metadata: { uploadId, error: error instanceof Error ? error.message : String(error) },
    });
    return apiError("STORAGE_UNAVAILABLE", "Storage hiccup — try again in a minute.", {
      status: 500,
      retryable: true,
    });
  }
}
