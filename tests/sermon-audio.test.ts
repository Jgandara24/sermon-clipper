import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractSermonAudio } from "@/lib/media/sermon-audio";
import { fileIdentity } from "@/lib/storage/file-identity";

const settings = { threads: 1, flacCompressionLevel: 5, timeoutMs: 30000, maxMetadataBytes: 1024 * 1024, maxFileBytes: 1024 * 1024 };
const corridor = { sourceInterval: { startMs: 60333, endMs: 61777 }, detectorVersion: "fixture-only-v1",
  evidenceSha256: "b".repeat(64), confidence: 0.9 };
describe("exact sermon audio", () => {
  let root: string, input: { path: string; sha256: string; byteCount: number; sourceInterval: { startMs: number; endMs: number } };
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "sermon-audio-test-"));
    const file = path.join(root, "analysis.flac");
    await promisify(execFile)("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=sample_rate=16000:duration=2",
      "-c:a", "flac", "-threads", "1", file]);
    input = { path: file, ...await fileIdentity(file), sourceInterval: { startMs: 60000, endMs: 62000 } };
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });
  it("preserves exact selected PCM and records source offset, duration, detector, and confidence", async () => {
    const result = await extractSermonAudio(input, corridor, root, settings);
    expect(result.evidence).toMatchObject({ sourceOffsetMs: 60333, durationMs: 1444, sampleCount: 23104,
      startSamples: 5328, endSamples: 28432, corridor });
    expect(await fileIdentity(result.path)).toEqual({ sha256: result.sha256, byteCount: result.byteCount });
    await rm(result.directory, { recursive: true });
  });
  it("refuses changed input and a corridor outside measured samples", async () => {
    await expect(extractSermonAudio({ ...input, sha256: "a".repeat(64) }, corridor, root, settings)).rejects.toThrow("INPUT_CHANGED");
    await expect(extractSermonAudio({ ...input, sourceInterval: { startMs: 60000, endMs: 65000 } },
      { ...corridor, sourceInterval: { startMs: 61000, endMs: 63000 } }, root, settings)).rejects.toThrow("OUTSIDE_SAMPLES");
  });
  it("removes failed output after a size limit", async () => {
    await expect(extractSermonAudio(input, corridor, root, { ...settings, maxFileBytes: 1 })).rejects.toThrow();
    expect(await readdir(root)).toEqual(["analysis.flac"]);
  });
});
