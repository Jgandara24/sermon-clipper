import { runOnePendingExportJob } from "@/lib/exports/runner";
import { recoverStaleExportJobs } from "@/lib/exports/queue";
import { applyStaleFailureSideEffects, recoverStaleProcessingJobs } from "@/lib/jobs/queue";
import { runOnePendingJob } from "@/lib/jobs/runner";
import { jobHandlers } from "@/lib/jobs/handlers";
import { env } from "@/lib/env";
import { defaultCostRollupRange, rollupProcessingCosts } from "@/lib/cost/rollup";
import {
  publishDueScheduledPosts,
  recoverStaleScheduledPosts,
} from "@/lib/integrations/facebook-publisher";
import { pollDueChannelImportSources } from "@/lib/integrations/channel-poller";
import {
  captureErrorSafely,
  flushErrorReporting,
  initErrorReporting,
} from "@/lib/observability/error-reporting";
import { recordOperationalEventSafely } from "@/lib/observability/operational-events";
import { prisma } from "@/lib/prisma";
import { enqueueDueCleanupJobs, sweepOrphanedExportedFiles } from "@/lib/retention";
import { releaseReservationForJob } from "@/lib/usage-ledger";
import {
  assertWorkerRuntimeReady,
  automaticPublishingEnabled,
  recordWorkerProcessHeartbeat,
  runIsolatedPeriodicBlocks,
  workerProcessHeartbeatIntervalMs,
} from "@/lib/worker/reliability";
import type { ProcessingJobType } from "@prisma/client";

