import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseBoundaryAsrOutput, sampleAmbiguousBoundaries, validateBoundaryAsrPlan, boundaryAsrSettingsSchema } from "@/lib/media/boundary-asr";
import { fileIdentity } from "@/lib/storage/file-identity";
import type { z } from "zod";

const sourceInterval = { startMs: 60000, endMs: 62000 };
const plan = { sourceVideoId: "11111111-1111-4111-8111-111111111111", sourceSha256: "a".repeat(64),
  corridor: { startMs: 60500, endMs: 61500 }, maxWindowMs: 500, maxTotalMs: 1000,
  windows: [
    { edge: "START" as const, state: "AMBIGUOUS" as const, sourceInterval: { startMs: 60300, endMs: 60700 }, evidenceSha256: "b".repeat(64) },
    { edge: "END" as const, state: "AMBIGUOUS" as const, sourceInterval: { startMs: 61300, endMs: 61700 }, evidenceSha256: "c".repeat(64) },
  ] };
const output = { result: { language: "en" }, transcription: [{ offsets: { from: 0, to: 300 }, text: " Hello.", tokens: [
  { text: "[_BEG_]", offsets: { from: 0, to: 0 }, p: 0.99 },
  { text: " Hel", offsets: { from: 10, to: 100 }, p: 0.8 },
  { text: "lo", offsets: { from: 100, to: 200 }, p: 0.9 },
] }] };

