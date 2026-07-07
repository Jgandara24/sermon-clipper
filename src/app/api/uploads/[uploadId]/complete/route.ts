import { SourceOrigin } from "@prisma/client";
import { z } from "zod";
import { requireApiWorkspace } from "@/lib/api/auth";
import { apiData, apiError } from "@/lib/api/response";
import { recordOperationalEventSafely } from "@/lib/observability/operational-events";
import { prisma } from "@/lib/prisma";
import { getStorageProvider } from "@/lib/storage";

const bodySchema = z.object({
  filename: z.string().trim().min(1).max(255),
  size: z.number().int().positive(),
  type: z.string().trim().max(255).optional(),
});

function sanitizeFilename(filename: string) {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ uploadId: string }> },
) {
  const auth = await requireApiWorkspace("IMPORT_MEDIA");
  if ("error" in auth) return auth.error;
  const { workspace } = auth;

  const { uploadId } = await params;
  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return apiError("INVALID_FILE_TYPE", "That file isn't a video we can read.");
  }

  const storage = getStorageProvider();
  const tempKey = `tmp/${workspace.id}/${uploadId}`;

  if (!(await storage.exists(tempKey))) {
    await recordOperationalEventSafely(prisma, {
      workspaceId: workspace.id,
      category: "upload",
      eventType: "upload_complete_missing_temp",
      severity: "warning",
      message: "Upload completion failed because temporary storage object was missing.",
      metadata: { uploadId, filename: parsed.data.filename },
    });
    return apiError("UPLOAD_INTERRUPTED", "Upload lost connection — resume?");
  }

  const actualSize = await storage.size(tempKey);
  if (actualSize !== parsed.data.size) {
    await recordOperationalEventSafely(prisma, {
      workspaceId: workspace.id,
      category: "upload",
      eventType: "upload_complete_size_mismatch",
      severity: "warning",
      message: "Upload completion failed because reported size did not match stored size.",
      metadata: {
        uploadId,
        filename: parsed.data.filename,
        reportedBytes: parsed.data.size,
        actualBytes: actualSize,
      },
    });
    return apiError("UPLOAD_INTERRUPTED", "Upload lost connection — resume?");
  }

  const permanentKey = `src/${workspace.id}/${uploadId}-${sanitizeFilename(parsed.data.filename)}`;
  await storage.move(tempKey, permanentKey);

  const sourceVideo = await prisma.sourceVideo.create({
    data: {
      workspaceId: workspace.id,
      origin: SourceOrigin.UPLOAD,
      filename: parsed.data.filename,
      sizeBytes: BigInt(actualSize),
      storageKey: permanentKey,
      language: "en",
    },
  });
  await recordOperationalEventSafely(prisma, {
    workspaceId: workspace.id,
    category: "upload",
    eventType: "upload_completed",
    message: "Upload completed and source video was created.",
    metadata: {
      uploadId,
      sourceVideoId: sourceVideo.id,
      filename: parsed.data.filename,
      bytes: actualSize,
      storageKey: permanentKey,
    },
  });

  return apiData({ sourceVideoId: sourceVideo.id });
}
