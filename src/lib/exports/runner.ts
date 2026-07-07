import { prisma } from "@/lib/prisma";
import { recordOperationalEventSafely } from "@/lib/observability/operational-events";
import { withHeartbeat } from "@/lib/worker/reliability";
import { ExportFailureError, runExportJob } from "./handler";
import {
  claimNextExportJob,
  heartbeatExportJob,
  markExportJobFailedOrRetry,
  markExportJobSucceeded,
} from "./queue";

/** Claims and runs a single pending export job, if one is available. Returns whether it found work. */
export async function runOnePendingExportJob(): Promise<boolean> {
  const job = await claimNextExportJob(prisma);
  if (!job) {
    return false;
  }

  try {
    const outputFileId = await withHeartbeat(
      () => heartbeatExportJob(prisma, job.id),
      () => runExportJob(prisma, job),
    );
    await markExportJobSucceeded(prisma, job.id, outputFileId);
    await recordOperationalEventSafely(prisma, {
      workspaceId: job.workspaceId,
      category: "export",
      eventType: "export_job_succeeded",
      message: "Export job succeeded.",
      exportJobId: job.id,
      metadata: { clipId: job.clipId, outputFileId, filename: job.filename, attempt: job.attempt },
    });
  } catch (error) {
    const failure =
      error instanceof ExportFailureError
        ? { code: error.code, message: error.userMessage }
        : { code: "RENDER_FAILED", message: "Export failed on our side — your clip is safe." };

    if (!(error instanceof ExportFailureError)) {
      console.error(`[worker] export job ${job.id} failed unexpectedly`, error);
    }

    const updatedJob = await markExportJobFailedOrRetry(prisma, job, failure);
    await recordOperationalEventSafely(prisma, {
      workspaceId: job.workspaceId,
      category: "export",
      eventType: updatedJob.state === "FAILED" ? "export_job_failed" : "export_job_retrying",
      severity: updatedJob.state === "FAILED" ? "error" : "warning",
      message: `Export job ${updatedJob.state === "FAILED" ? "failed" : "will retry"}.`,
      exportJobId: job.id,
      metadata: {
        clipId: job.clipId,
        filename: job.filename,
        attempt: job.attempt,
        errorCode: failure.code,
      },
    });
  }

  return true;
}
