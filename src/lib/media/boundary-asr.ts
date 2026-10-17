import { lstat, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { sha256Schema, sourceIntervalSchema } from "@/lib/media-artifacts/types";
import { fileIdentity } from "@/lib/storage/file-identity";
import { execFileWithTimeout } from "./child-process";
import { localModelDescriptorSchema, verifyLocalModel } from "./local-models";
import { extractSermonAudio, sermonAudioSettingsSchema, type SermonAudioInput } from "./sermon-audio";
import { rangeEvidenceSha256 } from "./range-evidence";

const integer = z.number().int().nonnegative().safe();
const windowSchema = z.object({ edge: z.enum(["START", "END"]), state: z.literal("AMBIGUOUS"),
  sourceInterval: sourceIntervalSchema, evidenceSha256: sha256Schema }).strict();
export const boundaryAsrPlanSchema = z.object({ sourceVideoId: z.string().uuid(), sourceSha256: sha256Schema,
  corridor: sourceIntervalSchema, windows: z.array(windowSchema).min(1).max(2),
  maxWindowMs: integer.positive(), maxTotalMs: integer.positive() }).strict();
export const boundaryAsrSettingsSchema = z.object({ binaryPath: z.string().refine(path.isAbsolute),
  modelRoot: z.string().refine(path.isAbsolute), usage: z.enum(["evaluation", "production"]),
  model: localModelDescriptorSchema, language: z.string().regex(/^[a-z]{2,3}$|^auto$/),
  threads: integer.positive(), timeoutMs: integer.positive().max(2147483647),
  maxOutputBytes: integer.positive().max(2147483647), extraction: sermonAudioSettingsSchema }).strict();

/** Validate all windows before file access or inference. No window or duration default is inferred. */
export function validateBoundaryAsrPlan(value: z.infer<typeof boundaryAsrPlanSchema>, audioInterval: { startMs: number; endMs: number }) {
  const plan = boundaryAsrPlanSchema.parse(value), audio = sourceIntervalSchema.parse(audioInterval);
  if (plan.corridor.startMs < audio.startMs || plan.corridor.endMs > audio.endMs) throw new Error("BOUNDARY_ASR_CORRIDOR_OUTSIDE_AUDIO");
  if (new Set(plan.windows.map(window => window.edge)).size !== plan.windows.length) throw new Error("BOUNDARY_ASR_DUPLICATE_EDGE");
  const windows = [...plan.windows].sort((a, b) => a.sourceInterval.startMs - b.sourceInterval.startMs);
  let totalMs = 0;
  for (const [index, window] of windows.entries()) {
    const { startMs, endMs } = window.sourceInterval;
    const boundary = window.edge === "START" ? plan.corridor.startMs : plan.corridor.endMs;
    if (startMs < audio.startMs || endMs > audio.endMs || startMs > boundary || endMs < boundary) {
      throw new Error("BOUNDARY_ASR_WINDOW_OUTSIDE_EDGE");
    }
    if (endMs - startMs > plan.maxWindowMs) throw new Error("BOUNDARY_ASR_WINDOW_LIMIT");
    if (index && windows[index - 1].sourceInterval.endMs > startMs) throw new Error("BOUNDARY_ASR_OVERLAPPING_WINDOWS");
    totalMs += endMs - startMs;
  }
  if (!Number.isSafeInteger(totalMs) || totalMs > plan.maxTotalMs || totalMs >= audio.endMs - audio.startMs) {
    throw new Error("BOUNDARY_ASR_TOTAL_LIMIT");
  }
  return { ...plan, windows, totalMs };
}

const offsetsSchema = z.object({ from: integer, to: integer }).refine(value => value.to >= value.from);
const outputSchema = z.object({ result: z.object({ language: z.string().min(1) }),
  transcription: z.array(z.object({ text: z.string(), offsets: offsetsSchema,
    tokens: z.array(z.object({ text: z.string(), offsets: offsetsSchema, p: z.number().finite().min(0).max(1) })) })) });

/** Preserve native subword probabilities. They are not word confidence or boundary confidence. */
export function parseBoundaryAsrOutput(raw: string, sourceInterval: { startMs: number; endMs: number }) {
  const interval = sourceIntervalSchema.parse(sourceInterval), parsed = outputSchema.parse(JSON.parse(raw));
  const duration = interval.endMs - interval.startMs;
  const mapped = (offsets: z.infer<typeof offsetsSchema>) => {
    if (offsets.to > duration) throw new Error("BOUNDARY_ASR_TIMESTAMP_OUTSIDE_WINDOW");
    return { startMs: interval.startMs + offsets.from, endMs: interval.startMs + offsets.to };
  };
  return { language: parsed.result.language, segments: parsed.transcription.map(segment => ({
    text: segment.text, ...mapped(segment.offsets), tokens: segment.tokens.map(token => ({
      text: token.text, ...mapped(token.offsets), probability: token.p, confidenceUnit: "native_subword_token" as const,
    })),
  })) };
}

/** Separate local Pass A role. Never resolves caption providers or sends a paid request.
 * Callers retain the returned evidence before using it. This adapter does not choose a corridor.
 * The model volume must stay read-only throughout execution.
 */
export async function sampleAmbiguousBoundaries(audio: SermonAudioInput,
  planValue: z.infer<typeof boundaryAsrPlanSchema>, settingsValue: z.infer<typeof boundaryAsrSettingsSchema>, temporaryRoot: string) {
  const plan = validateBoundaryAsrPlan(planValue, audio.sourceInterval);
  const settings = boundaryAsrSettingsSchema.parse(settingsValue);
  if (!settings.model.roles.includes("BOUNDARY_ASR")) throw new Error("BOUNDARY_ASR_MODEL_ROLE_REQUIRED");
  const model = await verifyLocalModel(settings.model, { modelRoot: settings.modelRoot, usage: settings.usage });
  const binaryPath = await realpath(settings.binaryPath);
  if (!(await lstat(binaryPath)).isFile()) throw new Error("BOUNDARY_ASR_BINARY_REQUIRED");
  const binary = await fileIdentity(binaryPath);
  const configuration = { version: "bounded-whisper-boundary-asr-v1", binarySha256: binary.sha256,
    model: { modelId: model.modelId, version: model.version, sha256: model.sha256, upstreamRevision: model.upstreamRevision,
      licenseSpdx: model.licenseSpdx, licenseReviewReference: model.licenseReviewReference, usage: model.usage },
    language: settings.language, threads: settings.threads, decoding: "cli-defaults", extraction: settings.extraction,
    limits: { timeoutMs: settings.timeoutMs, maxOutputBytes: settings.maxOutputBytes } };
  const results = [], measurements = [];
  let remainingBytes = settings.maxOutputBytes;
  for (const window of plan.windows) {
    const started = performance.now();
    const extracted = await extractSermonAudio(audio, { sourceInterval: window.sourceInterval,
      detectorVersion: "boundary-window-request-v1", evidenceSha256: window.evidenceSha256,
      // A zero confidence value never promotes the caller's ambiguous edge.
      confidence: 0 }, temporaryRoot, settings.extraction);
    try {
      if (remainingBytes <= 0) throw new Error("BOUNDARY_ASR_OUTPUT_LIMIT");
      const outputBase = path.join(extracted.directory, "boundary");
      await execFileWithTimeout(binaryPath, ["-m", model.path, "-f", extracted.path, "-l", settings.language,
        "-t", String(settings.threads), "-ojf", "-of", outputBase, "-np"],
      { timeoutMs: settings.timeoutMs, maxBuffer: remainingBytes });
      const outputPath = `${outputBase}.json`, stat = await lstat(outputPath);
      if (!stat.isFile() || stat.size > remainingBytes) throw new Error("BOUNDARY_ASR_OUTPUT_LIMIT");
      const raw = await readFile(outputPath, "utf8");
      remainingBytes -= Buffer.byteLength(raw);
      if (remainingBytes < 0) throw new Error("BOUNDARY_ASR_OUTPUT_LIMIT");
      if ((await fileIdentity(extracted.path)).sha256 !== extracted.sha256 || (await fileIdentity(binaryPath)).sha256 !== binary.sha256) {
        throw new Error("BOUNDARY_ASR_EXECUTION_INPUT_CHANGED");
      }
      results.push({ edge: window.edge, sourceInterval: window.sourceInterval, ambiguityEvidenceSha256: window.evidenceSha256,
        audioSha256: extracted.sha256, audioByteCount: extracted.byteCount, mappingEvidence: extracted.evidence,
        rawOutputSha256: rangeEvidenceSha256(raw), ...parseBoundaryAsrOutput(raw, window.sourceInterval) });
      measurements.push({ edge: window.edge, wallTimeMs: performance.now() - started, cpuTimeMs: null });
    } finally {
      await rm(extracted.directory, { recursive: true, force: true });
    }
  }
  const evidence = { ...configuration, sourceVideoId: plan.sourceVideoId, sourceSha256: plan.sourceSha256,
    analysisAudioSha256: audio.sha256, plan, configurationSha256: rangeEvidenceSha256(configuration), results,
    role: "local_boundary_sampling", classification: "not_performed", boundaryStatus: "unresolved", coverage: "requested_windows_only" };
  return { ...evidence, evidenceSha256: rangeEvidenceSha256(evidence), measurements };
}