describe("bounded local boundary sampling", () => {
  it("accepts only bounded, distinct windows at ambiguous edges", () => {
    expect(validateBoundaryAsrPlan(plan, sourceInterval)).toMatchObject({ totalMs: 800 });
    expect(() => validateBoundaryAsrPlan({ ...plan, maxWindowMs: 300 }, sourceInterval)).toThrow("WINDOW_LIMIT");
    expect(() => validateBoundaryAsrPlan({ ...plan, maxTotalMs: 700 }, sourceInterval)).toThrow("TOTAL_LIMIT");
    expect(() => validateBoundaryAsrPlan({ ...plan, windows: [plan.windows[0], plan.windows[0]] }, sourceInterval)).toThrow("DUPLICATE_EDGE");
    expect(() => validateBoundaryAsrPlan({ ...plan, corridor: { startMs: 59000, endMs: 61500 } }, sourceInterval)).toThrow("CORRIDOR_OUTSIDE_AUDIO");
    expect(() => validateBoundaryAsrPlan({ ...plan, windows: [{ ...plan.windows[0], sourceInterval: { startMs: 60800, endMs: 61000 } }] }, sourceInterval)).toThrow("WINDOW_OUTSIDE_EDGE");
    expect(() => validateBoundaryAsrPlan({ ...plan, windows: [{ ...plan.windows[0], state: "CLEAR" as "AMBIGUOUS" }] }, sourceInterval)).toThrow();
  });
  it("rejects full-service sampling and overlapping windows despite permissive budgets", () => {
    expect(() => validateBoundaryAsrPlan({ ...plan, maxWindowMs: 2000, maxTotalMs: 4000,
      windows: [{ ...plan.windows[0], sourceInterval }] }, sourceInterval)).toThrow("TOTAL_LIMIT");
    expect(() => validateBoundaryAsrPlan({ ...plan, maxWindowMs: 2000, maxTotalMs: 4000, windows: [
      { ...plan.windows[0], sourceInterval: { startMs: 60200, endMs: 61200 } },
      { ...plan.windows[1], sourceInterval: { startMs: 61000, endMs: 61800 } },
    ] }, sourceInterval)).toThrow("OVERLAPPING_WINDOWS");
  });
  it("preserves native subword probabilities and maps timestamps without merging tokens", () => {
    const parsed = parseBoundaryAsrOutput(JSON.stringify(output), plan.windows[0].sourceInterval);
    expect(parsed.segments[0]).toMatchObject({ startMs: 60300, endMs: 60600, text: " Hello.", tokens: [
      { text: "[_BEG_]", startMs: 60300, endMs: 60300, probability: 0.99, confidenceUnit: "native_subword_token" },
      { text: " Hel", startMs: 60310, endMs: 60400, probability: 0.8, confidenceUnit: "native_subword_token" },
      { text: "lo", startMs: 60400, endMs: 60500, probability: 0.9, confidenceUnit: "native_subword_token" },
    ] });
  });
  it("rejects missing native fields, invalid probabilities, and timestamps outside the extracted audio", () => {
    expect(() => parseBoundaryAsrOutput("{}", sourceInterval)).toThrow();
    const changed = structuredClone(output);
    changed.transcription[0].tokens[0].p = 2;
    expect(() => parseBoundaryAsrOutput(JSON.stringify(changed), sourceInterval)).toThrow();
    expect(() => parseBoundaryAsrOutput(JSON.stringify(output), { startMs: 60000, endMs: 60200 })).toThrow("TIMESTAMP_OUTSIDE_WINDOW");
  });

  let root: string, temporaryRoot: string, audio: { path: string; sha256: string; byteCount: number; sourceInterval: typeof sourceInterval };
  let settings: z.infer<typeof boundaryAsrSettingsSchema>;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "boundary-asr-test-"));
    temporaryRoot = path.join(root, "temporary");
    const modelRoot = path.join(root, "models");
    await mkdir(temporaryRoot); await mkdir(modelRoot);
    const file = path.join(root, "analysis.flac");
    await promisify(execFile)("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=sample_rate=16000:duration=2",
      "-c:a", "flac", "-threads", "1", file]);
    audio = { path: file, ...await fileIdentity(file), sourceInterval };
    const modelFile = path.join(modelRoot, "fixture.bin");
    await writeFile(modelFile, "dummy model bytes, not real weights");
    const binaryPath = path.join(root, "fixture-cli");
    await writeFile(binaryPath, `#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n if [ "$1" = "-of" ]; then shift; target="$1.json"; fi\n shift\ndone\nprintf '%s' '${JSON.stringify(output)}' > "$target"\n`, { mode: 0o700 });
    settings = { binaryPath, modelRoot, usage: "evaluation", language: "en", threads: 1, timeoutMs: 30000, maxOutputBytes: 1048576,
      extraction: { threads: 1, flacCompressionLevel: 5, timeoutMs: 30000, maxMetadataBytes: 1048576, maxFileBytes: 1048576 },
      model: { modelId: "fixture", version: "v1", roles: ["BOUNDARY_ASR"], relativePath: "fixture.bin", ...await fileIdentity(modelFile),
        upstreamRevision: "fixture", sourceUrl: "https://example.test/model",
        license: { spdx: "MIT", codeEvidenceUrl: "https://example.test/code", weightsEvidenceUrl: "https://example.test/weights",
          reviewStatus: "REVIEWED_FOR_EVALUATION", reviewReference: "fixture-only" },
        productionApproval: { approved: false, evaluationEvidenceSha256: null, decisionReference: null } } };
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });
  it("extracts exact local windows, retains source evidence, and removes all temporary outputs", async () => {
    const result = await sampleAmbiguousBoundaries(audio, plan, settings, temporaryRoot);
    expect(result).toMatchObject({ role: "local_boundary_sampling", boundaryStatus: "unresolved", classification: "not_performed",
      coverage: "requested_windows_only", plan: { totalMs: 800 }, results: [
        { edge: "START", mappingEvidence: { sourceOffsetMs: 60300, sampleCount: 6400 }, segments: [{ startMs: 60300 }] },
        { edge: "END", mappingEvidence: { sourceOffsetMs: 61300, sampleCount: 6400 }, segments: [{ startMs: 61300 }] },
      ] });
    expect(JSON.stringify(result)).not.toContain(root);
    expect(result.measurements).toHaveLength(2);
    expect(result.measurements.every(item => item.wallTimeMs > 0 && item.cpuTimeMs === null)).toBe(true);
    const repeated = await sampleAmbiguousBoundaries(audio, plan, settings, temporaryRoot);
    expect(repeated.evidenceSha256).toBe(result.evidenceSha256);
    expect(await readdir(temporaryRoot)).toEqual([]);
  }, 30000);
  it("refuses excessive combined JSON bytes and removes failed outputs", async () => {
    await expect(sampleAmbiguousBoundaries(audio, plan, { ...settings,
      maxOutputBytes: Buffer.byteLength(JSON.stringify(output)) + 1 }, temporaryRoot)).rejects.toThrow("OUTPUT_LIMIT");
    expect(await readdir(temporaryRoot)).toEqual([]);
  }, 30000);
  it("rejects incorrect model roles and unapproved production models before extraction", async () => {
    await expect(sampleAmbiguousBoundaries(audio, plan, { ...settings, model: { ...settings.model, roles: ["OCR"] } }, temporaryRoot)).rejects.toThrow("MODEL_ROLE_REQUIRED");
    await expect(sampleAmbiguousBoundaries(audio, plan, { ...settings, usage: "production" }, temporaryRoot)).rejects.toThrow("PRODUCTION_VOLUME_REQUIRED");
    expect(await readdir(temporaryRoot)).toEqual([]);
  });
  it("stops timed-out inference and removes its extracted audio", async () => {
    const binaryPath = path.join(root, "slow-cli");
    await writeFile(binaryPath, "#!/bin/sh\nexec sleep 5\n", { mode: 0o700 });
    await expect(sampleAmbiguousBoundaries(audio, plan, { ...settings, binaryPath, timeoutMs: 50 }, temporaryRoot)).rejects.toThrow();
    expect(await readdir(temporaryRoot)).toEqual([]);
  }, 30000);
  it("rejects changed analysis audio before running a sample", async () => {
    await expect(sampleAmbiguousBoundaries({ ...audio, sha256: "d".repeat(64) }, plan, settings, temporaryRoot)).rejects.toThrow("INPUT_CHANGED");
    expect(await readdir(temporaryRoot)).toEqual([]);
  });
  it("removes extracted audio after an inference failure", async () => {
    const binaryPath = path.join(root, "failed-cli");
    await writeFile(binaryPath, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    await expect(sampleAmbiguousBoundaries(audio, plan, { ...settings, binaryPath }, temporaryRoot)).rejects.toThrow();
    expect(await readdir(temporaryRoot)).toEqual([]);
  }, 30000);
});
