import { z } from "zod";
import { AUDIO_EVIDENCE_VERSION, audioEvidenceSettingsSchema, extractAudioEvidence, type AudioEvidenceSettings } from "@/lib/media/audio-evidence";
import { rangeEvidenceSha256 } from "@/lib/media/range-evidence";
import { sha256Schema, sourceTimeMappingSchema } from "@/lib/media-artifacts/types";
import { deriveTranscriptBoundaries, transcriptBoundarySettingsSchema } from "./boundaries";
import { transcriptProvenanceSchema, type TranscriptProvenance } from "./provenance";
import type { TranscriptionResult } from "./types";

const audioProofSchema = z.object({ detectorVersion: z.literal(AUDIO_EVIDENCE_VERSION), configurationSha256: sha256Schema,
  toolchainSha256: sha256Schema, settings: audioEvidenceSettingsSchema, inputSha256: sha256Schema,
  inputByteCount: z.number().int().positive().safe(), mapping: sourceTimeMappingSchema,
  sampleRateHz: z.literal(16000), totalSamples: z.number().int().positive().safe(),
  observedStartMs: z.number().int().nonnegative().safe(), observedEndMs: z.number().int().nonnegative().safe(),
});
const proofSchema = audioProofSchema.extend({ silence: z.array(z.object({ startMs: z.number().int().nonnegative().safe(),
  endMs: z.number().int().nonnegative().safe(), endReason: z.enum(["DETECTED", "OBSERVED_AUDIO_END"]) }).strict()) }).strict();
const requestSchema = z.object({ version: z.literal("transcript-structure-v1"), audioEvidence: proofSchema,
  settings: transcriptBoundarySettingsSchema, boundaries: z.unknown() }).strict();

function derive(result: TranscriptionResult, provenance: TranscriptProvenance,
  audio: z.infer<typeof proofSchema>, settings: z.infer<typeof transcriptBoundarySettingsSchema>) {
  return deriveTranscriptBoundaries({ submittedAudioSha256: provenance.submittedAudioSha256,
    sourceInterval: provenance.sourceInterval,
    words: result.segments.flatMap(segment => segment.words.map(word => ({ text: word.word,
      startMs: word.startMs - provenance.sourceOffsetMs, endMs: word.endMs - provenance.sourceOffsetMs,
      speakerId: word.speakerLabel ?? null }))), settings,
    acousticSilence: { status: "available", evidenceSha256: rangeEvidenceSha256(audio),
      intervals: audio.silence.map(({ startMs, endMs }) => ({ startMs, endMs })) } });
}

/** Validate stored structure against the exact persisted words and submitted audio identity. */
export function validateTranscriptStructure(value: unknown, result: TranscriptionResult, provenanceValue: TranscriptProvenance) {
  const provenance = transcriptProvenanceSchema.parse(provenanceValue), structure = requestSchema.parse(value);
  const audio = structure.audioEvidence;
  if (audio.inputSha256 !== provenance.submittedAudioSha256 || audio.totalSamples !== provenance.submittedDurationMs * 16 ||
    audio.mapping.artifactOriginMs !== 0 || audio.mapping.sourceInterval.startMs !== provenance.sourceInterval.startMs ||
    audio.mapping.sourceInterval.endMs !== provenance.sourceInterval.endMs || audio.observedStartMs !== provenance.sourceInterval.startMs ||
    audio.observedEndMs !== provenance.sourceInterval.endMs) throw new Error("TRANSCRIPT_STRUCTURE_AUDIO_MISMATCH");
  const boundaries = derive(result, provenance, audio, structure.settings);
  if (rangeEvidenceSha256(boundaries) !== rangeEvidenceSha256(structure.boundaries)) throw new Error("TRANSCRIPT_STRUCTURE_BOUNDARIES_CHANGED");
  return { ...structure, boundaries };
}

/** Measure only the already selected audio. The caller supplies measured production settings. */
export async function buildTranscriptStructure(input: { audioPath: string; byteCount: number; result: TranscriptionResult;
  provenance: TranscriptProvenance; audioSettings: AudioEvidenceSettings; boundarySettings: z.infer<typeof transcriptBoundarySettingsSchema> }) {
  const provenance = transcriptProvenanceSchema.parse(input.provenance);
  const measured = await extractAudioEvidence({ path: input.audioPath, sha256: provenance.submittedAudioSha256,
    byteCount: input.byteCount, mapping: { sourceInterval: provenance.sourceInterval, artifactOriginMs: 0, timeScale: "1:1" } }, input.audioSettings);
  const audioEvidence = proofSchema.parse({ detectorVersion: measured.detectorVersion, configurationSha256: measured.configurationSha256,
    toolchainSha256: measured.toolchainSha256, settings: measured.settings, inputSha256: measured.inputSha256,
    inputByteCount: measured.inputByteCount, mapping: measured.mapping, sampleRateHz: measured.sampleRateHz, totalSamples: measured.totalSamples,
    observedStartMs: measured.observedStartMs, observedEndMs: measured.observedEndMs, silence: measured.silence });
  const settings = transcriptBoundarySettingsSchema.parse(input.boundarySettings);
  return validateTranscriptStructure({ version: "transcript-structure-v1", audioEvidence, settings,
    boundaries: derive(input.result, provenance, audioEvidence, settings) }, input.result, provenance);
}
