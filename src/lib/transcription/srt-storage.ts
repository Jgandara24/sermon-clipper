import type { PrismaClient } from "@prisma/client";
import { recordOperationalEventSafely } from "@/lib/observability/operational-events";
import { getStorageProvider, type StorageProvider } from "@/lib/storage";

export const SRT_STORAGE_PREFIX = "srt/";
export const SRT_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
// A stalled request must expire long before an unreferenced staging object can be swept.
export const SRT_STAGE_LIFETIME_MS = 15 * 60 * 1000;

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const managedKey = new RegExp(`^srt/(${uuid})/(${uuid})(?:/${uuid})?\\.srt$`, "i");

/** Handles both the old fixed key and new immutable keys. Ignore other objects under srt/. */
function ownerOf(key: string) {
  const match = managedKey.exec(key);
  return match ? { workspaceId: match[1], sourceVideoId: match[2] } : null;
}

/**
 * Used after a failed upload and by the age-based recovery sweep. Check references under the
 * same source lock as the upload, including after an uncertain COMMIT response. A database
 * outage leaves the object for recovery; it must never turn into a blind storage delete.
 */
export async function discardUnreferencedSrt(
  client: PrismaClient,
  key: string,
  storage: StorageProvider = getStorageProvider(),
): Promise<"removed" | "kept" | "failed"> {
  const owner = ownerOf(key);
  if (!owner) return "kept";
  try {
    return await client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM source_videos WHERE id = ${owner.sourceVideoId}::uuid FOR UPDATE`;
      const source = await tx.sourceVideo.findUnique({ where: { id: owner.sourceVideoId }, select: { workspaceId: true } });
      if (source && source.workspaceId !== owner.workspaceId) return "kept";
      // Protect shared pointers too. New uploads never reactivate an old key: each writes a UUID.
      const references = await tx.sourceVideo.count({ where: { OR: [
        { srtOverrideKey: key }, { storageKey: key }, { audioKey: key }, { thumbnailKey: key },
      ] } });
      if (references > 0) return "kept";
      // A worker may have captured the former pointer before the upload committed. Let it finish
      // or fail its own source-version check before removing those bytes.
      const running = await tx.processingJob.count({ where: {
        project: { sourceVideoId: owner.sourceVideoId }, state: "RUNNING",
      } });
      if (running > 0) return "kept";
      await storage.remove(key); // Idempotent for a missing object in both providers.
      return "removed";
    }, { timeout: 15000 });
  } catch {
    // No workspace/project link: storage keys belong only in platform operations, never in the
    // church event feed. Warning severity also avoids dispatching an email from a failed cleanup.
    await recordOperationalEventSafely(client, {
      category: "upload", eventType: "srt_storage_cleanup_pending", severity: "warning",
      message: "An unused subtitle file needs another cleanup attempt.",
      metadata: { sourceVideoId: owner.sourceVideoId, storageKey: key },
    });
    return "failed";
  }
}

/** Recovers failed cleanup and process crashes without an object-journal table. */
export async function purgeAbandonedSrts(client: PrismaClient, now = new Date(), storage = getStorageProvider()) {
  const cutoff = new Date(now.getTime() - SRT_ORPHAN_GRACE_MS);
  const objects = await storage.list(SRT_STORAGE_PREFIX);
  const result = { scanned: objects.length, removed: 0, kept: 0, failed: 0 };
  for (const object of objects) {
    const modifiedAt = object.lastModified.getTime();
    // The S3 adapter uses epoch zero when LastModified is absent. Unknown age is not old age.
    if (!ownerOf(object.key) || !Number.isFinite(modifiedAt) || modifiedAt <= 0 || object.lastModified > cutoff) {
      result.kept += 1;
      continue;
    }
    const outcome = await discardUnreferencedSrt(client, object.key, storage);
    result[outcome] += 1;
  }
  return result;
}
