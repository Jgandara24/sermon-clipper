import path from "node:path";
import { lstat } from "node:fs/promises";
import { z } from "zod";
import { sha256Schema } from "@/lib/media-artifacts/types";
import { fileIdentity } from "@/lib/storage/file-identity";
import { execFileWithTimeout } from "./child-process";
import { localModelDescriptorSchema, verifyLocalModel } from "./local-models";
import { rangeEvidenceSha256 } from "./range-evidence";

const integer = z.number().int().nonnegative().safe();
const frameSchema = z.object({ groupIndex: integer, sourceTimeMs: integer, path: z.string().min(1),
  sha256: sha256Schema, byteCount: integer.positive(), width: integer.positive(), height: integer.positive() }).strict();
export const sparseOcrInputSchema = z.object({ sourceVideoId: z.string().uuid(), sourceSha256: sha256Schema,
  representativeEvidenceSha256: sha256Schema, frames: z.array(frameSchema).max(1000),
  selections: z.array(z.object({ groupIndex: integer, frameSha256: sha256Schema,
    decision: z.literal("LIKELY_STATIC_TEXT"), evidenceSha256: sha256Schema }).strict()).max(1000),
}).strict();
export const sparseOcrSettingsSchema = z.object({ binaryPath: z.string().refine(path.isAbsolute),
  modelRoot: z.string().refine(path.isAbsolute), usage: z.enum(["evaluation", "production"]),
  model: localModelDescriptorSchema, pageSegmentationMode: z.number().int().min(3).max(13),
  maxSelectedFrames: integer.positive().max(1000), maxInputBytes: integer.positive(),
  maxOutputBytes: integer.positive().max(2147483647), timeoutMs: integer.positive().max(2147483647),
}).strict();
const HEADER = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";

/** Native confidence remains on Tesseract's 0–100 scale. Layout rows do not become words. */
export function parseOcrTsv(output: string, width: number, height: number) {
  const lines = output.split(/\r?\n/);
  while (lines.at(-1) === "") lines.pop();
  if (lines.shift() !== HEADER) throw new Error("OCR_TSV_HEADER_INVALID");
  const words = [];
  for (const line of lines) {
    const fields = line.split("\t");
    if (fields.length !== 12) throw new Error("OCR_TSV_ROW_INVALID");
    const numbers = fields.slice(0, 10).map(value => /^\d+$/.test(value) ? Number(value) : NaN);
    const [level, page, block, paragraph, textLine, word, left, top, boxWidth, boxHeight] = numbers;
    if (numbers.some(value => !Number.isSafeInteger(value)) || level < 1 || level > 5 || page !== 1 ||
      left > width || top > height || boxWidth > width - left || boxHeight > height - top) throw new Error("OCR_TSV_GEOMETRY_INVALID");
    if (level !== 5) continue;
    const confidence = fields[10].trim() ? Number(fields[10]) : NaN;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100 || !boxWidth || !boxHeight || !block || !paragraph || !textLine || !word || !fields[11].trim()) {
      throw new Error("OCR_TSV_WORD_INVALID");
    }
    words.push({ text: fields[11], confidence, confidenceScale: "tesseract_0_100" as const,
      block, paragraph, line: textLine, word, box: { left, top, width: boxWidth, height: boxHeight } });
  }
  return words;
}

