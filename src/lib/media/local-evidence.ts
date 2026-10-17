import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { buildAnalysisDerivatives } from "./analysis-derivatives";
import type { MaterializedSource } from "./source-lease";
import { extractAudioEvidence, audioEvidenceSettingsSchema } from "./audio-evidence";
import { extractVideoEvidence, videoEvidenceSettingsSchema } from "./video-evidence";
import { representativeFrameSettingsSchema } from "./representative-frames";
import { extractFrameHashes, frameHashSettingsSchema, groupFrameHashes, frameGroupingSettingsSchema } from "./frame-hashes";

export const LOCAL_EVIDENCE_VERSION = "local-evidence-document-v1";
export const localEvidenceSettingsSchema = z.object({
  audio: audioEvidenceSettingsSchema, video: videoEvidenceSettingsSchema,
  frames: frameHashSettingsSchema, grouping: frameGroupingSettingsSchema,
  representatives: representativeFrameSettingsSchema.optional(),
  maxDocumentBytes: z.number().int().positive().max(2147483647),
}).strict();
export type LocalEvidenceSettings = z.infer<typeof localEvidenceSettingsSchema>;

// Operational limits can change without changing detector output or its content identity.
function contentResult<T extends { settings: object }>(result: T) {
  return { ...result, settings: Object.fromEntries(Object.entries(result.settings).filter(([key]) =>
    !["timeoutMs", "maxMetadataBytes", "maxOutputBytes", "maxFrames"].includes(key))) };
}

/** Creates deterministic evidence bytes in the current lease directory. No remote write occurs here. */
export async function buildLocalEvidenceDocument(source: MaterializedSource,
  derivatives: Awaited<ReturnType<typeof buildAnalysisDerivatives>>, settingsInput: LocalEvidenceSettings) {
  const settings = localEvidenceSettingsSchema.parse(settingsInput);
  const mapping = { sourceInterval: derivatives.sourceInterval, artifactOriginMs: 0, timeScale: "1:1" as const };
  const audioInput = { path: derivatives.analysis.path, sha256: derivatives.analysis.sha256,
    byteCount: derivatives.analysis.byteCount, mapping };
  const videoInput = { path: derivatives.proxy.path, sha256: derivatives.proxy.sha256,
    byteCount: derivatives.proxy.byteCount, mapping };
  // Sequential passes bound concurrent decoder and metadata memory use.
  const audio = await extractAudioEvidence(audioInput, settings.audio);
  const video = await extractVideoEvidence(videoInput, settings.video);
  const frames = await extractFrameHashes(videoInput, settings.frames);
  const grouping = groupFrameHashes(frames.samples, settings.grouping);
  const configurationSha256 = createHash("sha256").update(JSON.stringify([
    LOCAL_EVIDENCE_VERSION, derivatives.configurationSha256, derivatives.analysis.sha256, derivatives.proxy.sha256,
    audio.configurationSha256, video.configurationSha256, frames.configurationSha256, grouping.configurationSha256,
  ])).digest("hex");
  const document = {
    schemaVersion: LOCAL_EVIDENCE_VERSION, sourceVideoId: source.sourceVideoId, sourceSha256: source.sha256,
    sourceInterval: derivatives.sourceInterval, sourcePresentationOriginMs: derivatives.sourcePresentationOriginMs,
    derivationVersion: derivatives.derivationVersion, derivativeConfigurationSha256: derivatives.configurationSha256,
    configurationSha256, audio: contentResult(audio), video: contentResult(video), frames: contentResult(frames), grouping,
  };
  const bytes = Buffer.from(JSON.stringify(document), "utf8");
  if (bytes.length > settings.maxDocumentBytes) throw new Error("MEDIA_LOCAL_EVIDENCE_DOCUMENT_LIMIT_EXCEEDED");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const file = path.join(path.dirname(derivatives.analysis.path), "local-evidence.json");
  await writeFile(file, bytes, { flag: "wx" });
  return { path: file, sha256, byteCount: bytes.length, configurationSha256, derivationVersion: LOCAL_EVIDENCE_VERSION,
    frameSampleTimesMs: frames.samples.map(sample => sample.timeMs),
    representativeSelection: grouping.groups.map((group, groupIndex) => ({ groupIndex,
      sampleIndex: group.representativeIndex, sourceTimeMs: frames.samples[group.representativeIndex].timeMs })),
    counts: { waveformWindows: audio.waveform.length, silenceIntervals: audio.silence.length,
      videoFrames: video.frameCount, scenes: video.scenes.length, blackIntervals: video.black.length,
      freezeIntervals: video.freeze.length, sparseFrames: frames.samples.length, representativeGroups: grouping.groups.length } };
}
