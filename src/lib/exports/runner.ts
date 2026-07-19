import { prisma } from "@/lib/prisma";
import { recordOperationalEventSafely } from "@/lib/observability/operational-events";
import { HeartbeatLostError, withHeartbeat } from "@/lib/worker/reliability";
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
      async () => {
        const beat = await heartbeatExportJob(prisma, job.id);
        if (beat.count === 0) {
          throw new HeartbeatLostError(job.id);
        }
      },
      () => runExportJob(prisma, job),
    );
    const succeeded = await markExportJobSucceeded(prisma, job.id, outputFileId);
    if (!succeeded) {
      // Stale-recovered and re-claimed while rendering; the other claim owns the state now.
      console.warn(`[worker] export job ${job.id} finished after losing its claim; state left untouched`);
      return true;
    }
    await recordOperationalEventSafely(prisma, {
      workspaceId: job.workspaceId,
      category: "export",
      eventType: "export_job_succeeded",
      message: "Export job succeeded.",
      exportJobId: job.id,
      metadata: { clipId: job.clipId, outputFileId, filename: job.filename, attempt: job.attempt },
    });
  } catch (error) {
    if (error instanceof HeartbeatLostError) {
      // Claim lost mid-render (stale recovery re-claim): abandon without marking failed.
      console.warn(`[worker] export job ${job.id} lost its claim mid-run; abandoning`);
      return true;
    }

    const failure =
      error instanceof ExportFailureError
        ? { code: error.code, message: error.userMessage }
        : { code: "RENDER_FAILED", message: "Export failed on our side — your clip is safe." };

    if (!(error instanceof ExportFailureError)) {
      console.error(`[worker] export job ${job.id} failed unexpectedly`, error);
    }

    const outcome = await markExportJobFailedOrRetry(prisma, job, failure);
    if (outcome === "SKIPPED") {
      console.warn(`[worker] export job ${job.id} failed after losing its claim; state left untouched`);
      return true;
    }
    await recordOperationalEventSafely(prisma, {
      workspaceId: job.workspaceId,
      category: "export",
      eventType: outcome === "FAILED" ? "export_job_failed" : "export_job_retrying",
      severity: outcome === "FAILED" ? "error" : "warning",
      message: `Export job ${outcome === "FAILED" ? "failed" : "will retry"}.`,
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
