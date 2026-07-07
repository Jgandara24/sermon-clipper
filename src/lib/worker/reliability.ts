import os from "node:os";

export const PROCESSING_MAX_ATTEMPTS = 3;
export const EXPORT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAYS_MS = [15_000, 60_000, 5 * 60_000];

export type WorkerReadinessCheck = {
  name: string;
  status: "ok" | "fail";
  message: string;
};

type EnvLike = Record<string, string | undefined>;

export function workerId(): string {
  return process.env.WORKER_ID ?? `${os.hostname()}:${process.pid}`;
}

export function checkWorkerRuntimeEnvironment(env: EnvLike = process.env): WorkerReadinessCheck[] {
  if (env.NODE_ENV !== "production") {
    return [{ name: "WORKER_ID", status: "ok", message: "WORKER_ID is optional outside production." }];
  }

  return [
    env.WORKER_ID?.trim()
      ? { name: "WORKER_ID", status: "ok", message: "Stable worker identity is configured." }
      : {
          name: "WORKER_ID",
          status: "fail",
          message: "WORKER_ID is required in production so worker heartbeats and recovery are auditable.",
        },
  ];
}

export function assertWorkerRuntimeReady(env: EnvLike = process.env) {
  const checks = checkWorkerRuntimeEnvironment(env);
  const failures = checks.filter((check) => check.status === "fail");
  if (failures.length > 0) {
    throw new Error(failures.map((check) => check.message).join(" "));
  }
  return checks;
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
