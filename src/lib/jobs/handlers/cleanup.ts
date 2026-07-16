import { JobFailureError, type JobHandler } from "@/lib/jobs/types";
import { recordOperationalEventSafely } from "@/lib/observability/operational-events";
import {
  exportFileGraceCutoff,
  removeStorageObjectIfExists,
  shouldPurgeSourceMedia,
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
    const sourceVideo = project.sourceVideo;
    if (projectExpired && sourceVideo && shouldPurgeSourceMedia(sourceVideo.projects, now)) {
      const mediaKeys = [
        sourceVideo.storageKey,
        sourceVideo.audioKey,
        sourceVideo.thumbnailKey,
        sourceVideo.srtOverrideKey,
      ].filter((key): key is string => key !== null);
      for (const key of mediaKeys) {
        await removeStorageObjectIfExists(key);
        purgedSourceKeys.push(key);
      }
      if (mediaKeys.length > 0) {
        await prisma.sourceVideo.update({
          where: { id: sourceVideo.id },
          data: { storageKey: null, audioKey: null, thumbnailKey: null, srtOverrideKey: null },
        });
      }
    }
  } catch (error) {
    throw new JobFailureError(
      "STORAGE_UNAVAILABLE",
      "Retention cleanup couldn't reach storage and will retry.",
      { cause: error },
    );
  }

  if (exportRowsDeleted > 0 || purgedSourceKeys.length > 0) {
    await recordOperationalEventSafely(prisma, {
      workspaceId: project.workspaceId,
      category: "worker",
      eventType: "retention_cleanup",
      message: "Retention cleanup removed expired media from storage.",
      projectId: project.id,
      jobId: job.id,
      metadata: { projectExpired, exportObjectsRemoved, exportRowsDeleted, purgedSourceKeys },
    });
  }

  return {
    metadata: {
      projectExpired,
      exportObjectsRemoved,
      exportRowsDeleted,
      sourceMediaPurged: purgedSourceKeys.length > 0,
    },
  };
};
