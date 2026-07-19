import { type ExportJob, Prisma, ProcessingJobState, type PrismaClient } from "@prisma/client";
import { EXPORT_MAX_ATTEMPTS, retryRunAfter, staleCutoff, workerId } from "@/lib/worker/reliability";

const MAX_ATTEMPTS = EXPORT_MAX_ATTEMPTS; // initial attempt + 2 retries, per guide §15 step 6

/** Idempotent by idempotencyKey — a retried POST for the same clip/version/filename reuses the same job. */
export async function enqueueExportJob(
  client: PrismaClient,
  params: { clipId: string; workspaceId: string; filename: string; idempotencyKey: string },
): Promise<ExportJob> {
  const existing = await client.exportJob.findUnique({
    where: { idempotencyKey: params.idempotencyKey },
  });
  if (existing) {
    return existing;
  }

  try {
    return await client.exportJob.create({
      data: {
        clipId: params.clipId,
        workspaceId: params.workspaceId,
        filename: params.filename,
        idempotencyKey: params.idempotencyKey,
        state: ProcessingJobState.QUEUED,
      },
    });
  } catch (error) {
    // Same race-safe contract as enqueueJob: the loser of a concurrent enqueue returns
    // the winner's row instead of surfacing the unique-constraint violation.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return client.exportJob.findUniqueOrThrow({
        where: { idempotencyKey: params.idempotencyKey },
      });
    }
    throw error;
  }
}

/** Same conditional-UPDATE claim pattern as the processing-job queue (see jobs/queue.ts). */
export async function claimNextExportJob(client: PrismaClient): Promise<ExportJob | null> {
  const now = new Date();
  const claimedBy = workerId();
  const candidate = await client.exportJob.findFirst({
    where: {
      state: { in: [ProcessingJobState.QUEUED, ProcessingJobState.RETRYING] },
      runAfter: { lte: now },
    },
    orderBy: { createdAt: "asc" },
  });

  if (!candidate) {
    return null;
  }

  const claim = await client.exportJob.updateMany({
    where: {
      id: candidate.id,
      state: { in: [ProcessingJobState.QUEUED, ProcessingJobState.RETRYING] },
      runAfter: { lte: now },
    },
    data: {
      state: ProcessingJobState.RUNNING,
      startedAt: now,
      heartbeatAt: now,
      workerId: claimedBy,
      attempt: { increment: 1 },
    },
  });

  if (claim.count === 0) {
    return null;
  }

  return client.exportJob.findUniqueOrThrow({ where: { id: candidate.id } });
}

/**
 * Guarded on state RUNNING (same conditional-UPDATE pattern as claimNextExportJob) so a
 * finishing handler can never overwrite a concurrent stale recovery. Returns whether the
 * transition applied.
 */
export async function markExportJobSucceeded(
  client: PrismaClient,
  jobId: string,
  outputFileId: string,
): Promise<boolean> {
  const result = await client.exportJob.updateMany({
    where: { id: jobId, state: ProcessingJobState.RUNNING },
    data: {
      state: ProcessingJobState.SUCCEEDED,
      progress: 100,
      finishedAt: new Date(),
      heartbeatAt: null,
      workerId: null,
      outputFileId,
      // Exports are free at MVP (processing minutes already paid) — see DECISIONS.md.
      minutesCharged: 0,
    },
  });
  return result.count > 0;
}

export type ExportJobFailureOutcome = "RETRYING" | "FAILED" | "SKIPPED";

/**
 * Requeues the job (up to MAX_ATTEMPTS total) rather than failing it outright, per guide §15
 * step 6 ("retry x2; then failed"). Once attempts are exhausted, marks it FAILED with the
 * user-facing reason.
 */
export async function markExportJobFailedOrRetry(
  client: PrismaClient,
  job: ExportJob,
  error: { code: string; message: string },
): Promise<ExportJobFailureOutcome> {
  if (job.attempt < MAX_ATTEMPTS) {
    const result = await client.exportJob.updateMany({
      where: { id: job.id, state: ProcessingJobState.RUNNING },
      data: {
        state: ProcessingJobState.RETRYING,
        errorCode: error.code,
        errorMessageUser: error.message,
        lastErrorAt: new Date(),
        runAfter: retryRunAfter(job.attempt),
        heartbeatAt: null,
        workerId: null,
      },
    });
    return result.count > 0 ? "RETRYING" : "SKIPPED";
  }

  const result = await client.exportJob.updateMany({
    where: { id: job.id, state: ProcessingJobState.RUNNING },
    data: {
      state: ProcessingJobState.FAILED,
      errorCode: error.code,
      errorMessageUser: error.message,
      lastErrorAt: new Date(),
      finishedAt: new Date(),
      heartbeatAt: null,
      workerId: null,
    },
  });
  return result.count > 0 ? "FAILED" : "SKIPPED";
}

export async function heartbeatExportJob(client: PrismaClient, jobId: string) {
  return client.exportJob.updateMany({
    where: { id: jobId, state: ProcessingJobState.RUNNING },
    data: { heartbeatAt: new Date(), workerId: workerId() },
  });
}

export async function recoverStaleExportJobs(client: PrismaClient, now = new Date()) {
  const cutoff = staleCutoff(now);
  const staleJobs = await client.exportJob.findMany({
    where: {
      state: ProcessingJobState.RUNNING,
      OR: [{ heartbeatAt: null, startedAt: { lt: cutoff } }, { heartbeatAt: { lt: cutoff } }],
    },
    take: 25,
    orderBy: { startedAt: "asc" },
  });

  let recovered = 0;
  let failed = 0;
  for (const job of staleJobs) {
    const exhausted = job.attempt >= (job.maxAttempts || MAX_ATTEMPTS);
    const result = await client.exportJob.updateMany({
      where: { id: job.id, state: ProcessingJobState.RUNNING },
      data: exhausted
        ? {
            state: ProcessingJobState.FAILED,
            errorCode: "STALE_EXPORT_TIMEOUT",
            errorMessageUser: "This export stopped responding and needs attention.",
            lastErrorAt: now,
            finishedAt: now,
            heartbeatAt: null,
            workerId: null,
            staleRecoveredAt: now,
          }
        : {
            state: ProcessingJobState.RETRYING,
            errorCode: "STALE_EXPORT_RECOVERED",
            errorMessageUser: "This export stopped responding and was queued to retry.",
            lastErrorAt: now,
            runAfter: now,
            heartbeatAt: null,
            workerId: null,
            staleRecoveredAt: now,
          },
    });
    if (result.count > 0) {
      if (exhausted) failed += 1;
      else recovered += 1;
    }
  }

  return { recovered, failed };
}

/** Manual "try again" from the UI reuses the same job row (guide: "try again ... reuses the job"). */
export async function requeueFailedExportJob(client: PrismaClient, jobId: string) {
  return client.exportJob.updateMany({
    where: { id: jobId, state: ProcessingJobState.FAILED },
    data: {
      state: ProcessingJobState.QUEUED,
      errorCode: null,
      errorMessageUser: null,
      lastErrorAt: null,
      runAfter: new Date(),
      heartbeatAt: null,
      workerId: null,
      finishedAt: null,
    },
  });
}
