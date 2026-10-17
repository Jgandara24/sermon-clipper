import type { DerivedMediaArtifact } from "@prisma/client";
import { z } from "zod";
import { fileIdentity } from "@/lib/storage/file-identity";
import { sha256Schema, sourceIntervalSchema, sourceTimeMappingSchema, sourceTimeToArtifact } from "@/lib/media-artifacts/types";
import { rangeEvidenceSha256 } from "@/lib/media/range-evidence";
import { containedRangeMapping } from "@/lib/media/range-batch";
import { exactTimeMsSchema } from "@/lib/media/exact-time";
import { renderClipExport, type RenderClipExportParams } from "@/lib/export/render";

export type RenderRangeArtifact = Pick<DerivedMediaArtifact, "id" | "sourceVideoId" | "sourceSha256" | "kind" |
  "sha256" | "byteCount" | "startMs" | "endMs" | "mappingStatus" | "mappingEvidenceSha256" | "visualQuality" |
  "retentionClass" | "publicationState" | "publicationEvidence" | "deletedAt" | "expiresAt">;
const derivationSchema = z.object({
  extraction: z.object({ version: z.literal("verified-candidate-range-v3"), sourceSha256: sha256Schema,
    sourceOriginMs: z.number().int().nonnegative(), width: z.number().int().positive(), height: z.number().int().positive(),
    sourceInterval: z.object({ startMs: exactTimeMsSchema, endMs: exactTimeMsSchema }),
    outputSha256: sha256Schema, outputByteCount: z.number().int().positive() }).passthrough(),
  mappingEvidence: z.object({ version: z.literal("contained-range-mapping-v2"), mapping: sourceTimeMappingSchema,
    extractionEvidenceSha256: sha256Schema }).strict(),
});

/** Caller must authorize and pin this artifact against cleanup before materializing it.
 * This local renderer does not select artifacts, acquire a database lease, or fall back to the original.
 */
export async function renderCandidateRangeExport(params: {
  artifact: RenderRangeArtifact; sourceVideoId: string; sourceSha256: string;
  sourceWidth: number; sourceHeight: number; now: Date;
  /** Only pass a hold returned by withMaterializedRange after validating a RUNNING export pin. */
  retentionHeldByExportJobId?: string;
  render: Omit<RenderClipExportParams, "absoluteInputTimestamps">;
}) {
  const { artifact, render } = params;
  if (params.retentionHeldByExportJobId) z.string().uuid().parse(params.retentionHeldByExportJobId);
  if (artifact.sourceVideoId !== params.sourceVideoId || artifact.sourceSha256 !== params.sourceSha256 ||
      artifact.kind !== "CANDIDATE_RANGE" || artifact.retentionClass !== "RENDER_SOURCE" ||
      artifact.publicationState !== "READY" || artifact.deletedAt || artifact.mappingStatus !== "VERIFIED" ||
      artifact.visualQuality !== "ACCEPTED" || !Number.isFinite(params.now.getTime()) ||
      (!params.retentionHeldByExportJobId && artifact.expiresAt && artifact.expiresAt <= params.now)) throw new Error("EXPORT_RANGE_NOT_APPROVED_OR_AVAILABLE");
  const publication = z.object({ version: z.literal("artifact-publication-v1"), sha256: sha256Schema,
    byteCount: z.string().regex(/^[1-9]\d*$/), derivation: derivationSchema }).parse(artifact.publicationEvidence);
  const { extraction, mappingEvidence } = publication.derivation;
  if (rangeEvidenceSha256(extraction) !== mappingEvidence.extractionEvidenceSha256 ||
      rangeEvidenceSha256(mappingEvidence) !== artifact.mappingEvidenceSha256 ||
      publication.sha256 !== artifact.sha256 || BigInt(publication.byteCount) !== artifact.byteCount ||
      extraction.outputSha256 !== artifact.sha256 || BigInt(extraction.outputByteCount) !== artifact.byteCount ||
      extraction.sourceSha256 !== params.sourceSha256 || extraction.width !== params.sourceWidth || extraction.height !== params.sourceHeight) {
    throw new Error("EXPORT_RANGE_EVIDENCE_MISMATCH");
  }
  const expectedMapping = containedRangeMapping(extraction.sourceInterval, extraction.sourceOriginMs);
  const mapping = mappingEvidence.mapping;
  if (rangeEvidenceSha256(mapping) !== rangeEvidenceSha256(expectedMapping) ||
      BigInt(mapping.sourceInterval.startMs) !== artifact.startMs || BigInt(mapping.sourceInterval.endMs) !== artifact.endMs) {
    throw new Error("EXPORT_RANGE_MAPPING_MISMATCH");
  }
  const range = sourceIntervalSchema.parse(render.range);
  const mappedRange = { startMs: sourceTimeToArtifact(mapping, range.startMs), endMs: sourceTimeToArtifact(mapping, range.endMs) };
  const actual = await fileIdentity(render.sourceFilePath);
  if (actual.sha256 !== artifact.sha256 || BigInt(actual.byteCount) !== artifact.byteCount) throw new Error("EXPORT_RANGE_FILE_CHANGED");
  await renderClipExport({ ...render, range: mappedRange, absoluteInputTimestamps: true });
  return { artifactId: artifact.id, sha256: artifact.sha256, sourceRange: range, artifactRange: mappedRange };
}

/** Cleanup-safe local range render. Export-job selection and accounting remain the caller's responsibility. */
export async function renderPinnedRangeExport(prisma: import("@prisma/client").PrismaClient,
  storage: import("@/lib/storage/types").StorageProvider,
  request: import("@/lib/media-artifacts/read-lease").RangeReadRequest,
  render: Omit<RenderClipExportParams, "sourceFilePath" | "absoluteInputTimestamps">) {
  if (render.range.startMs !== request.sourceRange.startMs || render.range.endMs !== request.sourceRange.endMs) {
    throw new Error("EXPORT_RANGE_REQUEST_CHANGED");
  }
  const { withMaterializedRange } = await import("@/lib/media-artifacts/read-lease");
  return withMaterializedRange(prisma, storage, request, async materialized => {
    const evidence = await renderCandidateRangeExport({ artifact: materialized.artifact,
      sourceVideoId: request.sourceVideoId, sourceSha256: request.sourceSha256,
      sourceWidth: materialized.sourceWidth, sourceHeight: materialized.sourceHeight, now: new Date(),
      retentionHeldByExportJobId: materialized.retentionHeldByExportJobId,
      render: { ...render, sourceFilePath: materialized.path } });
    return { ...evidence, sessionId: materialized.sessionId, download: materialized.download };
  });
}
