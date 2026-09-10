import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { arch, platform, release, tmpdir } from "node:os";
import path from "node:path";
import { captureLocalProcess, detectResourceBackend, localFfmpegVersion, runMeasuredProcess,
  type ResourceBackend } from "@/lib/evaluation/local-process-measurement";
import { compareSyntheticAudio, measureSyntheticAudio } from "@/lib/evaluation/synthetic-audio-timing";

/** Companion fixture; the existing video/continuous-sine benchmark is unchanged. */
export async function benchmarkLocalAudioTiming() {
  const stages: { id: string; args: string[]; measurement: Awaited<ReturnType<typeof runMeasuredProcess>> }[] = [];
  const observations: { artifactId: string; observation: Awaited<ReturnType<typeof measureSyntheticAudio>> }[] = [];
  const comparisons: { artifactId: string; comparison: ReturnType<typeof compareSyntheticAudio> }[] = [];
  let directory: string | null = null; let failure: string | null = null; let phase = "prerequisites";
  let cleanup = "not_created";
  let retainedMediaBytesBeforeCleanup: number | null = null;
  let generatedPcm: { sha256: string; bytes: number } | null = null;
  let ffmpeg: string | null = null; let ffprobe: string | null = null;
  let backend: ResourceBackend = { kind: "unavailable", reason: "not_probed" };
  try {
    ffmpeg = await localFfmpegVersion();
    const version = await captureLocalProcess("ffprobe", ["-version"], 5000);
    if (version.outcome !== "succeeded") throw new Error("Missing ffprobe.");
    ffprobe = version.stdout.toString("utf8").split(/\r?\n/)[0];
    backend = await detectResourceBackend();
    directory = await mkdtemp(path.join(tmpdir(), "sermon-audio-timing-"));
    const names = ["source.wav", "source.m4a", "same-rate.flac", "resampled.flac", "range.flac"];
    const files = names.map((name) => path.join(directory!, name));
    const [pcm, source, sameRate, resampled, range] = files;
    const labels = new Map(files.map((file, index) => [file, `<${names[index]}>`]));
    const run = async (id: string, args: string[]) => {
      phase = id;
      const fullArgs = ["-nostdin", "-hide_banner", "-v", "error", "-n", ...args];
      const measurement = await runMeasuredProcess("ffmpeg", fullArgs, { backend, timeoutMs: 10000 });
      stages.push({ id, args: fullArgs.map((arg) => labels.get(arg) ?? arg), measurement });
      if (measurement.outcome !== "succeeded") throw new Error("Local creation failed.");
    };
    await run("pcm_generation", ["-f", "lavfi", "-i",
      "aevalsrc='if(between(n,96000,105599),0.5*sin(2*PI*440*n/48000),0)':s=48000:d=4", "-c:a", "pcm_f32le", pcm]);
    await run("aac_source", ["-protocol_whitelist", "file,pipe", "-format_whitelist", "wav", "-i", pcm, "-c:a", "aac", "-b:a", "128k", source]);
    const input = ["-protocol_whitelist", "file,pipe", "-format_whitelist", "mov", "-i", source];
    await run("same_rate_flac", [...input, "-c:a", "flac", sameRate]);
    await run("resampled_flac", [...input, "-ar", "16000", "-c:a", "flac", resampled]);
    await run("range_flac", [...input, "-ss", "1", "-t", "2", "-ar", "16000", "-c:a", "flac", range]);
    const sizes = await Promise.all(files.map(async (file) => (await stat(file)).size));
    retainedMediaBytesBeforeCleanup = sizes.reduce((a, b) => a + b, 0);
    generatedPcm = { sha256: createHash("sha256").update(await readFile(pcm)).digest("hex"), bytes: sizes[0] };
    phase = "audio_observation";
    const sourceObservation = await measureSyntheticAudio(source);
    observations.push({ artifactId: "synthetic-aac-source", observation: sourceObservation });
    for (const target of [
      { file: sameRate, artifactId: "synthetic-same-rate", sourceStartMs: 0, sourceEndMs: 4000 },
      { file: resampled, artifactId: "synthetic-resampled", sourceStartMs: 0, sourceEndMs: 4000 },
      { file: range, artifactId: "synthetic-range", sourceStartMs: 1000, sourceEndMs: 3000 },
    ]) {
      const observation = await measureSyntheticAudio(target.file);
      observations.push({ artifactId: target.artifactId, observation });
      comparisons.push({ artifactId: target.artifactId, comparison: compareSyntheticAudio(sourceObservation, observation,
        { sourceStartMs: target.sourceStartMs, sourceEndMs: target.sourceEndMs }) });
    }
    if (comparisons.some(({ comparison }) => comparison.status !== "matched")) throw new Error("Audio event did not match.");
  } catch { failure = `${phase}_failed`; }
  finally {
    if (directory) {
      try { await rm(directory, { recursive: true, force: true }); cleanup = "removed"; }
      catch { cleanup = "failed"; failure ??= "cleanup_failed"; }
    }
  }
  return { schemaVersion: 1, evidenceType: "synthetic_local_audio_event_benchmark", recordedAt: new Date().toISOString(),
    outcome: failure ? "failed" : "succeeded", failure,
    tools: { ffmpeg, ffprobe, node: process.version, platform: platform(), release: release(), arch: arch(), resourceBackend: backend },
    fixture: { version: "synthetic_audio_burst_v1", durationSeconds: 4, sampleRateHz: 48000, channels: 1,
      frequencyHz: 440, amplitude: 0.5, burstStartSample: 96000, burstEndSampleExclusive: 105600,
      pcmOrigin: "declared_generated_sample_origin_not_observed_container_clock", generatedPcm },
    stages, observations, comparisons,
    storage: { retainedMediaBytesBeforeCleanup, peakDiskBytes: null, cleanup },
    review: { sourceContentMapping: "NOT_VERIFIED", audioQuality: "NOT_REVIEWED", captionAccuracy: "NOT_REVIEWED", audiovisualSync: "NOT_VERIFIED" },
    limits: ["One generated audio event only. No full interval, caption, audiovisual, real-sermon, or P2 proof.",
      "AAC/FLAC clocks are observed separately from the declared generated PCM origin. Container duration need not equal decoded duration.",
      "Creation wall time and native child CPU/RSS are separate from inspection wall time; inspection CPU and memory are not measured.",
      "The fixture detector and tolerance are not production audio thresholds. Padding and resampling are not evidence that words moved.",
      "Each derivative reads locally and independently. No remote acquisition, shared cache, production cost, or peak disk measurement.",
      "Normal and handled failure cleanup removes only owned media. A hard crash can leave media or an incomplete reserved report."],
  };
}

export async function writeLocalAudioTimingBenchmark(output: string) {
  const handle = await open(output, "wx");
  try {
    const report = await benchmarkLocalAudioTiming();
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally { await handle.close(); }
}
