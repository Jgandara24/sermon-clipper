import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { differenceHash64, extractFrameHashes, frameHashDistance, groupFrameHashes,
  type FrameHashSample, type FrameHashSettings } from "@/lib/media/frame-hashes";
import { fileIdentity } from "@/lib/storage/file-identity";

const run = promisify(execFile);
let root: string, video: string;
const settings: FrameHashSettings = { intervalMs: 500, maxFrames: 20, threads: 1, timeoutMs: 30000, maxOutputBytes: 1024 * 1024 };
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "frame-hashes-"));
  video = path.join(root, "sequence.mkv");
  await run("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=black:s=64x64:d=1:r=10",
    "-f", "lavfi", "-i", "color=white:s=64x64:d=1:r=10", "-f", "lavfi", "-i", "testsrc2=s=64x64:d=1:r=10",
    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]", "-map", "[v]", "-c:v", "ffv1", "-threads", "1", video], { timeout: 30000 });
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
async function input(file = video, startMs = 5000) {
  return { path: file, ...await fileIdentity(file), mapping: {
    sourceInterval: { startMs, endMs: startMs + 3000 }, artifactOriginMs: 0, timeScale: "1:1" as const,
  } };
}

describe("sparse perceptual frame hashes", () => {
  it("defines all 64 adjacent-pixel comparisons deterministically", () => {
    const ascending = Uint8Array.from({ length: 72 }, (_, index) => index % 9);
    const descending = Uint8Array.from(ascending, value => 8 - value);
    expect(differenceHash64(ascending)).toBe("0000000000000000");
    expect(differenceHash64(descending)).toBe("ffffffffffffffff");
    expect(frameHashDistance(differenceHash64(ascending), differenceHash64(descending))).toBe(64);
    expect(() => differenceHash64(new Uint8Array(71))).toThrow();
    expect(() => frameHashDistance("invalid", "0000000000000000")).toThrow();
  });
  it("returns actual sparse timestamps and distinguishes flat-image brightness", async () => {
    const result = await extractFrameHashes(await input(), settings);
    expect(result.samples.map(sample => sample.timeMs)).toEqual([5000, 5500, 6000, 6500, 7000, 7500]);
    expect(result.samples[0].differenceHash).toBe(result.samples[2].differenceHash);
    expect(result.samples[0].meanLuma).toBeLessThan(5);
    expect(result.samples[2].meanLuma).toBeGreaterThan(250);
    expect(result.samples[0].grayscaleThumbnailSha256).toBe(result.samples[1].grayscaleThumbnailSha256);
    expect(result.samples[0].grayscaleThumbnailSha256).not.toBe(result.samples[2].grayscaleThumbnailSha256);
  });
  it("uses integer timestamps without floating-point sampling drift", async () => {
    const result = await extractFrameHashes(await input(video, 0), { ...settings, intervalMs: 400 });
    expect(result.samples.map(sample => sample.timeMs)).toEqual([0, 400, 800, 1200, 1600, 2000, 2400, 2800]);
  });
  it("preserves a nonzero artifact timestamp origin", async () => {
    const shifted = path.join(root, "shifted.mkv");
    await run("ffmpeg", ["-nostdin", "-v", "error", "-itsoffset", "5", "-i", video, "-c", "copy", shifted], { timeout: 30000 });
    const request = await input(shifted, 12000);
    request.mapping.artifactOriginMs = 5000;
    expect((await extractFrameHashes(request, settings)).samples.map(sample => sample.timeMs))
      .toEqual([12000, 12500, 13000, 13500, 14000, 14500]);
  });
  it("refuses truncated evidence when the frame cap is too small", async () => {
    await expect(extractFrameHashes(await input(), { ...settings, maxFrames: 2 })).rejects.toThrow("MEDIA_FRAME_HASH_LIMIT_EXCEEDED");
  });
  it("refuses changed inputs and insufficient output capacity", async () => {
    await expect(extractFrameHashes({ ...await input(), sha256: "a".repeat(64) }, settings)).rejects.toThrow("MEDIA_FRAME_HASH_INPUT_CHANGED");
    await expect(extractFrameHashes(await input(), { ...settings, intervalMs: 100, maxFrames: 40, maxOutputBytes: 4096 })).rejects.toThrow();
  });
  it("versions sampling independently from execution budgets", async () => {
    const request = await input();
    const first = await extractFrameHashes(request, settings);
    const repeated = await extractFrameHashes(request, { ...settings, timeoutMs: 60000, maxFrames: 30 });
    expect(repeated.samples).toEqual(first.samples);
    expect(repeated.configurationSha256).toBe(first.configurationSha256);
    const changed = await extractFrameHashes(request, { ...settings, intervalMs: 1000 });
    expect(changed.configurationSha256).not.toBe(first.configurationSha256);
  });
});

const groupingSettings = { maxHammingDistance: 1, maxMeanLumaDifference: 2, maxSpanMs: 1000 };
function sample(timeMs: number, differenceHash: string, meanLuma = 20): FrameHashSample {
  return { timeMs, differenceHash, meanLuma, grayscaleThumbnailSha256: "a".repeat(64) };
}
describe("representative frame grouping", () => {
  it("compares with the representative and prevents transitive similarity drift", () => {
    const result = groupFrameHashes([sample(0, "0000000000000000"), sample(100, "0000000000000001"),
      sample(200, "0000000000000003")], groupingSettings);
    expect(result.groups).toEqual([{ representativeIndex: 0, memberIndices: [0, 1] }, { representativeIndex: 2, memberIndices: [2] }]);
  });
  it("separates brightness collisions and groups beyond the explicit time span", () => {
    const result = groupFrameHashes([sample(0, "0000000000000000", 0), sample(100, "0000000000000000", 255),
      sample(1200, "0000000000000000", 255)], groupingSettings);
    expect(result.groups.map(group => group.memberIndices)).toEqual([[0], [1], [2]]);
  });
  it("rejects ambiguous sample order and records grouping identity", () => {
    expect(() => groupFrameHashes([sample(0, "0000000000000000"), sample(0, "0000000000000000")], groupingSettings)).toThrow("ORDER_INVALID");
    const first = groupFrameHashes([sample(0, "0000000000000000")], groupingSettings);
    expect(groupFrameHashes([sample(0, "0000000000000000")], { ...groupingSettings, maxSpanMs: 2000 }).configurationSha256)
      .not.toBe(first.configurationSha256);
    expect(groupFrameHashes([sample(100, "0000000000000000")], groupingSettings).inputSha256).not.toBe(first.inputSha256);
  });
});
