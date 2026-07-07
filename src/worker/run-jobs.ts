import { runOnePendingExportJob } from "@/lib/exports/runner";
import { recoverStaleExportJobs } from "@/lib/exports/queue";
import { recoverStaleProcessingJobs } from "@/lib/jobs/queue";
import { runOnePendingJob } from "@/lib/jobs/runner";
import { jobHandlers } from "@/lib/jobs/handlers";
import { prisma } from "@/lib/prisma";
import { releaseReservationForJob } from "@/lib/usage-ledger";
import { ProjectStatus, type ProcessingJobType } from "@prisma/client";

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 2000);
const RECOVERY_INTERVAL_MS = Number(process.env.WORKER_RECOVERY_INTERVAL_MS ?? 60_000);
let shuttingDown = false;
let lastRecoveryAt = 0;
const SUPPORTED_TYPES = Object.keys(jobHandlers) as ProcessingJobType[];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loop() {
  while (!shuttingDown) {
    let processed = false;
    try {
      const now = Date.now();
      if (now - lastRecoveryAt >= RECOVERY_INTERVAL_MS) {
        const [processingRecovery, exportRecovery] = await Promise.all([
          recoverStaleProcessingJobs(prisma, SUPPORTED_TYPES),
          recoverStaleExportJobs(prisma),
        ]);
        for (const jobId of processingRecovery.failedJobIds) {
          await releaseReservationForJob(prisma, {
            jobId,
            note: "Released after stale worker timeout.",
          });
          await prisma.project
            .updateMany({
              where: { processingJobs: { some: { id: jobId } } },
              data: { status: ProjectStatus.FAILED },
            })
            .catch(() => {});
        }
        if (processingRecovery.recovered || processingRecovery.failed || exportRecovery.recovered || exportRecovery.failed) {
          console.warn("[worker] recovered stale jobs", { processingRecovery, exportRecovery });
        }
        lastRecoveryAt = now;
      }

      processed = await runOnePendingJob();
      // export_jobs is a separate table/queue from processing_jobs (guide §6) — poll it too so
      // one worker process drains both.
      processed = (await runOnePendingExportJob()) || processed;
    } catch (error) {
      console.error("[worker] unexpected error while polling for jobs", error);
    }

    if (!processed && !shuttingDown) {
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

process.on("SIGINT", () => {
  shuttingDown = true;
});
process.on("SIGTERM", () => {
  shuttingDown = true;
});

console.log(`[worker] polling for processing jobs every ${POLL_INTERVAL_MS}ms`);
loop().then(() => {
  console.log("[worker] shutting down");
  process.exit(0);
});
