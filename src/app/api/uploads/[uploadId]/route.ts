import { apiData, apiError } from "@/lib/api/response";
import { verifySignedUploadUrl } from "@/lib/media/signed-url";
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
    return apiError("UPLOAD_INTERRUPTED", "Upload lost connection — resume?");
  }

  const storage = getStorageProvider();
  const tempKey = `tmp/${verified.workspaceId}/${uploadId}`;

  try {
    const bytesWritten = await storage.writeFromWebStream(tempKey, request.body, verified.maxBytes);
    return apiData({ uploadId, bytesWritten });
  } catch (error) {
    if (error instanceof StorageLimitExceededError) {
      return apiError("PLAN_LIMIT_EXCEEDED", "That upload is larger than this workspace plan allows.", {
        status: 413,
      });
    }
    console.error("[uploads] failed to write upload", error);
    return apiError("STORAGE_UNAVAILABLE", "Storage hiccup — try again in a minute.", {
      status: 500,
      retryable: true,
    });
  }
}
