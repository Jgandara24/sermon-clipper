import { requireApiWorkspace } from "@/lib/api/auth";
import { apiData, apiError } from "@/lib/api/response";
import { MAX_UPLOAD_BYTES } from "@/lib/limits";
import { getStorageProvider, StorageLimitExceededError } from "@/lib/storage";

export async function PUT(request: Request, { params }: { params: Promise<{ uploadId: string }> }) {
  const auth = await requireApiWorkspace();
  if ("error" in auth) return auth.error;
  const { workspace } = auth;

  const { uploadId } = await params;
  if (!request.body) {
    return apiError("UPLOAD_INTERRUPTED", "Upload lost connection — resume?");
  }

  const storage = getStorageProvider();
  const tempKey = `tmp/${workspace.id}/${uploadId}`;

  try {
    const bytesWritten = await storage.writeFromWebStream(tempKey, request.body, MAX_UPLOAD_BYTES);
    return apiData({ uploadId, bytesWritten });
  } catch (error) {
    if (error instanceof StorageLimitExceededError) {
      return apiError("FILE_TOO_LARGE", "Videos up to 5 GB for now.", { status: 413 });
    }
    console.error("[uploads] failed to write upload", error);
    return apiError("STORAGE_UNAVAILABLE", "Storage hiccup — try again in a minute.", {
      status: 500,
      retryable: true,
    });
  }
}
