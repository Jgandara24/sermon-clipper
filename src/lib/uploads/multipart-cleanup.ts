import type { PrismaClient } from "@prisma/client";
import type { StorageProvider } from "@/lib/storage/types";
import { abortMultipartUpload } from "./multipart-session";

/** The durable registry, not the object prefix, owns unfinished multipart uploads. */
export async function purgeExpiredMultipartUploads(prisma: PrismaClient, storage: StorageProvider,
  options: { now?: Date; limit?: number } = {}) {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 100;
  if (!Number.isFinite(now.getTime()) || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("MULTIPART_INVALID_CLEANUP_OPTIONS");
  }
  const result = { scanned: 0, aborted: 0, raced: 0, failed: 0, needsReview: 0 };
  if (!storage.multipart) return result;
  const storageIdentity = storage.getStorageIdentity?.();
  if (!storageIdentity) throw new Error("MULTIPART_STORAGE_UNAVAILABLE");
  const where = { storageIdentity, expiresAt: { lte: now } };
  const rows = await prisma.multipartUpload.findMany({
    where: { ...where, state: { in: ["NEW", "UPLOADING"] } },
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }], take: limit,
    select: { id: true, workspaceId: true },
  });
  result.scanned = rows.length;
  for (const row of rows) {
    try {
      await abortMultipartUpload(prisma, storage, row);
      result.aborted++;
    } catch (error) {
      if (error instanceof Error && ["MULTIPART_UPLOAD_STATE_CHANGED", "MULTIPART_UPLOAD_NOT_ABORTABLE"].includes(error.message)) {
        result.raced++;
      } else {
        // Abort retains UNCERTAIN (or its active claim on database failure). Do not guess remote deletion.
        result.failed++;
      }
    }
  }
  result.needsReview = await prisma.multipartUpload.count({ where: { ...where,
    state: { in: ["STARTING", "COMPLETING", "ABORTING", "UNCERTAIN"] },
  } });
  return result;
}
