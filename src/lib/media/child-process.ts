import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class ChildProcessTimeoutError extends Error {}

/**
 * Every ffmpeg/ffprobe/whisper invocation must carry a hard timeout: a hung child process
 * otherwise blocks the (serial) worker until stale-heartbeat recovery reaps the whole job
 * ~15 minutes later, and because the process kept heartbeating it may never be reaped at all.
 * SIGKILL rather than SIGTERM — a wedged encoder can't be trusted to honor a polite signal.
 */
export function envTimeoutMs(envVar: string, defaultMs: number): number {
  const parsed = Number(process.env[envVar] ?? defaultMs);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultMs;
}

export async function execFileWithTimeout(
  binaryPath: string,
  args: string[],
  options: { timeoutMs: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(binaryPath, args, {
      timeout: options.timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: options.maxBuffer,
    });
  } catch (error) {
    const err = error as Error & { killed?: boolean; signal?: string };
    if (err.killed && err.signal === "SIGKILL") {
      throw new ChildProcessTimeoutError(
        `${path.basename(binaryPath)} was killed after exceeding the ${options.timeoutMs}ms timeout.`,
      );
    }
    throw error;
  }
}
