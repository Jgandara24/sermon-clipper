import { ProcessingJobType, ProjectStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { captureErrorSafely } from "@/lib/observability/error-reporting";
import { recordOperationalEventSafely } from "@/lib/observability/operational-events";
import { releaseReservationsForProject } from "@/lib/usage-ledger";
import { HeartbeatLostError, withHeartbeat } from "@/lib/worker/reliability";
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
      async () => {
        const beat = await heartbeatJob(prisma, job.id);
        if (beat.count === 0) {
          throw new HeartbeatLostError(job.id);
        }
      },
      () => handler({ job, prisma }),
    );
    const succeeded = await markJobSucceeded(prisma, job.id);
    if (!succeeded) {
      // The job was canceled or stale-recovered while the handler ran; its state is
      // authoritative now, so leave it (and the project) untouched.
      console.warn(`[worker] job ${job.id} (${job.type}) finished after losing its claim; state left untouched`);
      return true;
    }
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
    if (error instanceof HeartbeatLostError) {
      // Claim lost mid-run (user cancel or stale recovery re-claim): whoever took the claim
      // owns the job's state now — abandon without marking failed.
      console.warn(`[worker] job ${job.id} (${job.type}) lost its claim mid-run; abandoning`);
      return true;
    }

    const failure =
      error instanceof JobFailureError
        ? { code: error.code, message: error.userMessage, retryable: error.retryable }
        : { code: "INTERNAL_ERROR", message: "Something went wrong processing this stage." };

    if (!(error instanceof JobFailureError)) {
      console.error(`[worker] job ${job.id} (${job.type}) failed unexpectedly`, error);
      // Expected failures (JobFailureError) live in operational events; only genuinely
      // unexpected errors go to external error monitoring.
      await captureErrorSafely(error, { jobId: job.id, jobType: job.type });
    }

    const outcome =
      failure.retryable === false
        ? (await markJobFailed(prisma, job.id, failure))
          ? "FAILED"
          : "SKIPPED"
        : await markJobFailedOrRetry(prisma, job, failure);
    if (outcome === "SKIPPED") {
      // Canceled or stale-recovered while the handler ran; the concurrent transition wins.
      console.warn(`[worker] job ${job.id} (${job.type}) failed after losing its claim; state left untouched`);
      return true;
    }
    // CLEANUP is background maintenance on a possibly-healthy project: its failure must not
    // fail the project or touch minute reservations the way a pipeline-stage failure does.
    if (outcome === "FAILED" && job.type !== ProcessingJobType.CLEANUP) {
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
      eventType: outcome === "FAILED" ? "processing_job_failed" : "processing_job_retrying",
      severity: outcome === "FAILED" ? "error" : "warning",
      message: `${job.type} job ${outcome === "FAILED" ? "failed" : "will retry"}.`,
      projectId: job.projectId,
      jobId: job.id,
      metadata: {
        type: job.type,
        attempt: job.attempt,
        errorCode: failure.code,
        retryable: failure.retryable ?? true,
        ...(error instanceof JobFailureError ? { detail: causeDetail(error.cause) } : {}),
      },
    });
  }

  return true;
}

/**
 * Surfaces the underlying cause of a JobFailureError (e.g. yt-dlp's stderr, which Node's
 * execFile bakes into the rejected error's message) into operational event metadata — without
 * this, on-call debugging has only a generic error code and no way to see what actually failed.
 */
function causeDetail(cause: unknown): string | undefined {
  if (!cause) return undefined;
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.length > 1000 ? `${message.slice(0, 1000)}…` : message;
}
