import os from "node:os";

export const PROCESSING_MAX_ATTEMPTS = 3;
export const EXPORT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAYS_MS = [15_000, 60_000, 5 * 60_000];

export function workerId(): string {
  return process.env.WORKER_ID ?? `${os.hostname()}:${process.pid}`;
}

export function heartbeatIntervalMs(): number {
  return Number(process.env.WORKER_HEARTBEAT_INTERVAL_MS ?? 30_000);
}

export function staleJobTimeoutMs(): number {
  return Number(process.env.WORKER_STALE_JOB_TIMEOUT_MS ?? 15 * 60_000);
}

export async function withHeartbeat<T>(
  heartbeat: () => Promise<unknown>,
  work: () => Promise<T>,
  intervalMs = heartbeatIntervalMs(),
): Promise<T> {
  await heartbeat();
  const interval = setInterval(() => {
    heartbeat().catch((error) => {
      console.error("[worker] failed to record heartbeat", error);
    });
  }, intervalMs);
  interval.unref?.();

  try {
    return await work();
  } finally {
    clearInterval(interval);
  }
}

export function staleCutoff(now = new Date(), timeoutMs = staleJobTimeoutMs()): Date {
  return new Date(now.getTime() - timeoutMs);
}

export function retryDelayMsForAttempt(attempt: number): number {
  return DEFAULT_RETRY_DELAYS_MS[Math.min(Math.max(attempt - 1, 0), DEFAULT_RETRY_DELAYS_MS.length - 1)];
}

export function retryRunAfter(attempt: number, now = new Date()): Date {
  return new Date(now.getTime() + retryDelayMsForAttempt(attempt));
}
