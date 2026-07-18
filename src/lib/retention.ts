import { ProcessingJobType, type PrismaClient } from "@prisma/client";
import { env } from "@/lib/env";
import { enqueueJob } from "@/lib/jobs/queue";
import { getStorageProvider } from "@/lib/storage";

/**
 * Retention policy (see DECISIONS.md "Retention Reaper Purges Media, Keeps The Record"):
 * exported MP4s are deleted a grace period after their download link expires, and an expired
 * project's heavy media (source video, extracted audio, thumbnail, SRT override, exports) is
 * purged from storage. Database records — project, clips, scores, transcript, ledger — are kept
 * so the archive, billing history, and audit trails stay intact.
 */

export function exportFileRetentionGraceMs(): number {
  return env.EXPORT_FILE_RETENTION_GRACE_MS;
}

/** Exported files whose download link expired before this cutoff are eligible for deletion. */
export function exportFileGraceCutoff(now: Date): Date {
  return new Date(now.getTime() - exportFileRetentionGraceMs());
}

/**
 * Daily-bucketed so the same project can be re-swept on a later day when new exports age out,
 * while re-scans within one day dedupe to the same job row.
 */
export function cleanupIdempotencyKey(projectId: string, now: Date): string {
  return `cleanup:${projectId}:${now.toISOString().slice(0, 10)}`;
}

/**
 * Source media (video/audio/thumbnail) is keyed by source video and can be shared by several
 * projects. Only purge it when every referencing project has expired.
 */
export function shouldPurgeSourceMedia(
  projects: Array<{ expiresAt: Date | null }>,
  now: Date,
): boolean {
  return (
    projects.length > 0 && projects.every((p) => p.expiresAt !== null && p.expiresAt <= now)
  );
}

/** Idempotent storage removal: missing objects are fine (an earlier attempt already removed them). */
export async function removeStorageObjectIfExists(key: string): Promise<boolean> {
  const storage = getStorageProvider();
  if (!(await storage.exists(key))) {
    return false;
  }
  await storage.remove(key);
  return true;
}

/**
 * Scans for retention work and enqueues one CLEANUP job per project that has any. Called from the
 * worker loop on an interval (same shape as stale-job recovery). Idempotent: re-scans dedupe on
 * the daily idempotency key, and projects with nothing left to clean stop matching the scan.
 *
 * Note: an expired project sharing its source video with a still-active project keeps matching
 * the scan (its source keys stay non-null on purpose), costing one no-op job per day. Bounded and
 * harmless; the source is purged the day the last referencing project expires.
 */
export async function enqueueDueCleanupJobs(client: PrismaClient, now = new Date()) {
  const graceCutoff = exportFileGraceCutoff(now);
  const projectIds = new Set<string>();

  const staleFiles = await client.exportedFile.findMany({
    where: { downloadExpiresAt: { lt: graceCutoff }, exportJob: { isNot: null } },
    select: { exportJob: { select: { clip: { select: { projectId: true } } } } },
    take: 100,
  });
  for (const file of staleFiles) {
    const projectId = file.exportJob?.clip.projectId;
    if (projectId) {
      projectIds.add(projectId);
    }
  }

  const expiredProjects = await client.project.findMany({
    where: {
      expiresAt: { lte: now },
      OR: [
        {
          sourceVideo: {
            OR: [
              { storageKey: { not: null } },
              { audioKey: { not: null } },
              { thumbnailKey: { not: null } },
              { srtOverrideKey: { not: null } },
            ],
          },
        },
        { generatedClips: { some: { exportJobs: { some: { outputFileId: { not: null } } } } } },
      ],
    },
    select: { id: true },
    take: 50,
  });
  for (const project of expiredProjects) {
    projectIds.add(project.id);
  }

  let enqueued = 0;
  for (const projectId of projectIds) {
    const idempotencyKey = cleanupIdempotencyKey(projectId, now);
    const existing = await client.processingJob.findUnique({
      where: { idempotencyKey },
      select: { id: true },
    });
    if (existing) {
      continue;
    }
    await enqueueJob(client, { projectId, type: ProcessingJobType.CLEANUP, idempotencyKey });
    enqueued += 1;
  }

  return { scanned: projectIds.size, enqueued };
}

/**
 * Exported-file rows orphaned by clip/export-job cascade deletes have no project to attach a
 * CLEANUP job to, so the scan removes them directly once they are past grace.
 */
export async function sweepOrphanedExportedFiles(client: PrismaClient, now = new Date()) {
  const orphans = await client.exportedFile.findMany({
    where: { downloadExpiresAt: { lt: exportFileGraceCutoff(now) }, exportJob: { is: null } },
    select: { id: true, storageKey: true },
    take: 50,
  });

  let objectsRemoved = 0;
  for (const orphan of orphans) {
    if (await removeStorageObjectIfExists(orphan.storageKey)) {
      objectsRemoved += 1;
    }
    await client.exportedFile.delete({ where: { id: orphan.id } });
  }

  return { rowsDeleted: orphans.length, objectsRemoved };
}
