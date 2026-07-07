import { type ProcessingJobType, ProjectStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
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

  const handler = jobHandlers[job.type];
  if (!handler) {
    await markJobFailed(prisma, job.id, {
      code: "UNSUPPORTED_JOB_TYPE",
      message: "This processing stage isn't wired up yet.",
    });
    return true;
  }

  try {
    await withHeartbeat(
      () => heartbeatJob(prisma, job.id),
      () => handler({ job, prisma }),
    );
    await markJobSucceeded(prisma, job.id);
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
  }

  return true;
}
