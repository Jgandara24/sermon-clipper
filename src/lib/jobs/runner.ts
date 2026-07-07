import { type ProcessingJobType, ProjectStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordOperationalEventSafely } from "@/lib/observability/operational-events";
import { releaseReservationsForProject } from "@/lib/usage-ledger";
import { withHeartbeat } from "@/lib/worker/reliability";
import { jobHandlers } from "./handlers";
import { claimNextJob, heartbeatJob, markJobFailed, markJobFailedOrRetry, markJobSucceeded } from "./queue";
import { JobFailureError } from "./types";

const SUPPORTED_TYPES = Object.keys(jobHandlers) as ProcessingJobType[];

/** Claims and runs a single pending job, if one is available. Returns whether it found work. */
export async function runOnePendingJob(): Promise<boolean> {
  const job = await claimNextJob(prisma, SUPPORTED_TYPES);
  if (!job) {
    return false;
  }
  const project = await prisma.project.findUnique({
    where: { id: job.projectId },
    select: { workspaceId: true },
  });

  const handler = jobHandlers[job.type];
  if (!handler) {
    await markJobFailed(prisma, job.id, {
      code: "UNSUPPORTED_JOB_TYPE",
      message: "This processing stage isn't wired up yet.",
    });
    await recordOperationalEventSafely(prisma, {
      workspaceId: project?.workspaceId,
      category: "processing",
      eventType: "processing_job_failed",
      severity: "error",
      message: "Processing job failed because its type is unsupported.",
      projectId: job.projectId,
      jobId: job.id,
      metadata: { type: job.type, errorCode: "UNSUPPORTED_JOB_TYPE" },
    });
    return true;
  }

  try {
    const result = await withHeartbeat(
      () => heartbeatJob(prisma, job.id),
      () => handler({ job, prisma }),
    );
    await markJobSucceeded(prisma, job.id);
    await recordOperationalEventSafely(prisma, {
      workspaceId: project?.workspaceId,
      category: job.type === "TRANSCRIBE" ? "transcription" : job.type === "ANALYZE" ? "analysis" : "processing",
      eventType: "processing_job_succeeded",
      message: `${job.type} job succeeded.`,
      projectId: job.projectId,
      jobId: job.id,
      metadata: { type: job.type, attempt: job.attempt, ...(result?.metadata ?? {}) },
    });
  } catch (error) {
    const failure =
      error instanceof JobFailureError
        ? { code: error.code, message: error.userMessage, retryable: error.retryable }
        : { code: "INTERNAL_ERROR", message: "Something went wrong processing this stage." };

    if (!(error instanceof JobFailureError)) {
      console.error(`[worker] job ${job.id} (${job.type}) failed unexpectedly`, error);
    }

    const updatedJob =
      failure.retryable === false
        ? await markJobFailed(prisma, job.id, failure)
        : await markJobFailedOrRetry(prisma, job, failure);
    if (updatedJob.state === "FAILED") {
      await releaseReservationsForProject(prisma, {
        projectId: job.projectId,
        note: `Released after failure: ${failure.code}`,
      });
      await prisma.project
        .update({ where: { id: job.projectId }, data: { status: ProjectStatus.FAILED } })
        .catch(() => {});
    }
    await recordOperationalEventSafely(prisma, {
      workspaceId: project?.workspaceId,
      category: job.type === "TRANSCRIBE" ? "transcription" : job.type === "ANALYZE" ? "analysis" : "processing",
      eventType: updatedJob.state === "FAILED" ? "processing_job_failed" : "processing_job_retrying",
      severity: updatedJob.state === "FAILED" ? "error" : "warning",
      message: `${job.type} job ${updatedJob.state === "FAILED" ? "failed" : "will retry"}.`,
      projectId: job.projectId,
      jobId: job.id,
      metadata: {
        type: job.type,
        attempt: job.attempt,
        errorCode: failure.code,
        retryable: failure.retryable ?? true,
      },
    });
  }

  return true;
}
