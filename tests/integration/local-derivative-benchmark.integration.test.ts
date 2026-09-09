import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { detectResourceBackend, localMeasurementEnvironment, runMeasuredProcess } from "@/lib/evaluation/local-process-measurement";

const exec = promisify(execFile);

it("benchmarks generated files through the CLI, records child resources, and removes all generated media", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "benchmark-cli-test-"));
  const output = path.join(directory, "report.json");
  const env = { ...localMeasurementEnvironment(), TMPDIR: directory };
  const args = ["--import", "tsx", "scripts/benchmark-local-derivatives.ts", "--output", output, "--observe-marker"];
  try {
    await exec(process.execPath, args, { env, timeout: 60_000, killSignal: "SIGKILL" });
    const text = await readFile(output, "utf8");
    const report = JSON.parse(text);
    expect(report).toMatchObject({ outcome: "succeeded", evidenceType: "synthetic_local_derivative_benchmark",
      fixture: { durationSeconds: 4, sourceKind: "generated_test_pattern_and_sine", markerAtMs: 2000 },
      storage: { peakDiskBytes: null, cleanup: "removed" },
      review: { visualQuality: "NOT_REVIEWED", sourceContentMapping: "NOT_VERIFIED", captionAccuracy: "NOT_REVIEWED" } });
    expect(report.stages.map((stage: { id: string }) => stage.id)).toEqual([
      "source_generation", "full_source_proxy", "full_source_audio", "middle_half_range",
    ]);
    // Both macOS and CI Linux must demonstrate real native measurement, not pass via an unavailable branch.
    for (const stage of report.stages) {
      expect(stage.measurement).toMatchObject({ outcome: "succeeded", exitCode: 0, resources: { status: "measured" } });
      expect(stage.measurement.wallTimeMs).toBeGreaterThan(0);
      expect(stage.measurement.resources.userCpuMs + stage.measurement.resources.systemCpuMs).toBeGreaterThan(0);
      expect(stage.measurement.resources.peakRssBytes).toBeGreaterThan(1_000_000);
    }
    expect(report.artifacts).toHaveLength(3);
    expect(report.markerTiming).toMatchObject({ requested: true, scope: "synthetic_marker_event_only" });
    expect(report.markerTiming.observations).toHaveLength(3);
    for (const { observation } of report.markerTiming.observations) {
      expect(observation).toMatchObject({ status: "observed", clocks: { containerStartMs: 0, videoStartMs: 0, firstFrameMs: 0 },
        inspection: { cpuAndMemory: "NOT_MEASURED" } });
      expect(observation.probedFrameCount).toBe(observation.decodedFrameCount);
      expect(observation.inspection.probeWallTimeMs).toBeGreaterThan(0);
      expect(observation.inspection.decodeWallTimeMs).toBeGreaterThan(0);
    }
    expect(report.markerTiming.comparisons.map(({ comparison }: { comparison: { status: string; observedEventMs: number } }) =>
      [comparison.status, comparison.observedEventMs])).toEqual([["matched", 2000], ["matched", 1000]]);
    const [proxy, audio, range] = report.artifacts;
    expect(proxy.artifact.probe.video).toMatchObject({ width: 320, height: 180, codec: "h264" });
    expect(audio.artifact.probe.audio).toMatchObject({ channels: 1, sampleRateHz: 16000, codec: "flac" });
    expect(range.artifact.probe.video).toMatchObject({ width: 640, height: 360 });
    expect(range.declaredMapping).toMatchObject({ sourceStartMs: 1000, sourceEndMs: 3000, verification: "NOT_VERIFIED" });
    expect(proxy.source.sha256).toBe(audio.source.sha256);
    expect(audio.source.sha256).toBe(range.source.sha256);
    expect(report.storage.retainedMediaBytesBeforeCleanup).toBe(proxy.source.bytes +
      report.artifacts.reduce((sum: number, artifact: { artifact: { bytes: number } }) => sum + artifact.artifact.bytes, 0));
    expect(text).not.toContain(directory);
    expect(text).not.toContain("sermon-derivative-benchmark-");
    expect((await readdir(directory)).filter((name) => name.startsWith("sermon-derivative-benchmark-"))).toEqual([]);
    // Refuse before invoking ffmpeg, even when a caller repeats a completed command.
    await expect(exec(process.execPath, args, { env: { ...env, PATH: "/nonexistent" }, timeout: 5000 })).rejects.toThrow();
    expect(await readFile(output, "utf8")).toBe(text);
    expect((await readdir(directory)).filter((name) => name.startsWith("sermon-derivative-benchmark-"))).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 90_000);

it("records a failed encoder without exposing raw output and cleans its owned directory", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "benchmark-failure-test-"));
  const binary = path.join(directory, "ffmpeg");
  const output = path.join(directory, "failure.json");
  try {
    await writeFile(binary, '#!/bin/sh\nif [ "$1" = "-version" ]; then echo "ffmpeg version test-failure"; exit 0; fi\necho "private source path and token must not enter reports" >&2\nexit 7\n');
    await chmod(binary, 0o700);
    await expect(exec(process.execPath, ["--import", "tsx", "scripts/benchmark-local-derivatives.ts", "--output", output], {
      env: { ...localMeasurementEnvironment(), PATH: directory, TMPDIR: directory }, timeout: 15_000,
    })).rejects.toThrow();
    const text = await readFile(output, "utf8");
    const report = JSON.parse(text);
    expect(report).toMatchObject({ outcome: "failed", failure: "source_generation_failed", artifacts: [],
      markerTiming: { requested: false, observations: [], comparisons: [] },
      storage: { cleanup: "removed", retainedMediaBytesBeforeCleanup: null } });
    expect(report.stages).toHaveLength(1);
    expect(report.stages[0].measurement).toMatchObject({ outcome: "failed", exitCode: 7 });
    expect(text).not.toContain("private source path");
    expect(text).not.toContain(directory);
    expect(await readFile(binary, "utf8")).toContain("test-failure");
    expect((await readdir(directory)).filter((name) => name.startsWith("sermon-derivative-benchmark-"))).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("kills the timed command's process group on timeout and bounds captured output", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "benchmark-timeout-test-"));
  const marker = path.join(directory, "orphan-survived");
  const ready = path.join(directory, "child-ready");
  const grandchild = `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad'),2000)`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  try {
    const backend = await detectResourceBackend();
    expect(backend.kind).not.toBe("unavailable");
    const timed = await runMeasuredProcess(process.execPath, ["-e", parent], { backend, timeoutMs: 1000 });
    expect(timed).toMatchObject({ outcome: "failed", failure: "timeout", resources: { status: "unavailable" } });
    expect(await readFile(ready, "utf8")).toBe("ready");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await expect(readFile(marker)).rejects.toThrow();
    const noisy = await runMeasuredProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(2*1024*1024));setInterval(()=>{},1000)"],
      { backend, timeoutMs: 5000 });
    expect(noisy).toMatchObject({ outcome: "failed", failure: "output_limit", resources: { status: "unavailable" } });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 15_000);

it("refuses external input and invalid duration before creating a report", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "benchmark-input-test-"));
  try {
    for (const extra of [["--source", "https://example.invalid/video.mp4"], ["--duration-seconds", "999"], ["--duration-seconds", "NaN"]]) {
      await expect(exec(process.execPath, ["--import", "tsx", "scripts/benchmark-local-derivatives.ts", "--output", path.join(directory, "report.json"), ...extra],
        { env: localMeasurementEnvironment(), timeout: 5000 })).rejects.toThrow();
      expect(await readdir(directory)).toEqual([]);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
