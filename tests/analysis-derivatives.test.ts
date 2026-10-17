import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAnalysisDerivatives, type AnalysisDerivativeSettings } from "@/lib/media/analysis-derivatives";
import { fileIdentity } from "@/lib/storage/file-identity";
import type { MaterializedSource } from "@/lib/media/source-lease";

const exec = promisify(execFile);
let root: string;
let source: MaterializedSource;
// These values apply only to a two-second generated fixture, not production quality selection.
const settings: AnalysisDerivativeSettings = { proxyCrf: 18, proxyPreset: "ultrafast",
  proxyAudioBitrateBps: 64000, flacCompressionLevel: 5, encoderThreads: 1, timeoutMs: 30000 };

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "analysis-derivatives-"));
  const sourcePath = path.join(root, "original.mp4");
  await exec("ffmpeg", ["-nostdin", "-v", "error", "-n", "-f", "lavfi", "-i",
    "color=black:s=1280x720:d=2:r=25,drawbox=x=0:y=0:w=64:h=ih:color=red:t=fill,drawbox=x=iw-64:y=0:w=64:h=ih:color=blue:t=fill",
    "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000:duration=2", "-c:v", "libx264",
    "-preset", "ultrafast", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", sourcePath], { timeout: 30000 });
  source = { sessionId: randomUUID(), sourceVideoId: randomUUID(), sourcePath, directory: root,
    ...await fileIdentity(sourcePath), width: 1280, height: 720, transcriptRevision: 0, download: undefined };
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

async function pixel(file: string, x: number) {
  const result = await exec("ffmpeg", ["-nostdin", "-v", "error", "-ss", "1", "-i", file,
    "-vf", `crop=16:16:${x}:240,scale=1:1`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
  { encoding: "buffer", timeout: 10000 });
  return [...result.stdout];
}

describe("coordinated local analysis derivatives", () => {
  it("creates mono 16 kHz FLAC and an uncropped 480p H.264 proxy from one source", async () => {
    const result = await buildAnalysisDerivatives(source, settings);
    expect(result.analysis.facts.audio).toMatchObject({ codec: "flac", channels: 1, sampleRateHz: 16000 });
    expect(result.analysis.facts.durationMs).toBe(2000);
    expect(result.proxy.facts.video).toMatchObject({ codec: "h264", height: 480, width: 854 });
    expect(result.original.video).toMatchObject({ width: 1280, height: 720 });
    expect(source).toMatchObject({ width: 1280, height: 720 });
    expect(result.sourceInterval).toEqual({ startMs: 0, endMs: 2000 });
    expect(result.mappingStatus).toBe("DECLARED");
    expect(result.analysis.mappingEvidence).toMatchObject({ sourceSha256: source.sha256,
      analysisSha256: result.analysis.sha256, sampleCount: 32000, sourceInterval: { startMs: 0, endMs: 2000 } });
    expect(result.analysis.mappingEvidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.visualQuality).toBe("NOT_REVIEWED");
    expect(result.encodingWallMs).toBeGreaterThan(0);
    expect(result.configurationSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await fileIdentity(result.analysis.path)).toMatchObject({ sha256: result.analysis.sha256, byteCount: result.analysis.byteCount });
    const left = await pixel(result.proxy.path, 8), right = await pixel(result.proxy.path, 830);
    expect(left[0]).toBeGreaterThan(200); expect(left[1]).toBeLessThan(40); expect(left[2]).toBeLessThan(40);
    expect(right[2]).toBeGreaterThan(200); expect(right[0]).toBeLessThan(40); expect(right[1]).toBeLessThan(40);
  });

  it("normalizes a nonzero container origin without adding that origin to audio duration", async () => {
    const shifted = path.join(root, "shifted.mp4");
    await exec("ffmpeg", ["-nostdin", "-v", "error", "-i", source.sourcePath, "-map", "0", "-c", "copy",
      "-output_ts_offset", "5", shifted], { timeout: 10000 });
    const result = await buildAnalysisDerivatives({ ...source, sourcePath: shifted, ...await fileIdentity(shifted) }, settings);
    // AAC priming can move the container origin slightly before the first video frame.
    expect(result.sourcePresentationOriginMs).toBeGreaterThan(4900);
    expect(result.sourcePresentationOriginMs).toBeLessThanOrEqual(5000);
    expect(result.analysis.facts.durationMs).toBeGreaterThanOrEqual(2000);
    expect(result.analysis.facts.durationMs).toBeLessThan(2050);
    expect(result.analysis.sourceInterval.endMs).toBeLessThanOrEqual(result.analysis.mappingEvidence.sampleCount / 16);
    expect(result.analysis.mappingEvidence.sourcePresentationOriginMs).toBe(result.sourcePresentationOriginMs);
    expect(result.proxy.facts.containerStartMs).toBeGreaterThanOrEqual(0);
    expect(result.proxy.facts.containerStartMs).toBeLessThan(50);
  });

  it("preserves leading audio silence when the audio stream starts after the video", async () => {
    const delayed = path.join(root, "delayed.mov");
    await exec("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=black:s=1280x720:d=2:r=25",
      "-itsoffset", "0.5", "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000:duration=1.5",
      "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-c:a", "pcm_s16le", delayed], { timeout: 30000 });
    const result = await buildAnalysisDerivatives({ ...source, sourcePath: delayed, ...await fileIdentity(delayed) }, settings);
    const { stdout } = await exec("ffmpeg", ["-nostdin", "-v", "error", "-i", result.analysis.path,
      "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"], { encoding: "buffer", timeout: 10000 });
    const maxAmplitude = (start: number, end: number) => {
      let max = 0;
      for (let sample = start; sample < end; sample++) max = Math.max(max, Math.abs(stdout.readInt16LE(sample * 2)));
      return max;
    };
    expect(stdout.byteLength).toBe(2 * 16000 * 2);
    expect(maxAmplitude(0, 7000)).toBe(0);
    expect(maxAmplitude(9000, 15000)).toBeGreaterThan(1000);
  });

  it("requires explicit settings and refuses changed authoritative dimensions", async () => {
    await expect(buildAnalysisDerivatives(source, { ...settings, proxyCrf: undefined } as never)).rejects.toThrow();
    await expect(buildAnalysisDerivatives({ ...source, width: 1920 }, settings)).rejects.toThrow("MEDIA_ORIGINAL_DIMENSIONS_CHANGED");
  });

  it("removes owned outputs when source identity verification fails", async () => {
    const before = await readdir(root);
    await expect(buildAnalysisDerivatives({ ...source, sha256: "a".repeat(64) }, settings)).rejects.toThrow("MEDIA_SOURCE_BYTES_CHANGED");
    expect(await readdir(root)).toEqual(before);
  });

  it("changes derivation identity when encoding settings change", async () => {
    const first = await buildAnalysisDerivatives(source, settings);
    const second = await buildAnalysisDerivatives(source, { ...settings, proxyCrf: 24 });
    expect(first.configurationSha256).not.toBe(second.configurationSha256);
  });
});
