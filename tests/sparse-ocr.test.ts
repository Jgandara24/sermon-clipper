import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { fileIdentity } from "@/lib/storage/file-identity";
import { execFileWithTimeout } from "@/lib/media/child-process";
import { runSparseOcr, parseOcrTsv } from "@/lib/media/sparse-ocr";
vi.mock("@/lib/media/child-process", () => ({ execFileWithTimeout: vi.fn() }));
const header = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";
const word = "5\t1\t1\t1\t1\t1\t10\t20\t40\t30\t94.5\tFixture";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "sparse-ocr-test-"));
  vi.mocked(execFileWithTimeout).mockImplementation(async (_binary, args) => ({
    stdout: args[0] === "--version" ? "tesseract fixture" : `${header}\n${word}\n`, stderr: "" }));
});
afterEach(async () => { vi.resetAllMocks(); await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const modelPath = path.join(root, "eng.traineddata"), imagePath = path.join(root, "frame.webp");
  await writeFile(modelPath, "not real model weights"); await writeFile(imagePath, "not a real frame");
  const modelBytes = await fileIdentity(modelPath), image = await fileIdentity(imagePath);
  const frame = { groupIndex: 0, sourceTimeMs: 1000, path: imagePath, ...image, width: 854, height: 480 };
  return { input: { sourceVideoId: "11111111-1111-4111-8111-111111111111", sourceSha256: "a".repeat(64),
    representativeEvidenceSha256: "b".repeat(64), frames: [frame, { ...frame, groupIndex: 1, sourceTimeMs: 2000 }],
    selections: [{ groupIndex: 0, frameSha256: frame.sha256, decision: "LIKELY_STATIC_TEXT" as const, evidenceSha256: "c".repeat(64) }] },
    settings: { binaryPath: "/fixture/tesseract", modelRoot: root, usage: "evaluation" as const,
      model: { modelId: "fixture", version: "v1", roles: ["OCR" as const], relativePath: "eng.traineddata", ...modelBytes,
        upstreamRevision: "fixture", sourceUrl: "https://example.test/model",
        license: { spdx: "MIT", codeEvidenceUrl: "https://example.test/license", weightsEvidenceUrl: "https://example.test/weights",
          reviewStatus: "REVIEWED_FOR_EVALUATION" as const, reviewReference: "fixture-only" },
        productionApproval: { approved: false, evaluationEvidenceSha256: null, decisionReference: null } },
      pageSegmentationMode: 6, maxSelectedFrames: 1, maxInputBytes: 1000, maxOutputBytes: 10000, timeoutMs: 1000 } };
}
it("runs OCR only on selected representatives and retains frame, selection, and model evidence", async () => {
  const { input, settings } = await fixture();
  const result = await runSparseOcr(input, settings);
  expect(result).toMatchObject({ selectedFrames: 1, classification: "not_performed", coverage: "selected_instants_only",
    results: [{ groupIndex: 0, sourceTimeMs: 1000, words: [{ text: "Fixture", confidence: 94.5, confidenceScale: "tesseract_0_100" }] }] });
  expect(execFileWithTimeout).toHaveBeenCalledTimes(2);
  expect(execFileWithTimeout).toHaveBeenLastCalledWith(settings.binaryPath, expect.arrayContaining([input.frames[0].path,
    "stdout", "tessedit_create_tsv=1"]), { timeoutMs: 1000, maxBuffer: 10000 });
  expect(JSON.stringify(result)).not.toContain(root);
  expect((await runSparseOcr(input, settings)).evidenceSha256).toBe(result.evidenceSha256);
});
it.each(["unknown", "hash", "duplicate", "frame-budget", "byte-budget", "changed-model", "changed-frame"])("refuses invalid input: %s", async mode => {
  const { input, settings } = await fixture();
  if (mode === "unknown") input.selections[0].groupIndex = 99;
  if (mode === "hash") input.selections[0].frameSha256 = "d".repeat(64);
  if (mode === "duplicate") input.selections.push(input.selections[0]);
  if (mode === "frame-budget") input.selections.push({ ...input.selections[0], groupIndex: 1 });
  if (mode === "byte-budget") settings.maxInputBytes = 1;
  if (mode === "changed-model") await writeFile(path.join(root, "eng.traineddata"), "changed");
  if (mode === "changed-frame") await writeFile(input.frames[0].path, "changed");
  await expect(runSparseOcr(input, settings)).rejects.toThrow();
  expect(vi.mocked(execFileWithTimeout).mock.calls.every(call => call[1][0] === "--version")).toBe(true);
});
it("propagates a bounded child failure without returning partial OCR evidence", async () => {
  const { input, settings } = await fixture();
  vi.mocked(execFileWithTimeout).mockImplementation(async (_binary, args) => {
    if (args[0] === "--version") return { stdout: "tesseract fixture", stderr: "" };
    throw new Error("fixture timeout");
  });
  await expect(runSparseOcr(input, settings)).rejects.toThrow("fixture timeout");
});
it("preserves empty layout rows without inventing words", () => {
  expect(parseOcrTsv(`${header}\n1\t1\t0\t0\t0\t0\t0\t0\t854\t480\t-1\t\n`, 854, 480)).toEqual([]);
});
it.each(["header", "confidence", "geometry", "page", "columns"])("rejects malformed TSV: %s", mode => {
  let text = `${header}\n${word}\n`;
  if (mode === "header") text = "wrong\n";
  if (mode === "confidence") text = text.replace("94.5", "101");
  if (mode === "geometry") text = text.replace("\t40\t30\t", "\t900\t30\t");
  if (mode === "page") text = text.replace("5\t1\t", "5\t2\t");
  if (mode === "columns") text += "invalid row\n";
  expect(() => parseOcrTsv(text, 854, 480)).toThrow();
});

it("shares one output budget across selected frames", async () => {
  const { input, settings } = await fixture();
  input.selections.push({ ...input.selections[0], groupIndex: 1 }); settings.maxSelectedFrames = 2;
  settings.maxOutputBytes = Buffer.byteLength(`${header}\n${word}\n`) + 1;
  await expect(runSparseOcr(input, settings)).rejects.toThrow("OCR_OUTPUT_LIMIT_EXCEEDED");
  expect(vi.mocked(execFileWithTimeout).mock.calls.at(-1)![2].maxBuffer).toBe(1);
});
