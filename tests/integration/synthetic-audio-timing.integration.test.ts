import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { localMeasurementEnvironment } from "@/lib/evaluation/local-process-measurement";
import { compareSyntheticAudio, measureSyntheticAudio } from "@/lib/evaluation/synthetic-audio-timing";

const exec = promisify(execFile);
const options = { env: localMeasurementEnvironment(), timeout: 60000, maxBuffer: 1024 * 1024, killSignal: "SIGKILL" as const };
const script = "scripts/benchmark-local-audio-timing.ts";

it("runs the standalone CLI and keeps sample padding, clocks, event scope, resources, and cleanup explicit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "audio-timing-cli-test-"));
  const output = path.join(directory, "report.json");
  const args = ["--import", "tsx", script, "--output", output];
  try {
    await exec(process.execPath, args, { ...options, env: { ...options.env, TMPDIR: directory } });
    const text = await readFile(output, "utf8"); const report = JSON.parse(text);
    expect(report).toMatchObject({ outcome: "succeeded", failure: null, evidenceType: "synthetic_local_audio_event_benchmark",
      storage: { cleanup: "removed", peakDiskBytes: null },
      review: { sourceContentMapping: "NOT_VERIFIED", audioQuality: "NOT_REVIEWED", captionAccuracy: "NOT_REVIEWED", audiovisualSync: "NOT_VERIFIED" } });
    expect(report.stages).toHaveLength(5);
    for (const stage of report.stages) expect(stage.measurement).toMatchObject({ outcome: "succeeded", resources: { status: "measured" } });
    expect(report.observations).toHaveLength(4); expect(report.comparisons).toHaveLength(3);
    for (const { observation } of report.observations) {
      expect(observation).toMatchObject({ status: "observed", clocks: { containerStartMs: 0, audioStartMs: 0, firstFrameMs: 0 },
        inspection: { cpuAndMemory: "NOT_MEASURED" } });
      expect(observation.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(observation.decodedSamples).toBe(observation.probedSamples);
      expect(observation.maximumClockErrorMs).toBeLessThanOrEqual(0.001);
      expect(observation.inspection.probeWallTimeMs).toBeGreaterThan(0);
      expect(observation.inspection.decodeWallTimeMs).toBeGreaterThan(0);
    }
    const [source, same, resampled, range] = report.observations.map(({ observation }: { observation: { sampleRateHz: number; event: { startMs: number }; decodedSamples: number; decodedDurationMs: number; containerDurationMs: number } }) => observation);
    expect([source.sampleRateHz, same.sampleRateHz, resampled.sampleRateHz, range.sampleRateHz]).toEqual([48000, 48000, 16000, 16000]);
    expect(source.decodedDurationMs).toBeGreaterThan(source.containerDurationMs);
    expect(source.decodedSamples).toBe(same.decodedSamples);
    expect(range.event.startMs).toBeCloseTo(1000, 2);
    for (const { comparison } of report.comparisons) {
      expect(comparison).toMatchObject({ status: "matched", scope: "synthetic_audio_event_only" });
      expect(Math.abs(comparison.startDeltaMs)).toBeLessThanOrEqual(comparison.toleranceMs);
      expect(Math.abs(comparison.endDeltaMs)).toBeLessThanOrEqual(comparison.toleranceMs);
    }
    expect(text).not.toContain(directory); expect(text).not.toContain("sermon-audio-timing-");
    expect((await readdir(directory)).filter((name) => name.startsWith("sermon-audio-timing-"))).toEqual([]);
    await expect(exec(process.execPath, args, { ...options, env: { ...options.env, PATH: "/nonexistent" } })).rejects.toThrow();
    expect(await readFile(output, "utf8")).toBe(text);
    for (const extra of [["--source", "https://example.invalid/audio"], ["--duration-seconds", "100"]]) {
      const rejected = path.join(directory, "rejected.json");
      await expect(exec(process.execPath, ["--import", "tsx", script, "--output", rejected, ...extra], options)).rejects.toThrow();
      await expect(readFile(rejected)).rejects.toThrow();
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 90000);

it("does not match encoded shifted, absent, repeated, or nonzero-clock audio", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "audio-timing-negative-"));
  const source = path.join(directory, "source.m4a");
  const tone = "0.5*sin(2*PI*440*n/48000)";
  const encode = async (name: string, gate: string, extra: string[] = []) => {
    const file = path.join(directory, `${name}.m4a`);
    await exec("ffmpeg", ["-nostdin", "-v", "error", "-n", "-f", "lavfi", "-i",
      `aevalsrc='if(${gate},${tone},0)':s=48000:d=4`, "-c:a", "aac", "-b:a", "128k", ...extra, file], options);
    return file;
  };
  try {
    await encode("source", "between(n,96000,105599)");
    const original = await readFile(source);
    const observedSource = await measureSyntheticAudio(source);
    expect(observedSource.status).toBe("observed");
    const wrong = path.join(directory, "wrong.flac");
    await exec("ffmpeg", ["-nostdin", "-v", "error", "-n", "-i", source, "-ss", "0.5", "-t", "2", "-ar", "16000", "-c:a", "flac", wrong], options);
    expect(compareSyntheticAudio(observedSource, await measureSyntheticAudio(wrong), { sourceStartMs: 1000, sourceEndMs: 3000 }))
      .toMatchObject({ status: "mismatch", reason: "artifact_event_mismatch", startDeltaMs: 500 });
    const absent = await encode("absent", "0");
    const repeated = await encode("repeated", "between(n,96000,105599)+between(n,24000,33599)");
    const nonzero = await encode("nonzero", "between(n,96000,105599)", ["-output_ts_offset", "1"]);
    for (const [file, reason] of [[absent, "event_absent"], [repeated, "event_ambiguous_or_truncated"], [nonzero, "unsupported_nonzero_start"]]) {
      const observation = await measureSyntheticAudio(file);
      expect(observation).toMatchObject({ status: "unavailable", reason, event: null });
      expect(compareSyntheticAudio(observedSource, observation, { sourceStartMs: 0, sourceEndMs: 4000 }).status).toBe("unavailable");
      expect(JSON.stringify(observation)).not.toContain(directory);
    }
    expect(await readFile(source)).toEqual(original);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60000);

it.each(["probe", "decode", "encode"])("writes a failed redacted report after a %s failure and preserves unrelated files", async (failure) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "audio-timing-failure-"));
  const output = path.join(directory, "report.json");
  try {
    const command = failure === "probe" ? "ffprobe" : "ffmpeg";
    const { stdout } = await exec("/usr/bin/which", [command], options);
    const wrapper = path.join(directory, command);
    const predicate = failure === "probe" ? "args.includes('-show_entries')" : failure === "decode" ? "args.includes('pipe:1')" : "args.includes('lavfi')";
    await writeFile(wrapper, `#!${process.execPath}\nconst {spawnSync}=require('node:child_process'); const args=process.argv.slice(2);
if (${predicate}) { process.stderr.write('private marker failure data'); process.exit(7); }
const p=spawnSync(${JSON.stringify(stdout.trim())},args,{stdio:'inherit'}); process.exit(p.status ?? 1);\n`);
    await chmod(wrapper, 0o700);
    await expect(exec(process.execPath, ["--import", "tsx", script, "--output", output], { ...options,
      env: { ...options.env, PATH: `${directory}:${options.env.PATH}`, TMPDIR: directory } })).rejects.toThrow();
    const text = await readFile(output, "utf8"); const report = JSON.parse(text);
    expect(report).toMatchObject({ outcome: "failed", failure: failure === "encode" ? "pcm_generation_failed" : "audio_observation_failed",
      storage: { cleanup: "removed" } });
    expect(report.observations).toHaveLength(failure === "encode" ? 0 : 4);
    expect(report.comparisons).toHaveLength(failure === "encode" ? 0 : 3);
    for (const { observation } of report.observations) expect(observation).toMatchObject({ status: "unavailable", reason: `${failure}_nonzero_exit` });
    for (const { comparison } of report.comparisons) expect(comparison.status).toBe("unavailable");
    expect(text).not.toContain(directory); expect(text).not.toContain("private marker failure data");
    expect(await readFile(wrapper, "utf8")).toContain("private marker failure data");
    expect((await readdir(directory)).filter((name) => name.startsWith("sermon-audio-timing-"))).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60000);