/** Reads selected image files only. Selection evidence is supplied by the caller, never inferred from OCR output. */
export async function runSparseOcr(inputValue: z.infer<typeof sparseOcrInputSchema>, settingsValue: z.infer<typeof sparseOcrSettingsSchema>) {
  const input = sparseOcrInputSchema.parse(inputValue), settings = sparseOcrSettingsSchema.parse(settingsValue);
  if (new Set(input.frames.map(frame => frame.groupIndex)).size !== input.frames.length ||
    new Set(input.selections.map(selection => selection.groupIndex)).size !== input.selections.length) throw new Error("OCR_DUPLICATE_GROUP");
  if (input.selections.length > settings.maxSelectedFrames) throw new Error("OCR_FRAME_LIMIT_EXCEEDED");
  const selected = input.selections.map(selection => {
    const frame = input.frames.find(candidate => candidate.groupIndex === selection.groupIndex);
    if (!frame || frame.sha256 !== selection.frameSha256) throw new Error("OCR_SELECTION_NOT_REPRESENTATIVE");
    return { frame, selection };
  }).sort((a, b) => a.frame.groupIndex - b.frame.groupIndex);
  const totalBytes = selected.reduce((sum, item) => sum + item.frame.byteCount, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > settings.maxInputBytes) throw new Error("OCR_INPUT_LIMIT_EXCEEDED");
  if (!settings.model.roles.includes("OCR")) throw new Error("OCR_MODEL_ROLE_REQUIRED");
  const language = /^([A-Za-z0-9_]+)\.traineddata$/.exec(path.basename(settings.model.relativePath))?.[1];
  if (!language) throw new Error("OCR_MODEL_FILENAME_INVALID");
  const model = await verifyLocalModel(settings.model, { modelRoot: settings.modelRoot, usage: settings.usage });
  const limits = { timeoutMs: settings.timeoutMs, maxBuffer: settings.maxOutputBytes };
  const { stdout: toolchain } = await execFileWithTimeout(settings.binaryPath, ["--version"], limits);
  if (!toolchain.startsWith("tesseract ")) throw new Error("OCR_TOOLCHAIN_INVALID");
  const toolchainSha256 = rangeEvidenceSha256(toolchain);
  const results = [];
  const measurements = [];
  let remainingOutputBytes = settings.maxOutputBytes;
  for (const { frame, selection } of selected) {
    if (!path.isAbsolute(frame.path) || !(await lstat(frame.path)).isFile()) throw new Error("OCR_LOCAL_IMAGE_REQUIRED");
    const before = await fileIdentity(frame.path);
    if (before.sha256 !== frame.sha256 || before.byteCount !== frame.byteCount) throw new Error("OCR_FRAME_CHANGED");
    if (remainingOutputBytes <= 0) throw new Error("OCR_OUTPUT_LIMIT_EXCEEDED");
    const started = performance.now();
    const { stdout } = await execFileWithTimeout(settings.binaryPath, [frame.path, "stdout", "--tessdata-dir", path.dirname(model.path),
      "-l", language, "--psm", String(settings.pageSegmentationMode), "--oem", "1", "-c", "tessedit_create_tsv=1"], { ...limits, maxBuffer: remainingOutputBytes });
    remainingOutputBytes -= Buffer.byteLength(stdout, "utf8");
    if (remainingOutputBytes < 0) throw new Error("OCR_OUTPUT_LIMIT_EXCEEDED");
    const wallTimeMs = performance.now() - started;
    const after = await fileIdentity(frame.path);
    if (after.sha256 !== before.sha256 || after.byteCount !== before.byteCount) throw new Error("OCR_FRAME_CHANGED");
    results.push({ groupIndex: frame.groupIndex, sourceTimeMs: frame.sourceTimeMs, frameSha256: frame.sha256,
      selectionEvidenceSha256: selection.evidenceSha256, words: parseOcrTsv(stdout, frame.width, frame.height) });
    measurements.push({ groupIndex: frame.groupIndex, wallTimeMs, cpuTimeMs: null });
  }
  const modelEvidence = { modelId: model.modelId, version: model.version, sha256: model.sha256,
    byteCount: model.byteCount, upstreamRevision: model.upstreamRevision, licenseSpdx: model.licenseSpdx,
    licenseReviewReference: model.licenseReviewReference, usage: model.usage };
  const configuration = { version: "sparse-tesseract-ocr-v1", model: modelEvidence,
    pageSegmentationMode: settings.pageSegmentationMode, engineMode: 1, toolchainSha256 };
  const evidence = { ...configuration, sourceVideoId: input.sourceVideoId, sourceSha256: input.sourceSha256,
    representativeEvidenceSha256: input.representativeEvidenceSha256,
    configurationSha256: rangeEvidenceSha256(configuration), selectedFrames: results.length,
    results, classification: "not_performed", coverage: "selected_instants_only" };
  return { ...evidence, evidenceSha256: rangeEvidenceSha256(evidence), measurements };
}
