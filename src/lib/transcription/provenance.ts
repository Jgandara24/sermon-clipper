import { z } from "zod";
import { sha256Schema, sourceIntervalSchema } from "@/lib/media-artifacts/types";

const label = z.string().trim().min(1);
export const transcriptCapabilitySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("native"), provider: label, modelVersion: label }).strict(),
  z.object({ status: z.literal("derived"), algorithmVersion: label, inputSha256: sha256Schema }).strict(),
  z.object({ status: z.literal("unavailable"), reason: label }).strict(),
  z.object({ status: z.literal("user-supplied"), inputSha256: sha256Schema }).strict(),
]);

/** Each field declares its origin. Missing provider data never becomes native data. */
export const transcriptCapabilitiesSchema = z.object({
  wordTimestamps: transcriptCapabilitySchema,
  wordConfidence: transcriptCapabilitySchema,
  tokenConfidence: transcriptCapabilitySchema,
  speakerLabels: transcriptCapabilitySchema,
  audioEvents: transcriptCapabilitySchema,
  silences: transcriptCapabilitySchema,
  sentences: transcriptCapabilitySchema,
  paragraphs: transcriptCapabilitySchema,
}).strict();

export const transcriptProvenanceSchema = z.object({
  sourceVideoId: z.string().uuid(),
  sourceSha256: sha256Schema,
  submittedAudioSha256: sha256Schema,
  submittedDurationMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sourceInterval: sourceIntervalSchema,
  sourceOffsetMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  provider: label,
  modelVersion: label,
  // Some providers have no request ID. Record that limitation explicitly.
  requestIdentity: z.discriminatedUnion("status", [
    z.object({ status: z.literal("available"), id: label }).strict(),
    z.object({ status: z.literal("unavailable"), reason: label }).strict(),
  ]),
  capabilities: transcriptCapabilitiesSchema,
}).strict().superRefine((value, ctx) => {
  if (value.sourceOffsetMs !== value.sourceInterval.startMs) {
    ctx.addIssue({ code: "custom", path: ["sourceOffsetMs"],
      message: "The audio offset must equal the submitted source interval start." });
  }
  if (value.submittedDurationMs !== value.sourceInterval.endMs - value.sourceInterval.startMs) {
    ctx.addIssue({ code: "custom", path: ["submittedDurationMs"],
      message: "The submitted duration must equal the mapped interval duration." });
  }
});

export type TranscriptCapabilities = z.infer<typeof transcriptCapabilitiesSchema>;
export type TranscriptProvenance = z.infer<typeof transcriptProvenanceSchema>;

/** Word times inside an SRT cue are spread evenly by `parseSrt`; they are not measured. */
export const SRT_WORD_TIMING_ALGORITHM = "srt-cue-even-word-interpolation-v1";

/**
 * An uploaded SRT has no submitted audio. Its text and cue times are user-supplied, in source time.
 * No audio-derived field may claim to exist for it.
 */
export const userSuppliedTranscriptProvenanceSchema = z.object({
  kind: z.literal("USER_SUPPLIED_SRT"),
  sourceVideoId: z.string().uuid(),
  textAndCueTiming: z.object({ status: z.literal("user-supplied"), inputSha256: sha256Schema }).strict(),
  srtByteCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  parser: label,
  language: label,
  // SRT cue times are already source times.
  sourceOffsetMs: z.literal(0),
  capabilities: transcriptCapabilitiesSchema,
}).strict().superRefine((value, ctx) => {
  const words = value.capabilities.wordTimestamps;
  if (words.status !== "derived" || words.inputSha256 !== value.textAndCueTiming.inputSha256) {
    ctx.addIssue({ code: "custom", path: ["capabilities", "wordTimestamps"],
      message: "SRT word timestamps must be derived from the supplied file." });
  }
});
export type UserSuppliedTranscriptProvenance = z.infer<typeof userSuppliedTranscriptProvenanceSchema>;

export function srtTranscriptProvenance(input: { sourceVideoId: string; srtSha256: string; srtByteCount: number;
  language: string }): UserSuppliedTranscriptProvenance {
  const missing = (reason: string) => ({ status: "unavailable" as const, reason });
  return userSuppliedTranscriptProvenanceSchema.parse({ kind: "USER_SUPPLIED_SRT", sourceVideoId: input.sourceVideoId,
    textAndCueTiming: { status: "user-supplied", inputSha256: input.srtSha256 }, srtByteCount: input.srtByteCount,
    parser: "parseSrt-v1", language: input.language, sourceOffsetMs: 0,
    capabilities: {
      wordTimestamps: { status: "derived", algorithmVersion: SRT_WORD_TIMING_ALGORITHM, inputSha256: input.srtSha256 },
      // parseSrt writes confidence 1 for display only. That value is not a measurement.
      wordConfidence: missing("SRT files carry no word confidence"),
      tokenConfidence: missing("SRT files carry no token confidence"),
      speakerLabels: missing("SRT cues carry no speaker labels"),
      audioEvents: missing("No audio was submitted for an uploaded SRT"),
      silences: missing("No audio was measured for an uploaded SRT"),
      sentences: missing("SRT cues are not sentence boundaries"),
      paragraphs: missing("SRT cues are not paragraph boundaries"),
    } });
}
