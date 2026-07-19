import {
  Prisma,
  type PrismaClient,
  type ProcessingJob,
  ProcessingJobState,
  ProcessingJobType,
  ProjectStatus,
} from "@prisma/client";
import {
  PROCESSING_MAX_ATTEMPTS,
  retryRunAfter,
  staleCutoff,
  workerId,
} from "@/lib/worker/reliability";

export async function enqueueJob(
  client: PrismaClient,
  params: {
    projectId: string;
    type: ProcessingJobType;
    idempotencyKey: string;
    minutesReserved?: Prisma.Decimal | number | string;
  },
): Promise<ProcessingJob> {
  const existing = await client.processingJob.findUnique({
    where: { idempotencyKey: params.idempotencyKey },
  });
  if (existing) {
    return existing;
  }

  try {
    return await client.processingJob.create({
      data: {
        projectId: params.projectId,
        type: params.type,
        state: ProcessingJobState.QUEUED,
        idempotencyKey: params.idempotencyKey,
        minutesReserved: params.minutesReserved,
      },
    });
  } catch (error) {
    // Two concurrent enqueues (double-click, client retry) can both pass the fast-path
    // read; the loser's insert hits the unique index — honor the contract and return the
    // winner's row instead of surfacing a 500.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return client.processingJob.findUniqueOrThrow({
        where: { idempotencyKey: params.idempotencyKey },
      });
    }
    throw error;
  }
}

/**
 * Claims the oldest queued job of the given types with a conditional UPDATE (QUEUED -> RUNNING
 * only if still QUEUED), so multiple pollers can race safely without SELECT ... FOR UPDATE.
 * Returns null if nothing is queued, or if another poller won the race for the candidate row.
 */
