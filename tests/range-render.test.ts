import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileBufferWithTimeout, execFileWithTimeout } from "@/lib/media/child-process";
import { extractCandidateRange } from "@/lib/media/range-extraction";
import { containedRangeMapping } from "@/lib/media/range-batch";
import { rangeEvidenceSha256 } from "@/lib/media/range-evidence";
import { fileIdentity } from "@/lib/storage/file-identity";
import { renderCandidateRangeExport, type RenderRangeArtifact } from "@/lib/exports/range-render";
import { renderClipExport } from "@/lib/export/render";
let root: string;
let original: string;
let rangeFile: string;
let artifact: RenderRangeArtifact;
const captions = `[Script Info]
ScriptType: v4.00+
PlayResX: 96
PlayResY: 64
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,10,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,2,2,2,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:00.60,Default,,0,0,0,,Range proof
`;
const render = (outputPath: string) => ({ sourceFilePath: rangeFile, range: { startMs: 1200, endMs: 1800 },
  cropPixels: { x: 0, y: 0, w: 96, h: 64 }, outputPath, outputWidth: 96, outputHeight: 64,
  assFileContent: captions, originalVolume: 0.5 });
const request = (output: string) => ({ artifact, sourceVideoId: artifact.sourceVideoId, sourceSha256: artifact.sourceSha256,
  sourceWidth: 96, sourceHeight: 64, now: new Date("2026-10-16"), render: render(output) });
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "p4-range-render-"));
  original = path.join(root, "source.mov");
  await execFileWithTimeout("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=96x64:r=10:d=3",
    "-f", "lavfi", "-i", "sine=frequency=997:sample_rate=48000:duration=3", "-c:v", "libx264", "-threads", "1",
    "-c:a", "pcm_s16le", "-output_ts_offset", "5", original], { timeoutMs: 30000 });
  const source = await fileIdentity(original);
  const built = await extractCandidateRange({ path: original, ...source, sourceDurationMs: 3000, sourceOriginMs: 5000, width: 96, height: 64 },
    { startMs: 1000, endMs: 2000 }, root, { mode: "lossless-mezzanine", threads: 1, timeoutMs: 30000,
      maxOutputBytes: 1024 * 1024, maxFileBytes: 10 * 1024 * 1024, maxProofFrames: 1000 });
  rangeFile = built.path;
  const mappingEvidence = { version: "contained-range-mapping-v2", mapping: containedRangeMapping(built.evidence.sourceInterval, 5000),
    extractionEvidenceSha256: built.evidenceSha256 };
  // Simulated approval exercises the renderer gate. It does not approve any production artifact.
  artifact = { id: randomUUID(), sourceVideoId: randomUUID(), sourceSha256: source.sha256, kind: "CANDIDATE_RANGE",
    sha256: built.sha256, byteCount: BigInt(built.byteCount), startMs: BigInt(1000), endMs: BigInt(2000),
    mappingStatus: "VERIFIED", mappingEvidenceSha256: rangeEvidenceSha256(mappingEvidence), visualQuality: "ACCEPTED",
    retentionClass: "RENDER_SOURCE", publicationState: "READY", expiresAt: null, deletedAt: null,
    publicationEvidence: { version: "artifact-publication-v1", sha256: built.sha256, byteCount: String(built.byteCount),
      derivation: { extraction: built.evidence, mappingEvidence } } };
}, 30000);
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
async function outputProof(file: string, audio: boolean) {
  const { stdout } = await execFileWithTimeout("ffmpeg", ["-nostdin", "-v", "error", "-i", file,
    "-map", audio ? "0:a:0" : "0:v:0", ...(audio ? ["-c:a", "pcm_s16le", "-f", "hash", "-hash", "sha256"] : ["-f", "framemd5"]),
    "pipe:1"], { timeoutMs: 30000, maxBuffer: 1024 * 1024 });
  return stdout.split("\n").filter(line => !line.startsWith("#")).join("\n");
}
describe("verified range rendering", () => {
  it("matches original-source pixels, captions, audio, and duration with a nonzero source clock", async () => {
    const direct = path.join(root, "direct.mp4"), ranged = path.join(root, "ranged.mp4");
    await renderClipExport({ ...render(direct), sourceFilePath: original });
    const evidence = await renderCandidateRangeExport(request(ranged));
    expect(evidence.artifactRange).toEqual({ startMs: 6200, endMs: 6800 });
    expect(await outputProof(ranged, false)).toBe(await outputProof(direct, false));
    const selectedAudio = async (file: string, absolute: boolean) => (await execFileWithTimeout("ffmpeg", ["-nostdin", "-v", "error",
      ...(absolute ? ["-seek_timestamp", "1"] : []), "-ss", absolute ? "6.2" : "1.2", "-i", file, "-t", "0.6",
      "-map", "0:a:0", "-c:a", "pcm_f64le", "-f", "hash", "-hash", "sha256", "pipe:1"], { timeoutMs: 30000 })).stdout;
    expect(await selectedAudio(rangeFile, true)).toBe(await selectedAudio(original, false));
    const decodedAudio = async (file: string) => (await execFileBufferWithTimeout("ffmpeg", ["-nostdin", "-v", "error", "-i", file,
      "-map", "0:a:0", "-ar", "48000", "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1"],
    { timeoutMs: 30000, maxBuffer: 1024 * 1024 })).stdout;
    const directAudio = await decodedAudio(direct), rangedAudio = await decodedAudio(ranged);
    expect(rangedAudio.length).toBe(directAudio.length);
    let dot = 0, directEnergy = 0, rangedEnergy = 0;
    for (let i = 0; i < directAudio.length; i += 2) {
      const left = directAudio.readInt16LE(i), right = rangedAudio.readInt16LE(i);
      dot += left * right; directEnergy += left * left; rangedEnergy += right * right;
    }
    // AAC is lossy. Check waveform alignment and gain, in addition to exact pre-encode sample equality.
    // These bounds apply to this generated fixture, not production audio approval.
    expect(dot / Math.sqrt(directEnergy * rangedEnergy)).toBeGreaterThan(0.999);
    expect(Math.abs(Math.sqrt(rangedEnergy / directEnergy) - 1)).toBeLessThan(0.01);
    await rm(original);
    await expect(renderCandidateRangeExport(request(path.join(root, "without-original.mp4"))))
      .resolves.toMatchObject({ artifactId: artifact.id });
  }, 30000);
  it("accepts JSONB object-key reordering without weakening proof hashes", async () => {
    function reverseKeys(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(reverseKeys);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverseKeys(entry)]));
      return value;
    }
    const reordered = reverseKeys(artifact.publicationEvidence) as Prisma.JsonValue;
    await expect(renderCandidateRangeExport({ ...request(path.join(root, "reordered.mp4")),
      artifact: { ...artifact, publicationEvidence: reordered } })).resolves.toMatchObject({ artifactId: artifact.id });
    expect(rangeEvidenceSha256({ a: 1, b: 2 })).toBe(rangeEvidenceSha256({ b: 2, a: 1 }));
    expect(rangeEvidenceSha256({ a: 1 })).not.toBe(createHash("sha256").update("changed").digest("hex"));
  }, 30000);
  it("refuses unapproved, expired, deleted, mismatched, or uncovered ranges", async () => {
    const base = request(path.join(root, "refused.mp4"));
    for (const changed of [{ visualQuality: "NOT_REVIEWED" as const }, { expiresAt: new Date("2020-01-01") },
      { deletedAt: new Date() }, { publicationState: "PENDING" as const }, { sourceSha256: "0".repeat(64) }]) {
      await expect(renderCandidateRangeExport({ ...base, artifact: { ...artifact, ...changed } })).rejects.toThrow("NOT_APPROVED_OR_AVAILABLE");
    }
    await expect(renderCandidateRangeExport({ ...base, sourceWidth: 100 })).rejects.toThrow("EVIDENCE_MISMATCH");
    await expect(renderCandidateRangeExport({ ...base, artifact: { ...artifact, mappingEvidenceSha256: "0".repeat(64) } }))
      .rejects.toThrow("EVIDENCE_MISMATCH");
    await expect(renderCandidateRangeExport({ ...base, render: { ...base.render, range: { startMs: 900, endMs: 1800 } } })).rejects.toThrow();
    const changed = path.join(root, "changed.nut");
    await writeFile(changed, "changed bytes");
    await expect(renderCandidateRangeExport({ ...base, render: { ...base.render, sourceFilePath: changed } })).rejects.toThrow("FILE_CHANGED");
  });
});
