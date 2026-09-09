import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { localMeasurementEnvironment } from "@/lib/evaluation/local-process-measurement";
import { benchmarkLocalDerivatives } from "@/lib/evaluation/local-derivative-benchmark";
import { compareSyntheticMarker, measureSyntheticMarker } from "@/lib/evaluation/synthetic-marker-timing";

const exec = promisify(execFile);
const options = { env: localMeasurementEnvironment(), timeout: 30_000, killSignal: "SIGKILL" as const, maxBuffer: 1024 * 1024 };
const mapping = { sourceStartMs: 1000, sourceEndMs: 3000, fixtureMarkerAtMs: 2000 };

it("rejects encoded wrong-range, missing, flickering, and nonzero-start fixtures", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "marker-negative-test-"));
  const source = path.join(directory, "source.mp4");
  const encode = async (name: string, filter: string, extras: string[] = []) => {
    const file = path.join(directory, `${name}.mp4`);
    await exec("ffmpeg", ["-nostdin", "-v", "error", "-n", "-f", "lavfi", "-i", "color=c=blue:s=640x360:r=30:d=4",
      "-vf", filter, "-an", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", ...extras, file], options);
    return file;
  };
  try {
    await encode("source", "drawbox=x=0:y=0:w=80:h=80:color=red:t=fill:enable='gte(t,2)'");
    const sourceBytes = await readFile(source);
    const sourceObservation = await measureSyntheticMarker(source, 80);
    expect(sourceObservation).toMatchObject({ status: "observed", eventMs: 2000 });
    const wrongRange = path.join(directory, "wrong-range.mp4");
    // The declared interval remains 1..3 seconds, but these bytes actually come from 0.5..2.5.
    await exec("ffmpeg", ["-nostdin", "-v", "error", "-n", "-i", source, "-ss", "0.5", "-t", "2",
      "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", wrongRange], options);
    const wrong = await measureSyntheticMarker(wrongRange, 80);
    expect(wrong).toMatchObject({ status: "observed", eventMs: 1500 });
    expect(compareSyntheticMarker(sourceObservation, wrong, mapping)).toMatchObject({ status: "mismatch", deltaMs: 500 });
    const absent = await encode("absent", "null");
    const flicker = await encode("flicker", "drawbox=x=0:y=0:w=80:h=80:color=red:t=fill:enable='between(t,2,2.5)'");
    const offset = await encode("offset", "drawbox=x=0:y=0:w=80:h=80:color=red:t=fill:enable='gte(t,2)'", ["-output_ts_offset", "1"]);
    for (const [file, reason] of [[absent, "marker_absent"], [flicker, "marker_ambiguous"], [offset, "unsupported_nonzero_start"]]) {
      const observation = await measureSyntheticMarker(file, 80);
      expect(observation).toMatchObject({ status: "unavailable", reason, eventMs: null });
      expect(compareSyntheticMarker(sourceObservation, observation, mapping).status).toBe("unavailable");
      if (file === offset) expect(observation).toMatchObject({ clocks: { containerStartMs: 1000, videoStartMs: 1000, firstFrameMs: 1000 },
        inspection: { decodeWallTimeMs: null } });
      expect(JSON.stringify(observation)).not.toContain(directory);
    }
    expect(await readFile(source)).toEqual(sourceBytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it.each([2, 3, 10])("observes the fixture event for a %i-second benchmark without asserting full alignment", async (durationSeconds) => {
  const report = await benchmarkLocalDerivatives({ durationSeconds, observeMarker: true });
  expect(report).toMatchObject({ outcome: "succeeded", storage: { cleanup: "removed" },
    review: { visualQuality: "NOT_REVIEWED", sourceContentMapping: "NOT_VERIFIED", captionAccuracy: "NOT_REVIEWED" } });
  expect(report.markerTiming.comparisons).toHaveLength(2);
  for (const { comparison } of report.markerTiming.comparisons) {
    expect(comparison.status).toBe("matched");
    expect(Math.abs(comparison.deltaMs!)).toBeLessThanOrEqual(comparison.toleranceMs!);
  }
}, 60_000);

it("writes a failed, redacted benchmark report when requested marker clocks are unavailable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "marker-clock-failure-"));
  const output = path.join(directory, "report.json");
  try {
    const { stdout } = await exec("/usr/bin/which", ["ffprobe"], options);
    const realProbe = stdout.trim();
    const wrapper = path.join(directory, "ffprobe");
    // Only the marker probe is invalid; normal media inspection still uses the real executable.
    await writeFile(wrapper, `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');
const args=process.argv.slice(2);
if(args.includes('format=start_time:stream=width,height,start_time:frame=best_effort_timestamp_time')) {
  process.stdout.write(JSON.stringify({format:{private:'must not appear'},streams:[],frames:[]}));
} else { const p=spawnSync(${JSON.stringify(realProbe)},args,{stdio:'inherit'}); process.exit(p.status ?? 1); }\n`);
    await chmod(wrapper, 0o700);
    await expect(exec(process.execPath, ["--import", "tsx", "scripts/benchmark-local-derivatives.ts",
      "--output", output, "--observe-marker"], { ...options,
      env: { ...options.env, PATH: `${directory}:${options.env.PATH}`, TMPDIR: directory } })).rejects.toThrow();
    const text = await readFile(output, "utf8");
    const report = JSON.parse(text);
    expect(report).toMatchObject({ outcome: "failed", failure: "marker_observation_failed", storage: { cleanup: "removed" },
      review: { sourceContentMapping: "NOT_VERIFIED", captionAccuracy: "NOT_REVIEWED" } });
    expect(report.markerTiming.comparisons).toHaveLength(2);
    for (const { comparison } of report.markerTiming.comparisons) expect(comparison.status).toBe("unavailable");
    expect(text).not.toContain(directory);
    expect(text).not.toContain("must not appear");
    expect(await readFile(wrapper, "utf8")).toContain("must not appear");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);
