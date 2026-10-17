import type { PrismaClient } from "@prisma/client";
import type { StorageProvider } from "@/lib/storage/types";
import { recoverMultipartCancellation, recoverMultipartCompletion, recoverMultipartInitiation } from "./multipart-session";

/** Bounded read-only provider recovery. The cursor prevents unresolved old rows from starving later rows. */
export async function reconcileMultipartUploads(prisma: PrismaClient, storage: StorageProvider,
  options: { afterId?: string; limit?: number } = {}) {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("MULTIPART_INVALID_RECOVERY_LIMIT");
  const result = { scanned: 0, recovered: 0, pending: 0, failed: 0, nextCursor: null as string | null };
  if (!storage.multipart) return result;
  const storageIdentity = storage.getStorageIdentity?.();
  if (!storageIdentity) throw new Error("MULTIPART_STORAGE_UNAVAILABLE");
  const rows = await prisma.multipartUpload.findMany({ where: { storageIdentity,
    state: { in: ["STARTING", "COMPLETING", "ABORTING", "UNCERTAIN"] },
    ...(options.afterId ? { id: { gt: options.afterId } } : {}),
  }, orderBy: { id: "asc" }, take: limit, select: { id: true, workspaceId: true, state: true, uncertainStage: true } });
  result.scanned = rows.length;
  for (const row of rows) {
    try {
      const stage = row.state === "UNCERTAIN" ? row.uncertainStage : row.state;
      if (stage === "STARTING") await recoverMultipartInitiation(prisma, storage, row);
      else if (stage === "COMPLETING") await recoverMultipartCompletion(prisma, storage, row);
      else if (stage === "ABORTING") await recoverMultipartCancellation(prisma, storage, row);
      else throw new Error("MULTIPART_INVALID_RECOVERY_STATE");
      result.recovered++;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (["MULTIPART_INITIATION_NOT_CONFIRMED", "MULTIPART_COMPLETION_NOT_CONFIRMED", "MULTIPART_CANCELLATION_NOT_CONFIRMED",
        "MULTIPART_INITIATION_NOT_RECOVERABLE", "MULTIPART_COMPLETION_NOT_RECOVERABLE", "MULTIPART_CANCELLATION_NOT_RECOVERABLE",
        "MULTIPART_UPLOAD_STATE_CHANGED"].includes(message)) result.pending++;
      else result.failed++;
    }
  }
  if (rows.length === limit) result.nextCursor = rows[rows.length - 1].id;
  return result;
}
