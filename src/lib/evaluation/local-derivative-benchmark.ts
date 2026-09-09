import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { arch, platform, release, tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { measureLocalMedia } from "@/lib/evaluation/local-media-measurement";
import { detectResourceBackend, localFfmpegVersion, runMeasuredProcess,
  type ResourceBackend } from "@/lib/evaluation/local-process-measurement";

export const syntheticBenchmarkInput = z.object({ durationSeconds: z.number().int().min(2).max(10).default(4) }).strict();
type CommandMeasurement = Awaited<ReturnType<typeof runMeasuredProcess>>;
type Stage = { id: string; command: { executable: "ffmpeg"; args: string[] }; measurement: CommandMeasurement };

/** Synthetic media only. No input URL, user recording, database, or storage-provider path. */
export async function benchmarkLocalDerivatives(rawInput: unknown = {}) {
  const { durationSeconds } = syntheticBenchmarkInput.parse(rawInput);
  const stages: Stage[] = [];
  const artifacts: Awaited<ReturnType<typeof measureLocalMedia>>[] = [];
  let backend: ResourceBackend = { kind: "unavailable", reason: "not_probed" };
  let ffmpeg: string | null = null;
  let directory: string | null = null;
  let failure: string | null = null;
  let retainedMediaBytesBeforeCleanup: number | null = null;
  let cleanup: "not_created" | "removed" | "failed" = "not_created";
  let phase = "prerequisites";
  try {
    ffmpeg = await localFfmpegVersion();
    backend = await detectResourceBackend();
    directory = await mkdtemp(path.join(tmpdir(), "sermon-derivative-benchmark-"));
    const source = path.join(directory, "source.mp4");
    const proxy = path.join(directory, "proxy.mp4");
    const audio = path.join(directory, "audio.flac");
    const range = path.join(directory, "range.mp4");
    const paths = new Map([[source, "<source.mp4>"], [proxy, "<proxy.mp4>"], [audio, "<audio.flac>"], [range, "<range.mp4>"]]);
    const run = async (id: string, args: string[]) => {
      phase = id;
      const fullArgs = ["-nostdin", "-hide_banner", "-v", "error", "-n", ...args];
      const measurement = await runMeasuredProcess("ffmpeg", fullArgs, { backend, timeoutMs: 60_000 });
      stages.push({ id, command: { executable: "ffmpeg", args: fullArgs.map((arg) => paths.get(arg) ?? arg) }, measurement });
      if (measurement.outcome !== "succeeded") throw new Error("Local command failed.");
    };
    // The red box appears halfway through the known source clock. It is a test marker, not a label.
    await run("source_generation", [
      "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=30:duration=${durationSeconds}`,
      "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${durationSeconds}`,
      "-vf", `drawbox=x=0:y=0:w=80:h=80:color=red:t=fill:enable='gte(t,${durationSeconds / 2})'`,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-shortest", source,
    ]);
    const inputArgs = ["-protocol_whitelist", "file,pipe", "-format_whitelist", "mov", "-i", source];
    await run("full_source_proxy", [...inputArgs, "-map", "0:v:0", "-map", "0:a:0",
      "-vf", "scale=320:180", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k", proxy]);
    await run("full_source_audio", [...inputArgs, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "flac", audio]);
    await run("middle_half_range", [...inputArgs, "-ss", String(durationSeconds / 4), "-t", String(durationSeconds / 2),
      "-map", "0:v:0", "-map", "0:a:0", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", range]);
    phase = "media_inspection";
    for (const artifact of [
      { artifactFile: proxy, artifactId: "synthetic-full-proxy", kind: "proxy" as const, sourceStartMs: 0, sourceEndMs: durationSeconds * 1000 },
      { artifactFile: audio, artifactId: "synthetic-full-audio", kind: "audio" as const, sourceStartMs: 0, sourceEndMs: durationSeconds * 1000 },
      { artifactFile: range, artifactId: "synthetic-middle-half", kind: "range" as const, sourceStartMs: durationSeconds * 250, sourceEndMs: durationSeconds * 750 },
    ]) artifacts.push(await measureLocalMedia({ sourceFile: source, ...artifact }));
    const sizes = await Promise.all([source, proxy, audio, range].map(async (file) => (await stat(file)).size));
    retainedMediaBytesBeforeCleanup = sizes.reduce((total, size) => total + size, 0);
  } catch {
    failure = `${phase}_failed`;
  } finally {
    if (directory) {
      try { await rm(directory, { recursive: true, force: true }); cleanup = "removed"; }
      catch { cleanup = "failed"; failure ??= "cleanup_failed"; }
    }
  }
  return {
    schemaVersion: 1, evidenceType: "synthetic_local_derivative_benchmark", recordedAt: new Date().toISOString(),
    outcome: failure ? "failed" : "succeeded", failure,
    tools: { ffmpeg, node: process.version, platform: platform(), release: release(), arch: arch(), resourceBackend: backend },
    fixture: { durationSeconds, width: 640, height: 360, fps: 30, markerAtMs: durationSeconds * 500,
      sourceKind: "generated_test_pattern_and_sine", encodingPolicy: "experimental_fixture_v1" },
    stages, artifacts,
    storage: { retainedMediaBytesBeforeCleanup, peakDiskBytes: null, cleanup },
    review: { visualQuality: "NOT_REVIEWED", captionAccuracy: "NOT_REVIEWED", sourceContentMapping: "NOT_VERIFIED" },
    unmeasured: ["exact_disk_peak", "remote_transfer", "provider_cost", "production_cost", "human_quality"],
    limits: [
      "Synthetic engineering measurements only. No P2 proof or P4 acceptance is recorded.",
      "Each derivative independently reads the same local source. This does not test a shared cache or coordinated build.",
      "Stage wall time uses a monotonic parent clock around launch through close; CPU and RSS come from the timed command's OS accounting.",
      "Native time CPU fields have limited precision; a reported zero can be below the timer resolution.",
      "RSS is the OS maximum for the timed command, not total host memory or a simultaneous process-tree peak.",
      "Source generation, each derivation, and later media inspection are separate measurements. Do not double-count them.",
      "Stored bytes are measured only after all outputs exist. Peak disk, filesystem allocation, and cache effects are not measured.",
      "Full-source proxy/audio and the middle-half range have different purposes. The partial range's size ratio is not encoding savings.",
      "The marker and declared interval do not independently verify content alignment. Quality and mapping remain unreviewed.",
      "Encoding parameters are fixed test candidates, not selected production settings. Cleanup removes only this run's media; check the reported cleanup result.",
    ],
  };
}

/** Reserve the destination before any work. An existing report is never replaced. */
export async function writeLocalDerivativeBenchmark(output: string, input: unknown = {}) {
  const checked = syntheticBenchmarkInput.parse(input);
  const handle = await open(output, "wx");
  try {
    const report = await benchmarkLocalDerivatives(checked);
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally { await handle.close(); }
}
