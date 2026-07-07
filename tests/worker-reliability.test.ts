import { describe, expect, it } from "vitest";
import {
  assertWorkerRuntimeReady,
  checkWorkerRuntimeEnvironment,
  retryDelayMsForAttempt,
  retryRunAfter,
  staleCutoff,
} from "@/lib/worker/reliability";

describe("worker reliability helpers", () => {
  it("uses bounded retry delays by attempt", () => {
    expect(retryDelayMsForAttempt(0)).toBe(15_000);
    expect(retryDelayMsForAttempt(1)).toBe(15_000);
    expect(retryDelayMsForAttempt(2)).toBe(60_000);
    expect(retryDelayMsForAttempt(99)).toBe(5 * 60_000);
  });

  it("computes retry and stale cutoff timestamps from the supplied clock", () => {
    const now = new Date("2026-07-07T15:00:00.000Z");

    expect(retryRunAfter(2, now).toISOString()).toBe("2026-07-07T15:01:00.000Z");
    expect(staleCutoff(now, 10 * 60_000).toISOString()).toBe("2026-07-07T14:50:00.000Z");
  });

  it("requires a stable worker id in production", () => {
    const checks = checkWorkerRuntimeEnvironment({ NODE_ENV: "production" }, () => true, () => true);

    expect(checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "WORKER_ID", status: "fail" })]));
    expect(() => assertWorkerRuntimeReady({ NODE_ENV: "production" }, () => true, () => true)).toThrow(
      "WORKER_ID is required",
    );
  });

  it("requires production media and transcription binaries", () => {
    const checks = checkWorkerRuntimeEnvironment(
      {
        NODE_ENV: "production",
        WORKER_ID: "worker-1",
        FFMPEG_PATH: "missing-ffmpeg",
        FFPROBE_PATH: "missing-ffprobe",
        WHISPER_CPP_BINARY: "missing-whisper",
        WHISPER_MODEL_PATH: "/models/missing.bin",
      },
      () => false,
      () => false,
    );

    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "FFMPEG_PATH", status: "fail" }),
        expect.objectContaining({ name: "FFPROBE_PATH", status: "fail" }),
        expect.objectContaining({ name: "WHISPER_CPP_BINARY", status: "fail" }),
        expect.objectContaining({ name: "WHISPER_MODEL_PATH", status: "fail" }),
      ]),
    );
  });

  it("accepts configured production worker runtime", () => {
    const checks = assertWorkerRuntimeReady(
      {
        NODE_ENV: "production",
        WORKER_ID: "worker-1",
        FFMPEG_PATH: "ffmpeg",
        FFPROBE_PATH: "ffprobe",
        WHISPER_CPP_BINARY: "whisper-cli",
        WHISPER_MODEL_PATH: "/models/ggml-base.en.bin",
      },
      () => true,
      () => true,
    );

    expect(checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "WORKER_ID", status: "ok" })]));
    expect(checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "FFMPEG_PATH", status: "ok" })]));
    expect(checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "FFPROBE_PATH", status: "ok" })]));
    expect(checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "WHISPER_CPP_BINARY", status: "ok" })]),
    );
    expect(checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "WHISPER_MODEL_PATH", status: "ok" })]),
    );
  });
});
