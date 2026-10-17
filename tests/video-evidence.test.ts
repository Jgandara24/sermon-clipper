import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractVideoEvidence, type VideoEvidenceSettings } from "@/lib/media/video-evidence";
import { fileIdentity } from "@/lib/storage/file-identity";

const run = promisify(execFile);
let root: string, video: string, black: string;
const settings: VideoEvidenceSettings = {
  sceneThreshold: 5, blackPixelThreshold: 0.1, blackPictureRatio: 0.98, blackMinimumMs: 300,
  freezeNoiseRatio: 0.001, freezeMinimumMs: 300, threads: 1, timeoutMs: 30000, maxMetadataBytes: 1024 * 1024,
};
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "video-evidence-"));
  video = path.join(root, "sequence.mkv"); black = path.join(root, "black.mkv");
  await run("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=black:s=64x64:d=1:r=10",
    "-f", "lavfi", "-i", "color=white:s=64x64:d=1:r=10", "-f", "lavfi", "-i", "testsrc2=s=64x64:d=1:r=10",
    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]", "-map", "[v]", "-c:v", "ffv1", "-threads", "1", video], { timeout: 30000 });
  await run("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=black:s=64x64:d=1:r=10",
    "-c:v", "ffv1", "-threads", "1", black], { timeout: 30000 });
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
async function input(file = video, startMs = 5000, durationMs = 3000) {
  return { path: file, ...await fileIdentity(file), mapping: {
    sourceInterval: { startMs, endMs: startMs + durationMs }, artifactOriginMs: 0, timeScale: "1:1" as const,
  } };
}

describe("local proxy video evidence", () => {
  it("maps scenes, black intervals, freezes, and motion into source time", async () => {
    const facts = await extractVideoEvidence(await input(), settings);
    expect(facts.frameCount).toBe(30);
    expect(facts.firstFrameMs).toBe(5000);
    expect(facts.lastFrameMs).toBe(7900);
    expect(facts.scenes.some(scene => scene.timeMs === 6000)).toBe(true);
    expect(facts.black).toEqual([{ startMs: 5000, endMs: 6000, endReason: "DETECTED" }]);
    expect(facts.freeze).toContainEqual({ startMs: 5000, endMs: 6000, endReason: "DETECTED" });
    expect(facts.motion.filter(frame => frame.timeMs < 6000).every(frame => frame.lumaDifference === 0)).toBe(true);
    expect(facts.motion.some(frame => frame.timeMs > 7000 && frame.lumaDifference > 0)).toBe(true);
  });
  it("does not extend trailing observations through an unobserved source tail", async () => {
    const facts = await extractVideoEvidence(await input(black, 0, 3000), settings);
    expect(facts.black).toEqual([{ startMs: 0, endMs: 900, endReason: "LAST_OBSERVED_FRAME" }]);
    expect(facts.freeze).toEqual([{ startMs: 0, endMs: 900, endReason: "LAST_OBSERVED_FRAME" }]);
  });
  it("preserves nonzero artifact timestamps before mapping into source time", async () => {
    const shifted = path.join(root, "shifted.mkv");
    await run("ffmpeg", ["-nostdin", "-v", "error", "-itsoffset", "5", "-i", black,
      "-map", "0:v:0", "-c", "copy", shifted], { timeout: 30000 });
    const request = await input(shifted, 12000, 1000);
    request.mapping.artifactOriginMs = 5000;
    const facts = await extractVideoEvidence(request, settings);
    expect(facts.firstFrameMs).toBe(12000);
    expect(facts.lastFrameMs).toBe(12900);
    expect(facts.black).toEqual([{ startMs: 12000, endMs: 12900, endReason: "LAST_OBSERVED_FRAME" }]);
  });
  it("applies the explicit black duration threshold to metadata intervals", async () => {
    const facts = await extractVideoEvidence(await input(), { ...settings, blackMinimumMs: 1500 });
    expect(facts.black).toEqual([]);
  });
  it("refuses input identity changes and an undersized source interval", async () => {
    await expect(extractVideoEvidence({ ...await input(), sha256: "a".repeat(64) }, settings)).rejects.toThrow("MEDIA_VIDEO_INPUT_CHANGED");
    await expect(extractVideoEvidence(await input(video, 0, 1000), settings)).rejects.toThrow("MEDIA_VIDEO_FRAME_OUTSIDE_INTERVAL");
  });
  it("fails when output exceeds its explicit buffer limit", async () => {
    await expect(extractVideoEvidence(await input(), { ...settings, maxMetadataBytes: 8192 })).rejects.toThrow();
  });
  it("versions detection settings separately from operational limits", async () => {
    const request = await input(black, 0, 1000);
    const first = await extractVideoEvidence(request, settings);
    const operational = await extractVideoEvidence(request, { ...settings, timeoutMs: 60000, maxMetadataBytes: 2 * 1024 * 1024 });
    const changed = await extractVideoEvidence(request, { ...settings, sceneThreshold: 10 });
    expect(operational.configurationSha256).toBe(first.configurationSha256);
    expect(changed.configurationSha256).not.toBe(first.configurationSha256);
    expect(first.inputSha256).toBe(request.sha256);
  });
});
