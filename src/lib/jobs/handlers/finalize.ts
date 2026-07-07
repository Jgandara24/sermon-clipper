import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Prisma, ProcessingJobType, ProjectStatus } from "@prisma/client";
import { estimateProcessingMinutes, planForCode } from "@/lib/billing/plans";
import { enqueueJob } from "@/lib/jobs/queue";
import { JobFailureError, type JobHandler } from "@/lib/jobs/types";
import { MAX_VIDEO_DURATION_S } from "@/lib/limits";
import { probeVideoFile } from "@/lib/media/probe";
import { getStorageProvider } from "@/lib/storage";
import { InsufficientBalanceError, reserveMinutesForJob } from "@/lib/usage-ledger";

/** Confirms the uploaded file is a readable video within limits, then hands off to PROBE. */
export const runFinalizeJob: JobHandler = async ({ job, prisma }) => {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: job.projectId },
    include: { sourceVideo: true, workspace: { select: { planCode: true } } },
  });

  if (!project.sourceVideo?.storageKey) {
    throw new JobFailureError("INVALID_FILE_TYPE", "That file isn't a video we can read.");
  }

  const storage = getStorageProvider();
  const workDir = await mkdtemp(path.join(os.tmpdir(), "sermon-finalize-"));
  const filePath = path.join(workDir, "source-video");

  let probeResult;
  try {
    await storage.downloadToFile(project.sourceVideo.storageKey, filePath);
    probeResult = await probeVideoFile(filePath);
  } catch (error) {
    throw new JobFailureError("INVALID_FILE_TYPE", "That file isn't a video we can read.", {
      cause: error,
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  if (probeResult.durationS > MAX_VIDEO_DURATION_S) {
    throw new JobFailureError("VIDEO_TOO_LONG", "Videos up to 3 hours for now.", { retryable: false });
  }

  const plan = planForCode(project.workspace.planCode);
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