export async function claimNextJob(
  client: PrismaClient,
  types: ProcessingJobType[],
): Promise<ProcessingJob | null> {
  const now = new Date();
  const claimedBy = workerId();
  const candidate = await client.processingJob.findFirst({
    where: {
      type: { in: types },
      state: { in: [ProcessingJobState.QUEUED, ProcessingJobState.RETRYING] },
      runAfter: { lte: now },
    },
    orderBy: { createdAt: "asc" },
  });

  if (!candidate) {
    return null;
  }

  const claim = await client.processingJob.updateMany({
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

  return client.processingJob.findUniqueOrThrow({ where: { id: candidate.id } });
}

/**
 * Outcome of a terminal transition attempt. SKIPPED means the job was no longer RUNNING
 * (canceled or stale-recovered) and the caller must not apply any follow-on side effects.
 */
export type JobTerminalOutcome = "SUCCEEDED" | "FAILED" | "RETRYING" | "SKIPPED";

/**
 * Terminal transitions are guarded on state RUNNING (same conditional-UPDATE pattern as
 * claimNextJob/heartbeatJob) so a finishing handler can never overwrite a concurrent
 * cancellation or stale recovery. Returns whether the transition applied.
 */
export async function markJobSucceeded(client: PrismaClient, jobId: string): Promise<boolean> {
  const result = await client.processingJob.updateMany({
    where: { id: jobId, state: ProcessingJobState.RUNNING },
    data: {
      state: ProcessingJobState.SUCCEEDED,
      progress: 100,
      finishedAt: new Date(),
      heartbeatAt: null,
      workerId: null,
    },
  });
  return result.count > 0;
}

export async function markJobFailed(
  client: PrismaClient,
  jobId: string,
  error: { code: string; message: string },
): Promise<boolean> {
  const result = await client.processingJob.updateMany({
    where: { id: jobId, state: ProcessingJobState.RUNNING },
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
  return result.count > 0;
}

export async function markJobFailedOrRetry(
  client: PrismaClient,
  job: ProcessingJob,
  error: { code: string; message: string },
): Promise<JobTerminalOutcome> {
  const now = new Date();
  const maxAttempts = job.maxAttempts || PROCESSING_MAX_ATTEMPTS;

  if (job.attempt < maxAttempts) {
    const result = await client.processingJob.updateMany({
      where: { id: job.id, state: ProcessingJobState.RUNNING },
      data: {
        state: ProcessingJobState.RETRYING,
        errorCode: error.code,
        errorMessageUser: error.message,
        lastErrorAt: now,
        runAfter: retryRunAfter(job.attempt, now),
        heartbeatAt: null,
        workerId: null,
      },
    });
    return result.count > 0 ? "RETRYING" : "SKIPPED";
  }

  return (await markJobFailed(client, job.id, error)) ? "FAILED" : "SKIPPED";
}

export async function heartbeatJob(client: PrismaClient, jobId: string) {
  return client.processingJob.updateMany({
    where: { id: jobId, state: ProcessingJobState.RUNNING },
    data: { heartbeatAt: new Date(), workerId: workerId() },
  });
}

export async function recoverStaleProcessingJobs(
  client: PrismaClient,
  types: ProcessingJobType[],
  now = new Date(),
) {
  const cutoff = staleCutoff(now);
  const staleJobs = await client.processingJob.findMany({
    where: {
      type: { in: types },
      state: ProcessingJobState.RUNNING,
      OR: [{ heartbeatAt: null, startedAt: { lt: cutoff } }, { heartbeatAt: { lt: cutoff } }],
    },
    take: 25,
    orderBy: { startedAt: "asc" },
  });

  let recovered = 0;
  let failed = 0;
  const failedJobIds: string[] = [];
  const failedJobs: Array<{ id: string; type: ProcessingJobType }> = [];
  for (const job of staleJobs) {
    const exhausted = job.attempt >= (job.maxAttempts || PROCESSING_MAX_ATTEMPTS);
    const result = await client.processingJob.updateMany({
      where: { id: job.id, state: ProcessingJobState.RUNNING },
      data: exhausted
        ? {
            state: ProcessingJobState.FAILED,
            errorCode: "STALE_JOB_TIMEOUT",
            errorMessageUser: "This processing stage stopped responding and needs attention.",
            lastErrorAt: now,
            finishedAt: now,
            heartbeatAt: null,
            workerId: null,
            staleRecoveredAt: now,
          }
        : {
            state: ProcessingJobState.RETRYING,
            errorCode: "STALE_JOB_RECOVERED",
            errorMessageUser: "This processing stage stopped responding and was queued to retry.",
            lastErrorAt: now,
            runAfter: now,
            heartbeatAt: null,
            workerId: null,
            staleRecoveredAt: now,
          },
    });
    if (result.count > 0) {
      if (exhausted) {
        failed += 1;
        failedJobIds.push(job.id);
        failedJobs.push({ id: job.id, type: job.type });
      } else {
        recovered += 1;
      }
    }
  }

  return { recovered, failed, failedJobIds, failedJobs };
}

/**
 * Applies the pipeline side effects of terminally failed stale jobs: release the job's minute
 * reservation and mark its project FAILED. CLEANUP jobs are exempt — retention maintenance runs
 * against healthy projects, and a stale cleanup must not fail the project or touch reservations
 * (mirrors the same exemption in the runner's failure path).
 */
export async function applyStaleFailureSideEffects(
  client: PrismaClient,
  failedJobs: Array<{ id: string; type: ProcessingJobType }>,
  options?: { releaseReservation: (client: PrismaClient, jobId: string) => Promise<unknown> },
) {
  for (const job of failedJobs) {
    if (job.type === ProcessingJobType.CLEANUP) {
      continue;
    }
    if (options?.releaseReservation) {
      await options.releaseReservation(client, job.id);
    }
    await client.project
      .updateMany({
        where: { processingJobs: { some: { id: job.id } } },
        data: { status: ProjectStatus.FAILED },
      })
      .catch(() => {});
  }
}

/** Cancels a job only if it hasn't already reached a terminal state. */
export async function cancelJobIfActive(client: PrismaClient, jobId: string) {
  return client.processingJob.updateMany({
    where: {
      id: jobId,
      state: {
        in: [
          ProcessingJobState.QUEUED,
          ProcessingJobState.RETRYING,
          ProcessingJobState.RUNNING,
          ProcessingJobState.WAITING,
        ],
      },
    },
    data: { state: ProcessingJobState.CANCELED, finishedAt: new Date(), heartbeatAt: null, workerId: null },
  });
}
