import { spawn } from "node:child_process";
import { platform, release } from "node:os";
import { performance } from "node:perf_hooks";

type NativeTimeKind = "darwin_time" | "gnu_time";
export type ResourceBackend = { kind: NativeTimeKind; version: string }
  | { kind: "unavailable"; reason: string };
type ResourceMeasurement = {
  status: "measured"; backend: NativeTimeKind;
  userCpuMs: number; systemCpuMs: number; peakRssBytes: number;
} | { status: "unavailable"; reason: string };

/** OS time output only. FFmpeg's similarly named benchmark fields are not an input. */
export function parseNativeTime(kind: NativeTimeKind, text: string): ResourceMeasurement {
  const unavailable = { status: "unavailable" as const, reason: "native_metrics_unreadable" };
  const timings = kind === "gnu_time"
    ? [...text.matchAll(/^CODEX_NATIVE_TIME (\d+(?:\.\d+)?) (\d+(?:\.\d+)?) (\d+)\s*$/gm)]
    : [...text.matchAll(/^\s*\d+(?:\.\d+)? real\s+(\d+(?:\.\d+)?) user\s+(\d+(?:\.\d+)?) sys\s*$/gm)];
  const memory = kind === "gnu_time" ? timings
    : [...text.matchAll(/^\s*(\d+)\s+maximum resident set size\s*$/gm)];
  if (timings.length !== 1 || memory.length !== 1) return unavailable;
  const userCpuMs = Number(timings[0][1]) * 1000;
  const systemCpuMs = Number(timings[0][2]) * 1000;
  const peakRssBytes = kind === "gnu_time" ? Number(memory[0][3]) * 1024 : Number(memory[0][1]);
  if (![userCpuMs, systemCpuMs, peakRssBytes].every((value) => Number.isFinite(value) && value <= Number.MAX_SAFE_INTEGER) ||
      !Number.isSafeInteger(peakRssBytes) || peakRssBytes <= 0) return unavailable;
  return { status: "measured", backend: kind, userCpuMs, systemCpuMs, peakRssBytes };
}

export const localMeasurementEnvironment = () => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C", NODE_ENV: "test" as const,
});

type CapturedProcess = {
  outcome: "succeeded" | "failed"; exitCode: number | null; signal: NodeJS.Signals | null;
  failure: "timeout" | "output_limit" | "spawn_failed" | "nonzero_exit" | null;
  wallTimeMs: number; stdout: Buffer; stderr: string;
};

/** Internal bounded capture. Raw bytes must never enter a report. Each launch owns its POSIX process group. */
export async function captureLocalProcess(command: string, args: readonly string[], timeoutMs: number): Promise<CapturedProcess> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("Invalid process timeout.");
  if (platform() !== "darwin" && platform() !== "linux") throw new Error("Local process measurements require macOS or Linux.");
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      env: localMeasurementEnvironment(), stdio: ["ignore", "pipe", "pipe"], detached: true,
    });
    const stdout: Buffer[] = [];
    let stderr = "";
    let bytes = 0;
    let failure: CapturedProcess["failure"] = null;
    const stop = (reason: CapturedProcess["failure"]) => {
      failure ??= reason;
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch { child.kill("SIGKILL"); }
      }
    };
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    const collect = (stream: "stdout" | "stderr", chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { stop("output_limit"); return; }
      if (stream === "stdout") stdout.push(chunk);
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.on("error", () => { failure = "spawn_failed"; });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      failure ??= exitCode === 0 ? null : "nonzero_exit";
      resolve({ outcome: failure ? "failed" : "succeeded", exitCode, signal, failure,
        wallTimeMs: Math.round((performance.now() - started) * 1000) / 1000, stdout: Buffer.concat(stdout), stderr });
    });
  });
}

/** Probe before work; never rerun an encoder merely because a timer is absent or unrecognized. */
export async function detectResourceBackend(): Promise<ResourceBackend> {
  let kind: NativeTimeKind;
  let version: string;
  if (platform() === "darwin") {
    kind = "darwin_time";
    version = `macOS system time; Darwin ${release()}`;
  } else if (platform() === "linux") {
    const probe = await captureLocalProcess("/usr/bin/time", ["--version"], 5000);
    if (probe.outcome !== "succeeded" || !/GNU [Tt]ime/.test(probe.stdout.toString("utf8"))) {
      return { kind: "unavailable", reason: "native_timer_unavailable" };
    }
    kind = "gnu_time";
    version = probe.stdout.toString("utf8").split(/\r?\n/)[0];
  } else return { kind: "unavailable", reason: "unsupported_platform" };
  const backend = { kind, version };
  const probe = await captureLocalProcess("/usr/bin/time", timeArgs(kind, process.execPath, ["-e", ""]), 5000);
  return probe.outcome === "succeeded" && parseNativeTime(kind, probe.stderr).status === "measured"
    ? backend : { kind: "unavailable", reason: "native_timer_unavailable" };
}

function timeArgs(kind: NativeTimeKind, command: string, args: readonly string[]) {
  return kind === "darwin_time" ? ["-l", command, ...args]
    : ["-f", "CODEX_NATIVE_TIME %U %S %M", "--", command, ...args];
}

export async function runMeasuredProcess(
  command: string,
  args: readonly string[],
  options: { backend: ResourceBackend; timeoutMs: number },
) {
  const { backend } = options;
  const captured = backend.kind === "unavailable"
    ? await captureLocalProcess(command, args, options.timeoutMs)
    : await captureLocalProcess("/usr/bin/time", timeArgs(backend.kind, command, args), options.timeoutMs);
  const resources: ResourceMeasurement = backend.kind === "unavailable"
    ? { status: "unavailable", reason: backend.reason }
    : captured.failure === "timeout" || captured.failure === "output_limit" || captured.failure === "spawn_failed"
      ? { status: "unavailable", reason: "command_did_not_complete" }
      : parseNativeTime(backend.kind, captured.stderr);
  // Raw process output can contain paths and metadata. It is not part of a measurement report.
  return { outcome: captured.outcome, exitCode: captured.exitCode, signal: captured.signal,
    failure: captured.failure, wallTimeMs: captured.wallTimeMs, resources };
}

export async function localFfmpegVersion() {
  const result = await captureLocalProcess("ffmpeg", ["-version"], 5000);
  if (result.outcome !== "succeeded") throw new Error("FFmpeg is not available.");
  return result.stdout.toString("utf8").split(/\r?\n/)[0];
}
