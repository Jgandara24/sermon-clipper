import { describe, expect, it } from "vitest";
import {
  assertWorkerRuntimeReady,
  automaticPublishingEnabled,
  checkWorkerRuntimeEnvironment,
  recordWorkerProcessHeartbeat,
  retryDelayMsForAttempt,
  retryRunAfter,
  runIsolatedPeriodicBlocks,
  staleCutoff,
} from "@/lib/worker/reliability";

describe("worker reliability helpers", () => {
  it("continues to the next periodic block after one block fails", async () => {
    const calls: string[] = [];
    const failures: string[] = [];
    await runIsolatedPeriodicBlocks(
      [
        {
          name: "cost_rollup",
          due: true,
          run: async () => {
            calls.push("cost_rollup");
            throw new Error("rollup failed");
          },
        },
        {
          name: "facebook_publish",
          due: true,
          run: async () => {
            calls.push("facebook_publish");
          },
        },
      ],
      async (name) => {
        failures.push(name);
      },
    );

    expect(calls).toEqual(["cost_rollup", "facebook_publish"]);
    expect(failures).toEqual(["cost_rollup"]);
  });

  it("lets the worker enter the publish block only for exact true", () => {
    expect(automaticPublishingEnabled({})).toBe(false);
    expect(automaticPublishingEnabled({ AUTOMATIC_PUBLISHING_ENABLED: "false" })).toBe(false);
    expect(automaticPublishingEnabled({ AUTOMATIC_PUBLISHING_ENABLED: "TRUE" })).toBe(false);
    expect(automaticPublishingEnabled({ AUTOMATIC_PUBLISHING_ENABLED: "true" })).toBe(true);
  });

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
        YTDLP_PATH: "missing-yt-dlp",
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
        expect.objectContaining({ name: "YTDLP_PATH", status: "fail" }),
        expect.objectContaining({ name: "WHISPER_CPP_BINARY", status: "fail" }),
        expect.objectContaining({ name: "WHISPER_MODEL_PATH", status: "fail" }),
      ]),
    );
  });

  // The worker gate follows the named policy, not whichever key is present. A Scribe-only
  // deployment must start without whisper assets; a whisper deployment must still require them
  // even when an ElevenLabs key happens to be in the environment.
  it("does not require local whisper assets when the policy names Scribe alone", () => {
    const checks = checkWorkerRuntimeEnvironment(
      {
        NODE_ENV: "production",
        WORKER_ID: "worker-1",
        TRANSCRIPTION_PRIMARY_PROVIDER: "scribe",
        TRANSCRIPTION_FALLBACK_PROVIDER: "none",
        ELEVENLABS_API_KEY: "scribe-test-key",
      },
      (command) => command !== "whisper-cli",
      () => true,
    );

    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "WHISPER_CPP_BINARY", status: "ok" }),
        expect.objectContaining({ name: "WHISPER_MODEL_PATH", status: "ok" }),
      ]),
    );
  });

  it("still requires whisper assets when the policy names whisper.cpp, key present or not", () => {
    const checks = checkWorkerRuntimeEnvironment(
      {
        NODE_ENV: "production",
        WORKER_ID: "worker-1",
        TRANSCRIPTION_PRIMARY_PROVIDER: "whisper_cpp",
        ELEVENLABS_API_KEY: "present-but-not-selected",
      },
      (command) => command !== "whisper-cli",
      () => false,
    );

    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "WHISPER_CPP_BINARY", status: "fail" }),
        expect.objectContaining({ name: "WHISPER_MODEL_PATH", status: "fail" }),
      ]),
    );
  });

  it("requires whisper assets when the policy names it only as the fallback", () => {
    const checks = checkWorkerRuntimeEnvironment(
      {
        NODE_ENV: "production",
        WORKER_ID: "worker-1",
        TRANSCRIPTION_PRIMARY_PROVIDER: "scribe",
        TRANSCRIPTION_FALLBACK_PROVIDER: "whisper_cpp",
        ELEVENLABS_API_KEY: "scribe-test-key",
      },
      (command) => command !== "whisper-cli",
      () => false,
    );

    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "WHISPER_CPP_BINARY", status: "fail" }),
      ]),
    );
  });

  it("fails an unparseable transcription policy at worker startup", () => {
    const checks = checkWorkerRuntimeEnvironment(
      { NODE_ENV: "production", WORKER_ID: "worker-1", TRANSCRIPTION_PRIMARY_PROVIDER: "deepgram" },
      () => true,
      () => true,
    );

    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "TRANSCRIPTION_PROVIDER", status: "fail" }),
      ]),
    );
  });

  it("probes yt-dlp with --version (yt-dlp rejects ffmpeg-style -version)", () => {
    const probed: Array<{ command: string; versionFlag?: string }> = [];
    checkWorkerRuntimeEnvironment(
      { NODE_ENV: "production", WORKER_ID: "worker-1" },
      (command, versionFlag) => {
        probed.push({ command, versionFlag });
        return true;
      },
      () => true,
    );

    expect(probed).toEqual(
      expect.arrayContaining([{ command: "yt-dlp", versionFlag: "--version" }]),
    );
    expect(probed.filter((call) => call.command !== "yt-dlp").every((call) => call.versionFlag === undefined)).toBe(
      true,
    );
  });

  it("accepts configured production worker runtime", () => {
    const checks = assertWorkerRuntimeReady(
      {
        NODE_ENV: "production",
        WORKER_ID: "worker-1",
        FFMPEG_PATH: "ffmpeg",
        FFPROBE_PATH: "ffprobe",
        YTDLP_PATH: "yt-dlp",
        WHISPER_CPP_BINARY: "whisper-cli",
        WHISPER_MODEL_PATH: "/models/ggml-base.en.bin",
      },
      () => true,
      () => true,
    );

    expect(checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "WORKER_ID", status: "ok" })]));
    expect(checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "FFMPEG_PATH", status: "ok" })]));
    expect(checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "FFPROBE_PATH", status: "ok" })]));
    expect(checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "YTDLP_PATH", status: "ok" })]));
    expect(checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "WHISPER_CPP_BINARY", status: "ok" })]),
    );
    expect(checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "WHISPER_MODEL_PATH", status: "ok" })]),
    );
  });

  it("upserts durable worker process heartbeats by worker id", async () => {
    const originalWorkerId = process.env.WORKER_ID;
    process.env.WORKER_ID = "worker-test-1";
    const upsertCalls: unknown[] = [];
    const client = {
      workerHeartbeat: {
        upsert: async (args: unknown) => {
          upsertCalls.push(args);
          return args;
        },
      },
    };

    try {
      const now = new Date("2026-07-07T20:00:00.000Z");
      await recordWorkerProcessHeartbeat(client as never, { pollIntervalMs: 2000 }, now);

      expect(upsertCalls).toHaveLength(1);
      expect(upsertCalls[0]).toEqual(
        expect.objectContaining({
          where: { workerId: "worker-test-1" },
          create: expect.objectContaining({
            workerId: "worker-test-1",
            startedAt: now,
            lastSeenAt: now,
            metadata: { pollIntervalMs: 2000 },
          }),
          update: expect.objectContaining({
            lastSeenAt: now,
            metadata: { pollIntervalMs: 2000 },
          }),
        }),
      );
    } finally {
      if (originalWorkerId === undefined) delete process.env.WORKER_ID;
      else process.env.WORKER_ID = originalWorkerId;
    }
  });
});