const POLL_INTERVAL_MS = env.WORKER_POLL_INTERVAL_MS;
const RECOVERY_INTERVAL_MS = env.WORKER_RECOVERY_INTERVAL_MS;
const CLEANUP_SCAN_INTERVAL_MS = env.WORKER_CLEANUP_INTERVAL_MS;
const CHANNEL_POLL_INTERVAL_MS = env.CHANNEL_POLL_INTERVAL_MS;
const FACEBOOK_PUBLISH_POLL_INTERVAL_MS = env.FACEBOOK_PUBLISH_POLL_INTERVAL_MS;
const COST_ROLLUP_INTERVAL_MS = env.COST_ROLLUP_INTERVAL_MS;
const WORKER_PROCESS_HEARTBEAT_INTERVAL_MS = workerProcessHeartbeatIntervalMs();
let shuttingDown = false;
let lastRecoveryAt = 0;
let lastCleanupScanAt = 0;
let lastChannelPollAt = 0;
let lastFacebookPublishPollAt = 0;
let lastCostRollupAt = 0;
let lastWorkerHeartbeatAt = 0;
const SUPPORTED_TYPES = Object.keys(jobHandlers) as ProcessingJobType[];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loop() {
  while (!shuttingDown) {
    let processed = false;
    const now = Date.now();
    await runIsolatedPeriodicBlocks(
      [
        {
          name: "worker_heartbeat",
          due: now - lastWorkerHeartbeatAt >= WORKER_PROCESS_HEARTBEAT_INTERVAL_MS,
          run: async () => {
            await recordWorkerProcessHeartbeat(prisma, {
              supportedProcessingTypes: SUPPORTED_TYPES,
              pollIntervalMs: POLL_INTERVAL_MS,
              recoveryIntervalMs: RECOVERY_INTERVAL_MS,
            });
          },
          markAttempted: () => {
            lastWorkerHeartbeatAt = now;
          },
        },
        {
          name: "stale_recovery",
          due: now - lastRecoveryAt >= RECOVERY_INTERVAL_MS,
          run: async () => {
            const [processingRecovery, exportRecovery, scheduledPostRecovery] = await Promise.all([
              recoverStaleProcessingJobs(prisma, SUPPORTED_TYPES),
              recoverStaleExportJobs(prisma),
              recoverStaleScheduledPosts(prisma),
            ]);
            await applyStaleFailureSideEffects(prisma, processingRecovery.failedJobs, {
              releaseReservation: (client, jobId) =>
                releaseReservationForJob(client, {
                  jobId,
                  note: "Released after stale worker timeout.",
                }),
            });
            if (
              processingRecovery.recovered ||
              processingRecovery.failed ||
              exportRecovery.recovered ||
              exportRecovery.failed ||
              scheduledPostRecovery.recovered ||
              scheduledPostRecovery.failed
            ) {
              console.warn("[worker] recovered stale jobs", {
                processingRecovery,
                exportRecovery,
                scheduledPostRecovery,
              });
              await recordOperationalEventSafely(prisma, {
                category: "worker",
                eventType: "stale_jobs_recovered",
                severity:
                  processingRecovery.failed || exportRecovery.failed || scheduledPostRecovery.failed
                    ? "error"
                    : "warning",
                message: "Worker recovered stale running jobs.",
                metadata: { processingRecovery, exportRecovery, scheduledPostRecovery },
              });
            }
          },
          markAttempted: () => {
            lastRecoveryAt = now;
          },
        },
        {
          name: "retention_cleanup",
          due: now - lastCleanupScanAt >= CLEANUP_SCAN_INTERVAL_MS,
          run: async () => {
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
          },
          markAttempted: () => {
            lastCleanupScanAt = now;
          },
        },
        {
          name: "channel_import",
          due: now - lastChannelPollAt >= CHANNEL_POLL_INTERVAL_MS,
          run: async () => {
            const channelPoll = await pollDueChannelImportSources(prisma);
            if (
              channelPoll.sourcesPolled ||
              channelPoll.sourcesFailed ||
              channelPoll.videosImported ||
              channelPoll.videosFailed ||
              channelPoll.videosSkippedCap
            ) {
              console.log("[worker] channel import poll", { channelPoll });
            }
          },
          markAttempted: () => {
            lastChannelPollAt = now;
          },
        },
        {
          name: "cost_rollup",
          due: now - lastCostRollupAt >= COST_ROLLUP_INTERVAL_MS,
          run: async () => {
            const rollup = await rollupProcessingCosts(
              prisma,
              defaultCostRollupRange(new Date(now), env.COST_ROLLUP_LOOKBACK_DAYS),
            );
            if (rollup.sourceEventCount > 0) {
              console.log("[worker] processing cost rollup", { rollup });
            }
          },
          markAttempted: () => {
            lastCostRollupAt = now;
          },
        },
        {
          name: "facebook_publish",
          due: now - lastFacebookPublishPollAt >= FACEBOOK_PUBLISH_POLL_INTERVAL_MS,
          run: async () => {
            if (automaticPublishingEnabled()) {
              const facebookPublishPoll = await publishDueScheduledPosts(prisma);
              if (facebookPublishPoll.postsScanned) {
                console.log("[worker] facebook publish poll", { facebookPublishPoll });
              }
            } else {
              await publishDueScheduledPosts(prisma);
            }
          },
          markAttempted: () => {
            lastFacebookPublishPollAt = now;
          },
        },
      ],
      async (block, error) => {
        console.error(`[worker] periodic block ${block} failed`, error);
        await captureErrorSafely(error, { source: "worker_periodic_block", block });
        await recordOperationalEventSafely(prisma, {
          category: "worker",
          eventType: "worker_periodic_block_failed",
          severity: "error",
          message: `Worker periodic block ${block} failed; later blocks continued.`,
          metadata: { block, error: error instanceof Error ? error.message : String(error) },
        });
      },
    );

    try {
      processed = await runOnePendingJob();
      // export_jobs is a separate table/queue from processing_jobs (guide §6) — poll it too so
      // one worker process drains both.
      processed = (await runOnePendingExportJob()) || processed;
    } catch (error) {
      console.error("[worker] unexpected error while polling for jobs", error);
      await captureErrorSafely(error, { source: "worker_poll_loop" });
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
// Sentry (errors only) when SENTRY_DSN is set; also captures unhandled rejections by default.
initErrorReporting({ process: "worker", workerId: env.WORKER_ID ?? "unknown" }).catch(
  () => {},
);
recordWorkerProcessHeartbeat(prisma, {
  supportedProcessingTypes: SUPPORTED_TYPES,
  pollIntervalMs: POLL_INTERVAL_MS,
  recoveryIntervalMs: RECOVERY_INTERVAL_MS,
}).catch((error) => {
  console.error("[worker] failed to record startup heartbeat", error instanceof Error ? error.message : error);
});
loop().then(async () => {
  console.log("[worker] shutting down");
  await flushErrorReporting();
  process.exit(0);
});
