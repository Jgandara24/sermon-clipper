import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractRepresentativeFrames, type RepresentativeFrameSettings } from "@/lib/media/representative-frames";
import { fileIdentity } from "@/lib/storage/file-identity";

const run = promisify(execFile);
let root: string, video: string, work: string;
const settings: RepresentativeFrameSettings = { quality: 75, threads: 1, maxFrames: 10,
  maxFrameBytes: 1024 * 1024, maxTotalBytes: 10 * 1024 * 1024, maxOutputBytes: 1024 * 1024, timeoutMs: 30000 };
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "representative-test-")); work = path.join(root, "work");
  await mkdir(work);
  video = path.join(root, "sequence.mkv");
  await run("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=black:s=96x64:d=1:r=10",
    "-f", "lavfi", "-i", "color=white:s=96x64:d=1:r=10", "-f", "lavfi", "-i", "testsrc2=s=96x64:d=1:r=10",
    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]", "-map", "[v]", "-c:v", "ffv1", "-threads", "1", video], { timeout: 30000 });
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
async function input(file = video, startMs = 5000) {
  return { path: file, ...await fileIdentity(file), mapping: { sourceInterval: { startMs, endMs: startMs + 3000 },
    artifactOriginMs: 0, timeScale: "1:1" as const } };
}

describe("full-frame representative images", () => {
  it("extracts requested frames with unchanged decoded pixels and dimensions", async () => {
    const result = await extractRepresentativeFrames(await input(), [5000, 6000, 7000], work, settings);
    expect(result.frames.map(frame => frame.sourceTimeMs)).toEqual([5000, 6000, 7000]);
    expect(new Set(result.frames.map(frame => frame.bgraSha256)).size).toBe(3);
    for (const frame of result.frames) {
      expect(frame).toMatchObject({ width: 96, height: 64 });
      expect(await fileIdentity(frame.path)).toEqual({ sha256: frame.sha256, byteCount: frame.byteCount });
    }
    expect(result.totalBytes).toBe(result.frames.reduce((sum, frame) => sum + frame.byteCount, 0));
    await rm(result.directory, { recursive: true });
  });
  it("maps nonzero artifact clocks without selecting the wrong frame", async () => {
    const shifted = path.join(root, "shifted.mkv");
    await run("ffmpeg", ["-nostdin", "-v", "error", "-itsoffset", "5", "-i", video, "-c", "copy", shifted], { timeout: 30000 });
    const request = await input(shifted, 12000); request.mapping.artifactOriginMs = 5000;
    const original = await extractRepresentativeFrames(await input(), [6000], work, settings);
    const result = await extractRepresentativeFrames(request, [13000], work, settings);
    expect(result.frames[0].bgraSha256).toBe(original.frames[0].bgraSha256);
    await rm(original.directory, { recursive: true }); await rm(result.directory, { recursive: true });
  });
  it("rejects missing exact timestamps instead of substituting a nearby frame", async () => {
    await expect(extractRepresentativeFrames(await input(), [5050], work, settings)).rejects.toThrow();
    expect(await readdir(work)).toEqual([]);
  });
  it("removes owned output after a size limit failure", async () => {
    await expect(extractRepresentativeFrames(await input(), [5000, 6000], work, { ...settings, maxTotalBytes: 1 }))
      .rejects.toThrow("SIZE_LIMIT_EXCEEDED");
    expect(await readdir(work)).toEqual([]);
  });
  it("rejects repeated, unordered, out-of-range, and excessive requests", async () => {
    for (const points of [[5000, 5000], [6000, 5000], [8000], [4999]]) {
      await expect(extractRepresentativeFrames(await input(), points, work, settings)).rejects.toThrow();
    }
    await expect(extractRepresentativeFrames(await input(), [5000, 6000], work, { ...settings, maxFrames: 1 })).rejects.toThrow();
    expect(await readdir(work)).toEqual([]);
  });
  it("refuses changed input and preserves content identity across execution budgets", async () => {
    const request = await input();
    await expect(extractRepresentativeFrames({ ...request, sha256: "a".repeat(64) }, [5000], work, settings))
      .rejects.toThrow("INPUT_CHANGED");
    const first = await extractRepresentativeFrames(request, [5000], work, settings);
    const repeated = await extractRepresentativeFrames(request, [5000], work, { ...settings, timeoutMs: 60000 });
    expect(repeated.configurationSha256).toBe(first.configurationSha256);
    expect(repeated.frames[0].sha256).toBe(first.frames[0].sha256);
    await rm(first.directory, { recursive: true }); await rm(repeated.directory, { recursive: true });
  });
});
