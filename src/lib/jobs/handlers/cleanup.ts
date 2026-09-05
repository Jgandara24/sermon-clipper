import { JobFailureError, type JobHandler } from "@/lib/jobs/types";
import { recordOperationalEventSafely } from "@/lib/observability/operational-events";
import {
  exportFileGraceCutoff,
  lockSourceVideoForRetention,
  removeStorageObjectIfExists,
  shouldPurgeSourceMedia,
  sourceRetentionDeletionEnabled,
} from "@/lib/retention";

/**
 * Retention reaper for one project: deletes exported files past the download-expiry grace period
 * (any age once the project itself has expired), and purges an expired project's source media
 * from storage once no still-active project shares that source video. Database records are kept —
 * this deletes heavy media objects, not history. Safe to re-run: removals are exists-guarded and
 * rows are deleted as their objects go.
 */
export const runCleanupJob: JobHandler = async ({ job, prisma }) => {
  const now = new Date();
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: job.projectId },
    include: {
      sourceVideo: { include: { projects: { select: { expiresAt: true } } } },
    },
  });
  const projectExpired = project.expiresAt !== null && project.expiresAt <= now;

  let exportObjectsRemoved = 0;
  let exportRowsDeleted = 0;
  const purgedSourceKeys: string[] = [];
  /** Populated instead of purgedSourceKeys while SOURCE_RETENTION_DELETION_ENABLED is not "true". */
  const wouldPurgeSourceKeys: string[] = [];
  let sourcePurgeSkippedReason: string | null = null;

  try {
    // Exported files: past-grace files always; every export once the project has expired.
    const staleFiles = await prisma.exportedFile.findMany({
      where: {
        exportJob: { is: { clip: { projectId: project.id } } },
        ...(projectExpired ? {} : { downloadExpiresAt: { lt: exportFileGraceCutoff(now) } }),
      },
      select: { id: true, storageKey: true },
      take: 200,
    });
    for (const file of staleFiles) {
      if (await removeStorageObjectIfExists(file.storageKey)) {
        exportObjectsRemoved += 1;
      }
      // ExportJob.outputFileId is SetNull on this delete, so export history survives.
      await prisma.exportedFile.delete({ where: { id: file.id } });
      exportRowsDeleted += 1;
    }

    // Source media: only after every project referencing this source video has expired.
    //
    // The whole decision happens under a row lock on the source video, and the objects are
    // deleted before the lock is released. The unlocked version had a live race: this job could
    // read a project as expired while an operator concurrently extended retention on a sibling
    // project sharing the same source, and then delete media that sibling still needed. The
    // expiry values are therefore re-read inside the transaction, not trusted from the read above.
    const sourceVideo = project.sourceVideo;
    if (projectExpired && sourceVideo) {
      await prisma.$transaction(async (tx) => {
        if (!(await lockSourceVideoForRetention(tx, sourceVideo.id))) return;

        const referencing = await tx.project.findMany({
          where: { sourceVideoId: sourceVideo.id },
          select: { expiresAt: true },
        });
        if (!shouldPurgeSourceMedia(referencing, now)) {
          sourcePurgeSkippedReason = "a project sharing this source video is still active";
          return;
        }

        const current = await tx.sourceVideo.findUnique({
          where: { id: sourceVideo.id },
          select: {
            storageKey: true,
            audioKey: true,
            thumbnailKey: true,
            srtOverrideKey: true,
          },
        });
        const mediaKeys = [
          current?.storageKey,
          current?.audioKey,
          current?.thumbnailKey,
          current?.srtOverrideKey,
        ].filter((key): key is string => typeof key === "string");
        if (mediaKeys.length === 0) return;

        // Report-only until the switch is exactly "true". Nothing is deleted and no key is
        // nulled, so a report-only cycle can run in production and be read back from the
        // operational event before anyone arms the real thing.
        if (!sourceRetentionDeletionEnabled()) {
          wouldPurgeSourceKeys.push(...mediaKeys);
          return;
        }

        for (const key of mediaKeys) {
          await removeStorageObjectIfExists(key);
          purgedSourceKeys.push(key);
        }
        await tx.sourceVideo.update({
          where: { id: sourceVideo.id },
          data: { storageKey: null, audioKey: null, thumbnailKey: null, srtOverrideKey: null },
        });
      });
    }
  } catch (error) {
    throw new JobFailureError(
      "STORAGE_UNAVAILABLE",
      "Retention cleanup couldn't reach storage and will retry.",
      { cause: error },
    );
  }

  if (exportRowsDeleted > 0 || purgedSourceKeys.length > 0 || wouldPurgeSourceKeys.length > 0) {
    await recordOperationalEventSafely(prisma, {
      workspaceId: project.workspaceId,
      category: "worker",
      eventType:
        wouldPurgeSourceKeys.length > 0 ? "retention_cleanup_report_only" : "retention_cleanup",
      message:
        wouldPurgeSourceKeys.length > 0
          ? "Retention cleanup reported the source media it would delete. Deletion is switched off, so nothing was removed."
          : "Retention cleanup removed expired media from storage.",
      projectId: project.id,
      jobId: job.id,
      metadata: {
        projectExpired,
        exportObjectsRemoved,
        exportRowsDeleted,
        purgedSourceKeys,
        wouldPurgeSourceKeys,
        sourceDeletionEnabled: sourceRetentionDeletionEnabled(),
        sourcePurgeSkippedReason,
      },
    });
  }

  return {
    metadata: {
      projectExpired,
      exportObjectsRemoved,
      exportRowsDeleted,
      sourceMediaPurged: purgedSourceKeys.length > 0,
      sourceMediaReportOnly: wouldPurgeSourceKeys.length,
      sourceDeletionEnabled: sourceRetentionDeletionEnabled(),
    },
  };
};
