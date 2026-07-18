import { ProcessingJobState, type PrismaClient } from "@prisma/client";
import { env } from "@/lib/env";

/**
 * Per-workspace limits on the expensive operations (worker CPU for exports, the whole
 * processing pipeline — including paid transcription/analysis — for uploads). DB-backed
 * counting over existing rows/events, same pattern as the email-OTP rate limit: no new
 * infrastructure, race-tolerant enough for abuse control (a near-simultaneous pair may both
 * pass; the cap still holds within one request of the limit).
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Renders a workspace may have queued/running at once. */
export function exportConcurrentJobLimit(): number {
  return env.EXPORT_MAX_CONCURRENT_JOBS;
}

/** New export jobs a workspace may create per rolling 24h. */
export function exportDailyJobLimit(): number {
  return env.EXPORT_DAILY_JOB_LIMIT;
}

/** Signed upload URLs a workspace may mint per rolling hour. */
export function uploadPresignHourlyLimit(): number {
  return env.UPLOAD_PRESIGN_HOURLY_LIMIT;
}

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; reason: string; message: string; limit: number; current: number };

const ACTIVE_EXPORT_STATES = [
  ProcessingJobState.QUEUED,
  ProcessingJobState.RETRYING,
  ProcessingJobState.RUNNING,
  ProcessingJobState.WAITING,
];

export async function checkExportJobLimits(
  client: PrismaClient,
  workspaceId: string,
  now = new Date(),
): Promise<RateLimitDecision> {
  const concurrentLimit = exportConcurrentJobLimit();
  const concurrent = await client.exportJob.count({
    where: { workspaceId, state: { in: ACTIVE_EXPORT_STATES } },
  });
  if (concurrent >= concurrentLimit) {
    return {
      allowed: false,
      reason: "export_concurrent_limit",
      message: `Up to ${concurrentLimit} exports can render at once — wait for one to finish, then try again.`,
      limit: concurrentLimit,
      current: concurrent,
    };
  }

  const dailyLimit = exportDailyJobLimit();
  const daily = await client.exportJob.count({
    where: { workspaceId, createdAt: { gte: new Date(now.getTime() - DAY_MS) } },
  });
  if (daily >= dailyLimit) {
    return {
      allowed: false,
      reason: "export_daily_limit",
      message: `This workspace reached its ${dailyLimit} exports for the day — try again tomorrow.`,
      limit: dailyLimit,
      current: daily,
    };
  }

  return { allowed: true };
}

export async function checkUploadPresignLimit(
  client: PrismaClient,
  workspaceId: string,
  now = new Date(),
): Promise<RateLimitDecision> {
  const limit = uploadPresignHourlyLimit();
  // Every issued upload URL records an `upload_presigned` operational event, so the event
  // stream doubles as the rate-limit counter.
  const current = await client.operationalEvent.count({
    where: {
      workspaceId,
      category: "upload",
      eventType: "upload_presigned",
      createdAt: { gte: new Date(now.getTime() - HOUR_MS) },
    },
  });
  if (current >= limit) {
    return {
      allowed: false,
      reason: "upload_presign_limit",
      message: `Too many upload requests in the last hour — wait a bit and try again.`,
      limit,
      current,
    };
  }
  return { allowed: true };
}
