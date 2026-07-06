import {
  type Prisma,
  type PrismaClient,
  type ProcessingJob,
  ProcessingJobState,
  ProcessingJobType,
} from "@prisma/client";

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

  return client.processingJob.create({
    data: {
      projectId: params.projectId,
      type: params.type,
      state: ProcessingJobState.QUEUED,
      idempotencyKey: params.idempotencyKey,
      minutesReserved: params.minutesReserved,
    },
  });
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
  const candidate = await client.processingJob.findFirst({
    where: { type: { in: types }, state: ProcessingJobState.QUEUED },
    orderBy: { createdAt: "asc" },
  });

  if (!candidate) {
    return null;
  }

  const claim = await client.processingJob.updateMany({
    where: { id: candidate.id, state: ProcessingJobState.QUEUED },
    data: { state: ProcessingJobState.RUNNING, startedAt: new Date(), attempt: { increment: 1 } },
  });

  if (claim.count === 0) {
    return null;
  }

  return client.processingJob.findUniqueOrThrow({ where: { id: candidate.id } });
}

export async function markJobSucceeded(client: PrismaClient, jobId: string) {
  return client.processingJob.update({
    where: { id: jobId },
    data: { state: ProcessingJobState.SUCCEEDED, progress: 100, finishedAt: new Date() },
  });
}

export async function markJobFailed(
  client: PrismaClient,
  jobId: string,
  error: { code: string; message: string },
) {
  return client.processingJob.update({
    where: { id: jobId },
    data: {
      state: ProcessingJobState.FAILED,
      errorCode: error.code,
      errorMessageUser: error.message,
      finishedAt: new Date(),
    },
  });
}

/** Cancels a job only if it hasn't already reached a terminal state. */
export async function cancelJobIfActive(client: PrismaClient, jobId: string) {
  return client.processingJob.updateMany({
    where: {
      id: jobId,
      state: { in: [ProcessingJobState.QUEUED, ProcessingJobState.RUNNING, ProcessingJobState.WAITING] },
    },
    data: { state: ProcessingJobState.CANCELED, finishedAt: new Date() },
  });
}
