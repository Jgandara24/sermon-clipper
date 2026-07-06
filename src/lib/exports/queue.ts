import { type ExportJob, ProcessingJobState, type PrismaClient } from "@prisma/client";

const MAX_ATTEMPTS = 3; // initial attempt + 2 retries, per guide §15 step 6

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

  return client.exportJob.create({
    data: {
      clipId: params.clipId,
      workspaceId: params.workspaceId,
      filename: params.filename,
      idempotencyKey: params.idempotencyKey,
      state: ProcessingJobState.QUEUED,
    },
  });
}

/** Same conditional-UPDATE claim pattern as the processing-job queue (see jobs/queue.ts). */
export async function claimNextExportJob(client: PrismaClient): Promise<ExportJob | null> {
  const candidate = await client.exportJob.findFirst({
    where: { state: ProcessingJobState.QUEUED },
    orderBy: { createdAt: "asc" },
  });

  if (!candidate) {
    return null;
  }

  const claim = await client.exportJob.updateMany({
    where: { id: candidate.id, state: ProcessingJobState.QUEUED },
    data: { state: ProcessingJobState.RUNNING, startedAt: new Date(), attempt: { increment: 1 } },
  });

  if (claim.count === 0) {
    return null;
  }

  return client.exportJob.findUniqueOrThrow({ where: { id: candidate.id } });
}

export async function markExportJobSucceeded(client: PrismaClient, jobId: string, outputFileId: string) {
  return client.exportJob.update({
    where: { id: jobId },
    data: {
      state: ProcessingJobState.SUCCEEDED,
      progress: 100,
      finishedAt: new Date(),
      outputFileId,
      // Exports are free at MVP (processing minutes already paid) — see DECISIONS.md.
      minutesCharged: 0,
    },
  });
}

/**
 * Requeues the job (up to MAX_ATTEMPTS total) rather than failing it outright, per guide §15
 * step 6 ("retry x2; then failed"). Once attempts are exhausted, marks it FAILED with the
 * user-facing reason.
 */
export async function markExportJobFailedOrRetry(
  client: PrismaClient,
  job: ExportJob,
  error: { code: string; message: string },
) {
  if (job.attempt < MAX_ATTEMPTS) {
    return client.exportJob.update({
      where: { id: job.id },
      data: { state: ProcessingJobState.QUEUED, errorCode: error.code, errorMessageUser: error.message },
    });
  }

  return client.exportJob.update({
    where: { id: job.id },
    data: {
      state: ProcessingJobState.FAILED,
      errorCode: error.code,
      errorMessageUser: error.message,
      finishedAt: new Date(),
    },
  });
}

/** Manual "try again" from the UI reuses the same job row (guide: "try again ... reuses the job"). */
export async function requeueFailedExportJob(client: PrismaClient, jobId: string) {
  return client.exportJob.updateMany({
    where: { id: jobId, state: ProcessingJobState.FAILED },
    data: { state: ProcessingJobState.QUEUED, errorCode: null, errorMessageUser: null },
  });
}
