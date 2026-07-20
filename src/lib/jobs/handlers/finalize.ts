import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Prisma, ProcessingJobType, ProjectStatus, SourceOrigin, type SourceVideo } from "@prisma/client";
import { estimateProcessingMinutes, planForCode, type PlanLimits } from "@/lib/billing/plans";
import { enqueueJob } from "@/lib/jobs/queue";
import { JobFailureError, type JobHandler } from "@/lib/jobs/types";
import { MAX_UPLOAD_BYTES, MAX_VIDEO_DURATION_S } from "@/lib/limits";
import { probeVideoFile } from "@/lib/media/probe";
import { downloadYtDlpVideo, fetchYtDlpMetadata, YtDlpFileTooLargeError } from "@/lib/media/ytdlp";
import { getStorageProvider, type StorageProvider } from "@/lib/storage";
import { InsufficientBalanceError, reserveMinutesForJob } from "@/lib/usage-ledger";

/**
 * yt-dlp is the true external boundary of the URL-import branch; tests inject fakes here the
 * same way ffprobe/whisper fakes are injected elsewhere, so CI never shells out for real.
 */
export type UrlImportDeps = {
  fetchMetadata: typeof fetchYtDlpMetadata;
  downloadVideo: typeof downloadYtDlpVideo;
};

const defaultUrlImportDeps: UrlImportDeps = {
  fetchMetadata: fetchYtDlpMetadata,
  downloadVideo: downloadYtDlpVideo,
};

/**
 * Fetches a URL-imported source video via yt-dlp. Duration limits are checked against the
 * pre-download metadata so an over-limit video fails fast instead of downloading gigabytes
 * first; the authoritative post-download ffprobe duration is re-checked by the shared
 * finalize flow afterwards.
 */
async function importSourceVideoFromUrl(params: {
  prisma: Parameters<JobHandler>[0]["prisma"];
  sourceVideo: SourceVideo;
  originUrl: string;
  plan: PlanLimits;
  storage: StorageProvider;
  workDir: string;
  deps: UrlImportDeps;
}): Promise<string> {
  const { prisma, sourceVideo, originUrl, plan, storage, workDir, deps } = params;

  let metadata;
  try {
    metadata = await deps.fetchMetadata(originUrl);
  } catch (error) {
    throw new JobFailureError(
      "URL_IMPORT_FAILED",
      "We couldn't read a video from that link. Check that it's a public video URL and try again.",
      { cause: error },
    );
  }

  if (metadata.durationS > MAX_VIDEO_DURATION_S) {
    throw new JobFailureError("VIDEO_TOO_LONG", "Videos up to 3 hours for now.", { retryable: false });
  }

  if (metadata.durationS > plan.maxVideoDurationS) {
    throw new JobFailureError(
      "PLAN_LIMIT_EXCEEDED",
      `${plan.name} plan videos are limited to ${Math.floor(plan.maxVideoDurationS / 60)} minutes.`,
      { retryable: false },
    );
  }

  const downloadPath = path.join(workDir, "url-download");
  const storageKey = `src/${sourceVideo.workspaceId}/${sourceVideo.id}-url-import.mp4`;
  try {
    await deps.downloadVideo(originUrl, downloadPath, { maxBytes: MAX_UPLOAD_BYTES });
    await storage.uploadFile(storageKey, downloadPath, "video/mp4");
  } catch (error) {
    if (error instanceof YtDlpFileTooLargeError) {
      throw new JobFailureError(
        "VIDEO_TOO_LARGE",
        `That video is larger than the ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024 * 1024))} GB import limit.`,
        { cause: error, retryable: false },
      );
    }
    throw new JobFailureError(
      "URL_IMPORT_FAILED",
      "We couldn't download the video from that link. Try again, or upload the file directly.",
      { cause: error },
    );
  }

  await prisma.sourceVideo.update({
    where: { id: sourceVideo.id },
    data: { storageKey },
  });

  return storageKey;
}

