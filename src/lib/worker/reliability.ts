import os from "node:os";
import { accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import type { Prisma, PrismaClient } from "@prisma/client";
import { env } from "@/lib/env";

export const PROCESSING_MAX_ATTEMPTS = 3;
export const EXPORT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAYS_MS = [15_000, 60_000, 5 * 60_000];

export type WorkerReadinessCheck = {
  name: string;
  status: "ok" | "fail";
  message: string;
};

type EnvLike = Record<string, string | undefined>;
type CommandAvailable = (command: string) => boolean;
type FileReadable = (filePath: string) => boolean;

function defaultCommandAvailable(command: string): boolean {
  const result = spawnSync(command, ["-version"], { stdio: "ignore" });
  return result.status === 0;
}

function defaultFileReadable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function workerId(): string {
  return env.WORKER_ID ?? `${os.hostname()}:${process.pid}`;
}

export function checkWorkerRuntimeEnvironment(
  env: EnvLike = process.env,
  commandAvailable: CommandAvailable = defaultCommandAvailable,
  fileReadable: FileReadable = defaultFileReadable,
): WorkerReadinessCheck[] {
  if (env.NODE_ENV !== "production") {
    return [{ name: "WORKER_ID", status: "ok", message: "WORKER_ID is optional outside production." }];
  }

  const ffmpegPath = env.FFMPEG_PATH || "ffmpeg";
  const ffprobePath = env.FFPROBE_PATH || "ffprobe";
  const whisperBinary = env.WHISPER_CPP_BINARY || "whisper-cli";

  const checks: WorkerReadinessCheck[] = [
    env.WORKER_ID?.trim()
      ? { name: "WORKER_ID", status: "ok", message: "Stable worker identity is configured." }
      : {
          name: "WORKER_ID",
          status: "fail",
          message: "WORKER_ID is required in production so worker heartbeats and recovery are auditable.",
        },
    commandAvailable(ffmpegPath)
      ? { name: "FFMPEG_PATH", status: "ok", message: `ffmpeg is available at ${ffmpegPath}.` }
      : {
          name: "FFMPEG_PATH",
          status: "fail",
          message: `ffmpeg is required on production workers. Checked: ${ffmpegPath}.`,
        },
    commandAvailable(ffprobePath)
      ? { name: "FFPROBE_PATH", status: "ok", message: `ffprobe is available at ${ffprobePath}.` }
      : {
          name: "FFPROBE_PATH",
          status: "fail",
          message: `ffprobe is required on production workers. Checked: ${ffprobePath}.`,
        },
    commandAvailable(whisperBinary)
      ? { name: "WHISPER_CPP_BINARY", status: "ok", message: `Whisper binary is available at ${whisperBinary}.` }
      : {
          name: "WHISPER_CPP_BINARY",
          status: "fail",
          message: `whisper.cpp binary is required on production workers. Checked: ${whisperBinary}.`,
        },
    env.WHISPER_MODEL_PATH && fileReadable(env.WHISPER_MODEL_PATH)
      ? { name: "WHISPER_MODEL_PATH", status: "ok", message: "Whisper model file is readable." }
      : {
          name: "WHISPER_MODEL_PATH",
          status: "fail",
          message: "WHISPER_MODEL_PATH must point to a readable model file on production workers.",
        },
  ];

  return checks;
}

export function assertWorkerRuntimeReady(
  env: EnvLike = process.env,
  commandAvailable: CommandAvailable = defaultCommandAvailable,
  fileReadable: FileReadable = defaultFileReadable,
) {
  const checks = checkWorkerRuntimeEnvironment(env, commandAvailable, fileReadable);
  const failures = checks.filter((check) => check.status === "fail");
  if (failures.length > 0) {
    throw new Error(failures.map((check) => check.message).join(" "));
  }
  return checks;
}

export function heartbeatIntervalMs(): number {
  return env.WORKER_HEARTBEAT_INTERVAL_MS;
}

export function workerProcessHeartbeatIntervalMs(): number {
  return env.WORKER_PROCESS_HEARTBEAT_INTERVAL_MS;
}

export function staleJobTimeoutMs(): number {
  return env.WORKER_STALE_JOB_TIMEOUT_MS;
}

export async function recordWorkerProcessHeartbeat(
  client: PrismaClient,
  metadata: Prisma.InputJsonObject = {},
  now = new Date(),
) {
  const id = workerId();
  return client.workerHeartbeat.upsert({
    where: { workerId: id },
    create: {
      workerId: id,
      hostname: os.hostname(),
      pid: process.pid,
      startedAt: now,
      lastSeenAt: now,
      metadata,
    },
    update: {
      hostname: os.hostname(),
      pid: process.pid,
      lastSeenAt: now,
      metadata,
    },
  });
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
