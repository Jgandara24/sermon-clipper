import { runOnePendingExportJob } from "@/lib/exports/runner";
import { recoverStaleExportJobs } from "@/lib/exports/queue";
import { recoverStaleProcessingJobs } from "@/lib/jobs/queue";
import { runOnePendingJob } from "@/lib/jobs/runner";
import { jobHandlers } from "@/lib/jobs/handlers";
import { recordOperationalEventSafely } from "@/lib/observability/operational-events";
import { prisma } from "@/lib/prisma";
import { enqueueDueCleanupJobs, sweepOrphanedExportedFiles } from "@/lib/retention";
import { releaseReservationForJob } from "@/lib/usage-ledger";
import {
  assertWorkerRuntimeReady,
  recordWorkerProcessHeartbeat,
  workerProcessHeartbeatIntervalMs,
} from "@/lib/worker/reliability";
import { ProjectStatus, type ProcessingJobType } from "@prisma/client";

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 2000);
const RECOVERY_INTERVAL_MS = Number(process.env.WORKER_RECOVERY_INTERVAL_MS ?? 60_000);
const CLEANUP_SCAN_INTERVAL_MS = Number(process.env.WORKER_CLEANUP_INTERVAL_MS ?? 3_600_000);
const WORKER_PROCESS_HEARTBEAT_INTERVAL_MS = workerProcessHeartbeatIntervalMs();
let shuttingDown = false;
let lastRecoveryAt = 0;
let lastCleanupScanAt = 0;
let lastWorkerHeartbeatAt = 0;
const SUPPORTED_TYPES = Object.keys(jobHandlers) as ProcessingJobType[];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loop() {
  while (!shuttingDown) {
    let processed = false;
    try {
      const now = Date.now();
      if (now - lastWorkerHeartbeatAt >= WORKER_PROCESS_HEARTBEAT_INTERVAL_MS) {
        await recordWorkerProcessHeartbeat(prisma, {
          supportedProcessingTypes: SUPPORTED_TYPES,
          pollIntervalMs: POLL_INTERVAL_MS,
          recoveryIntervalMs: RECOVERY_INTERVAL_MS,
        });
        lastWorkerHeartbeatAt = now;
      }
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
          await recordOperationalEventSafely(prisma, {
            category: "worker",
            eventType: "stale_jobs_recovered",
            severity: processingRecovery.failed || exportRecovery.failed ? "error" : "warning",
            message: "Worker recovered stale running jobs.",
            metadata: { processingRecovery, exportRecovery },
          });
        }
        lastRecoveryAt = now;
      }
      if (now - lastCleanupScanAt >= CLEANUP_SCAN_INTERVAL_MS) {
        // Retention reaper: enqueue CLEANUP jobs for projects with expired media or stale
        // exports, and sweep orphaned exported-file rows that no longer map to a project.
        const cleanupScan = await enqueueDueCleanupJobs(prisma);
        const orphanSweep = await sweepOrphanedExportedFiles(prisma);
        if (cleanupScan.enqueued || orphanSweep.rowsDeleted) {
          console.log("[worker] retention cleanup scan", { cleanupScan, orphanSweep });
          await recordOperationalEventSafely(prisma, {
            category: "worker",
            eventType: "retention_scan",
            message: "Retention scan enqueued cleanup work.",
            metadata: { cleanupScan, orphanSweep },
          });
        }
        lastCleanupScanAt = now;
      }

      processed = await runOnePendingJob();
      // export_jobs is a separate table/queue from processing_jobs (guide §6) — poll it too so
      // one worker process drains both.
      processed = (await runOnePendingExportJob()) || processed;
    } catch (error) {
      console.error("[worker] unexpected error while polling for jobs", error);
      await recordOperationalEventSafely(prisma, {
        category: "worker",
        eventType: "worker_poll_error",
        severity: "error",
        message: "Worker polling loop threw an unexpected error.",
        metadata: { error: error instanceof Error ? error.message : String(error) },
      });
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

try {
  assertWorkerRuntimeReady();
} catch (error) {
  console.error("[worker] runtime readiness failed", error instanceof Error ? error.message : error);
  process.exit(1);
}

console.log(`[worker] polling for processing jobs every ${POLL_INTERVAL_MS}ms`);
recordWorkerProcessHeartbeat(prisma, {
  supportedProcessingTypes: SUPPORTED_TYPES,
  pollIntervalMs: POLL_INTERVAL_MS,
  recoveryIntervalMs: RECOVERY_INTERVAL_MS,
}).catch((error) => {
  console.error("[worker] failed to record startup heartbeat", error instanceof Error ? error.message : error);
});
loop().then(() => {
  console.log("[worker] shutting down");
  process.exit(0);
});