/**
 * Confirms the source file is a readable video within limits, then hands off to PROBE. For
 * URL-imported sources with no stored file yet, first fetches the video via yt-dlp (metadata
 * limit check -> download -> upload) and then falls through to the same probe/reserve flow.
 */
export function createFinalizeJobHandler(deps: UrlImportDeps = defaultUrlImportDeps): JobHandler {
  return async ({ job, prisma }) => {
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: job.projectId },
      include: { sourceVideo: true, workspace: { select: { planCode: true } } },
    });

    const plan = planForCode(project.workspace.planCode);
    const storage = getStorageProvider();
    const workDir = await mkdtemp(path.join(os.tmpdir(), "sermon-finalize-"));

    let probeResult;
    try {
      let storageKey = project.sourceVideo?.storageKey ?? null;
      if (
        project.sourceVideo &&
        !storageKey &&
        project.sourceVideo.origin === SourceOrigin.URL &&
        project.sourceVideo.originUrl
      ) {
        storageKey = await importSourceVideoFromUrl({
          prisma,
          sourceVideo: project.sourceVideo,
          originUrl: project.sourceVideo.originUrl,
          plan,
          storage,
          workDir,
          deps,
        });
      }

      if (!project.sourceVideo || !storageKey) {
        throw new JobFailureError("INVALID_FILE_TYPE", "That file isn't a video we can read.");
      }

      const filePath = path.join(workDir, "source-video");
      try {
        await storage.downloadToFile(storageKey, filePath);
        probeResult = await probeVideoFile(filePath);
      } catch (error) {
        throw new JobFailureError("INVALID_FILE_TYPE", "That file isn't a video we can read.", {
          cause: error,
        });
      }
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }

    if (probeResult.durationS > MAX_VIDEO_DURATION_S) {
      throw new JobFailureError("VIDEO_TOO_LONG", "Videos up to 3 hours for now.", { retryable: false });
    }

    if (probeResult.durationS > plan.maxVideoDurationS) {
      throw new JobFailureError(
        "PLAN_LIMIT_EXCEEDED",
        `${plan.name} plan videos are limited to ${Math.floor(plan.maxVideoDurationS / 60)} minutes.`,
        { retryable: false },
      );
    }

    const estimatedMinutes = estimateProcessingMinutes(probeResult.durationS);
    try {
      await reserveMinutesForJob(prisma, {
        workspaceId: project.workspaceId,
        projectId: project.id,
        jobId: job.id,
        minutes: estimatedMinutes,
        note: `Reserved ${estimatedMinutes.toString()} processing minutes for ${Math.ceil(probeResult.durationS)} seconds of video.`,
      });
    } catch (error) {
      if (error instanceof InsufficientBalanceError) {
        throw new JobFailureError(
          "INSUFFICIENT_MINUTES",
          `This sermon needs ${estimatedMinutes.toString()} minutes to process. Add minutes or upgrade your plan.`,
          { cause: error, retryable: false },
        );
      }
      throw error;
    }
    await prisma.processingJob.update({
      where: { id: job.id },
      data: { minutesReserved: estimatedMinutes },
    });

    await prisma.sourceVideo.update({
      where: { id: project.sourceVideo.id },
      data: {
        durationS: new Prisma.Decimal(probeResult.durationS.toFixed(2)),
        width: probeResult.width,
        height: probeResult.height,
        fps: probeResult.fps !== null ? new Prisma.Decimal(probeResult.fps.toFixed(3)) : null,
      },
    });

    await prisma.project.update({
      where: { id: project.id },
      data: { status: ProjectStatus.PROCESSING },
    });

    await enqueueJob(prisma, {
      projectId: project.id,
      type: ProcessingJobType.PROBE,
      idempotencyKey: `probe:${project.id}`,
      minutesReserved: new Prisma.Decimal(0),
    });
  };
}

export const runFinalizeJob: JobHandler = createFinalizeJobHandler();
