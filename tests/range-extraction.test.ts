import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileWithTimeout } from "@/lib/media/child-process";
import { extractLosslessCandidateRange } from "@/lib/media/range-extraction";
import { fileIdentity } from "@/lib/storage/file-identity";
let root: string;
const settings = { mode: "lossless-mezzanine" as const, threads: 1, timeoutMs: 30000,
  maxOutputBytes: 4 * 1024 * 1024, maxFileBytes: 10 * 1024 * 1024, maxProofFrames: 1000 };
async function fixture(name: string, rate = "10", offset = "0") {
  const file = path.join(root, name + ".mov");
  await execFileWithTimeout("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", `testsrc2=s=96x64:r=${rate}:d=3`,
    "-f", "lavfi", "-i", "sine=frequency=997:sample_rate=48000:duration=3", "-c:v", "libx264", "-threads", "1",
    "-g", "10", "-sc_threshold", "0", "-c:a", "pcm_s16le", "-output_ts_offset", offset, file], { timeoutMs: 30000 });
  return { path: file, ...await fileIdentity(file), sourceDurationMs: 3000, sourceOriginMs: Number(offset) * 1000, width: 96, height: 64 };
}
beforeAll(async () => { root = await mkdtemp(path.join(os.tmpdir(), "p4-ranges-")); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
describe("lossless candidate range extraction", () => {
  it("preserves decoded frames, audio samples, clocks, and dimensions", async () => {
    const input = await fixture("normal");
    const result = await extractLosslessCandidateRange(input, { startMs: 1000, endMs: 2000 }, root, settings);
    expect(result.evidence).toMatchObject({ width: 96, height: 64, videoFrames: 10, audioBlocks: 47,
      audioSamples: "48000", audioStartPts: "48000", audioEndPts: "96000", visualQuality: "NOT_REVIEWED" });
    expect(await fileIdentity(result.path)).toEqual({ sha256: result.sha256, byteCount: result.byteCount });
  });
  it("preserves fractional video clocks and sample-aligned audio", async () => {
    const input = await fixture("fractional", "30000/1001");
    const interval = { startMs: { numerator: "1001", denominator: "3" }, endMs: { numerator: "2002", denominator: "3" } };
    const result = await extractLosslessCandidateRange(input, interval, root, settings);
    expect(result.evidence.sourceInterval).toEqual(interval);
    expect(result.evidence.videoFrames).toBe(10);
    expect(result.evidence).toMatchObject({ audioSamples: "16016", audioStartPts: "16016", audioEndPts: "32032" });
  });
  it("preserves nonzero media origins", async () => {
    const input = await fixture("shifted", "10", "5");
    const result = await extractLosslessCandidateRange(input, { startMs: 1000, endMs: 2000 }, root, settings);
    expect(result.evidence.sourceOriginMs).toBe(5000);
    expect(result.evidence.videoFrames).toBe(10);
  });
  it("refuses bad source facts and removes only owned files after output limit failures", async () => {
    const input = await fixture("limits");
    const before = await readdir(root);
    await expect(extractLosslessCandidateRange({ ...input, width: 100 }, { startMs: 0, endMs: 1000 }, root, settings))
      .rejects.toThrow("DIMENSIONS_CHANGED");
    await expect(extractLosslessCandidateRange({ ...input, sha256: "0".repeat(64) }, { startMs: 0, endMs: 1000 }, root, settings))
      .rejects.toThrow("INPUT_CHANGED");
    await expect(extractLosslessCandidateRange(input, { startMs: 0, endMs: 1000 }, root, { ...settings, maxFileBytes: 1 }))
      .rejects.toThrow("FILE_LIMIT_EXCEEDED");
    expect(await readdir(root)).toEqual(before);
  });
  it("refuses partial source coverage and non-frame starts without leaving files", async () => {
    const input = await fixture("coverage");
    const before = await readdir(root);
    await expect(extractLosslessCandidateRange({ ...input, sourceDurationMs: 4000 },
      { startMs: 2000, endMs: 4000 }, root, settings)).rejects.toThrow("COVERAGE_UNPROVEN");
    await expect(extractLosslessCandidateRange(input, { startMs: 1050, endMs: 2000 }, root, settings))
      .rejects.toThrow("COVERAGE_UNPROVEN");
    await expect(extractLosslessCandidateRange(input, { startMs: 1000, endMs: 2000 }, root,
      { ...settings, maxProofFrames: 1 })).rejects.toThrow("LIMIT_EXCEEDED");
    expect(await readdir(root)).toEqual(before);
  });
});

async function copyFixture(name: string, rate = "10", offset = "0") {
  const file = path.join(root, name + ".mp4");
  await execFileWithTimeout("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", `testsrc2=s=96x64:r=${rate}:d=3`,
    "-c:v", "libx264", "-threads", "1", "-g", "10", "-bf", "0", "-sc_threshold", "0", "-output_ts_offset", offset, file], { timeoutMs: 30000 });
  return { path: file, ...await fileIdentity(file), sourceDurationMs: 3000, sourceOriginMs: Number(offset) * 1000, width: 96, height: 64 };
}
describe("verified stream copy", () => {
  it("copies aligned video and PCM packets without encoding either stream", async () => {
    const { extractCandidateRange } = await import("@/lib/media/range-extraction");
    const file = path.join(root, "copy-aligned-audio.mov");
    await execFileWithTimeout("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=96x64:r=25:d=2",
      "-f", "lavfi", "-i", "sine=sample_rate=48000:duration=2", "-c:v", "libx264", "-threads", "1",
      "-g", "8", "-bf", "0", "-sc_threshold", "0", "-c:a", "pcm_s16le", file], { timeoutMs: 30000 });
    const result = await extractCandidateRange({ path: file, ...await fileIdentity(file), sourceDurationMs: 2000,
      sourceOriginMs: 0, width: 96, height: 64 }, { startMs: 320, endMs: 640 }, root, { ...settings, mode: "stream-copy" });
    expect(result.evidence).toMatchObject({ mode: "stream-copy", videoFrames: 8, audioSamples: "15360",
      audioStartPts: "15360", audioEndPts: "30720" });
    const { stdout } = await execFileWithTimeout("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name", "-of", "json", result.path], { timeoutMs: 10000 });
    expect(JSON.parse(stdout).streams).toEqual([{ codec_name: "h264" }, { codec_name: "pcm_s16le" }]);
  });
  it("accepts exact closed-GOP copies and keeps the encoded video codec", async () => {
    const { extractCandidateRange } = await import("@/lib/media/range-extraction");
    const input = await copyFixture("closed");
    const result = await extractCandidateRange(input, { startMs: 1000, endMs: 2000 }, root, { ...settings, mode: "prefer-stream-copy" });
    expect(result.evidence).toMatchObject({ mode: "stream-copy", videoFrames: 10,
      attempts: [{ mode: "stream-copy", outcome: "ACCEPTED", reason: null }] });
    const { stdout } = await execFileWithTimeout("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name", "-of", "json", result.path], { timeoutMs: 10000 });
    expect(JSON.parse(stdout).streams).toEqual([{ codec_name: "h264" }]);
  });
  it("verifies fractional and nonzero copy clocks", async () => {
    const { extractCandidateRange } = await import("@/lib/media/range-extraction");
    const input = await copyFixture("copy-fraction", "30000/1001", "5");
    const interval = { startMs: { numerator: "1001", denominator: "3" }, endMs: { numerator: "2002", denominator: "3" } };
    const result = await extractCandidateRange(input, interval, root, { ...settings, mode: "stream-copy" });
    expect(result.evidence).toMatchObject({ sourceInterval: interval, sourceOriginMs: 5000, videoFrames: 10, mode: "stream-copy" });
  });
  it("records rejected audio or GOP boundaries before explicit lossless fallback", async () => {
    const { extractCandidateRange } = await import("@/lib/media/range-extraction");
    const input = await fixture("copy-audio");
    const result = await extractCandidateRange(input, { startMs: 1000, endMs: 2000 }, root, { ...settings, mode: "prefer-stream-copy" });
    expect(result.evidence).toMatchObject({ mode: "lossless-mezzanine", audioSamples: "48000", attempts: [
      { mode: "stream-copy", outcome: "REJECTED", reason: expect.any(String) },
      { mode: "lossless-mezzanine", outcome: "ACCEPTED", reason: null },
    ] });
  });
  it("refuses unsafe copy-only requests and cleans failed or over-limit outputs", async () => {
    const { extractCandidateRange } = await import("@/lib/media/range-extraction");
    const input = await copyFixture("copy-refusal");
    const before = await readdir(root);
    await expect(extractCandidateRange(input, { startMs: 1100, endMs: 2000 }, root, { ...settings, mode: "stream-copy" })).rejects.toThrow();
    await expect(extractCandidateRange(input, { startMs: 1000, endMs: 2000 }, root,
      { ...settings, mode: "prefer-stream-copy", maxFileBytes: 1 })).rejects.toThrow("FILE_LIMIT_EXCEEDED");
    expect(await readdir(root)).toEqual(before);
  });
});
