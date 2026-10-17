import { createHash } from "node:crypto";
import { z } from "zod";

const timeMs = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.string().trim().min(1);

/** Source presentation time, with a half-open interval [startMs, endMs). */
export const sourceIntervalSchema = z.object({
  startMs: timeMs,
  endMs: timeMs,
}).strict().refine(value => value.endMs > value.startMs, {
  message: "The source interval must have positive duration.",
});

export const artifactKindSchema = z.enum([
  "ANALYSIS_AUDIO", "SOURCE_PROXY", "SPARSE_FRAME", "TIMELINE_VIEW",
  "BOUNDARY_STRIP", "SERMON_AUDIO", "CANDIDATE_RANGE", "WAVEFORM", "LOCAL_EVIDENCE",
]);

/** Identity includes input bytes and configuration, not just the storage key. */
export const artifactIdentitySchema = z.object({
  sourceVideoId: z.string().uuid(),
  sourceSha256: sha256Schema,
  kind: artifactKindSchema,
  derivationVersion: version,
  configurationSha256: sha256Schema,
  sourceInterval: sourceIntervalSchema,
}).strict();

export type ArtifactIdentity = z.infer<typeof artifactIdentitySchema>;

export function artifactIdentityKey(input: ArtifactIdentity): string {
  const value = artifactIdentitySchema.parse(input);
  // Fixed positions avoid object-property ordering and delimiter collisions.
  return createHash("sha256").update(JSON.stringify([
    "media-artifact-v1", value.sourceVideoId, value.sourceSha256, value.kind,
    value.derivationVersion, value.configurationSha256,
    value.sourceInterval.startMs, value.sourceInterval.endMs,
  ])).digest("hex");
}

/** A declaration is not proof of content mapping or visual quality. */
export const artifactRecordSchema = artifactIdentitySchema.extend({
  storageKey: z.string().min(1),
  sha256: sha256Schema,
  byteCount: z.bigint().positive(),
  retentionClass: z.enum(["ANALYSIS", "PREVIEW", "RENDER_SOURCE"]),
  expiresAt: z.date().nullable(),
  mappingStatus: z.enum(["DECLARED", "VERIFIED", "FAILED"]),
  mappingEvidenceSha256: sha256Schema.nullable(),
  visualQuality: z.enum(["NOT_REVIEWED", "ACCEPTED", "REJECTED", "NOT_APPLICABLE"]),
}).strict().superRefine((value, ctx) => {
  if (value.mappingStatus === "VERIFIED" && !value.mappingEvidenceSha256) {
    ctx.addIssue({ code: "custom", path: ["mappingEvidenceSha256"],
      message: "Verified mapping needs evidence." });
  }
  if (value.kind === "CANDIDATE_RANGE" && value.retentionClass !== "RENDER_SOURCE") {
    ctx.addIssue({ code: "custom", path: ["retentionClass"],
      message: "Candidate ranges must retain render sources." });
  }
  if (value.kind === "CANDIDATE_RANGE" && value.visualQuality === "NOT_APPLICABLE") {
    ctx.addIssue({ code: "custom", path: ["visualQuality"],
      message: "Candidate ranges need visual quality review." });
  }
});

export type ArtifactRecord = z.infer<typeof artifactRecordSchema>;

export const sourceTimeMappingSchema = z.object({
  sourceInterval: sourceIntervalSchema,
  artifactOriginMs: timeMs,
  timeScale: z.literal("1:1"),
}).strict().refine(value => Number.isSafeInteger(
  value.artifactOriginMs + (value.sourceInterval.endMs - value.sourceInterval.startMs),
), { message: "The artifact interval exceeds safe timestamp precision." });

export type SourceTimeMapping = z.infer<typeof sourceTimeMappingSchema>;

/** Converts interval boundaries too, so the exclusive end is accepted. */
export function artifactTimeToSource(input: SourceTimeMapping, artifactTimeMs: number): number {
  const mapping = sourceTimeMappingSchema.parse(input);
  const timestamp = timeMs.parse(artifactTimeMs);
  const relative = timestamp - mapping.artifactOriginMs;
  const duration = mapping.sourceInterval.endMs - mapping.sourceInterval.startMs;
  if (relative < 0 || relative > duration) throw new RangeError("Timestamp is outside the artifact interval.");
  return mapping.sourceInterval.startMs + relative;
}

export function sourceTimeToArtifact(input: SourceTimeMapping, sourceTimeMs: number): number {
  const mapping = sourceTimeMappingSchema.parse(input);
  const timestamp = timeMs.parse(sourceTimeMs);
  if (timestamp < mapping.sourceInterval.startMs || timestamp > mapping.sourceInterval.endMs) {
    throw new RangeError("Timestamp is outside the source interval.");
  }
  return mapping.artifactOriginMs + (timestamp - mapping.sourceInterval.startMs);
}
