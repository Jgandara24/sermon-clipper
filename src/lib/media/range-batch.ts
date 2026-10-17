import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { artifactIdentityKey, sourceTimeMappingSchema, type ArtifactRecord } from "@/lib/media-artifacts/types";
import { publishMediaArtifact } from "@/lib/media-artifacts/publication";
import { fileIdentity } from "@/lib/storage/file-identity";
import type { StorageProvider } from "@/lib/storage/types";
import { candidateRangeRequestSchema, planCandidateRanges } from "./candidate-ranges";
import { normalizeTimeMs, type ExactTimeMs } from "./exact-time";
import { discoverSourceKeyframes, keyframeSettingsSchema } from "./keyframes";
import { extractCandidateRange, rangeExtractionSettingsSchema } from "./range-extraction";
import { withMaterializedSource, type SourceLeaseRequest } from "./source-lease";

import { rangeEvidenceSha256 } from "./range-evidence";

const batchSchema = candidateRangeRequestSchema.omit({ sourceSha256: true, keyframeTimesMs: true }).extend({
  sourceOriginMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  keyframes: keyframeSettingsSchema, extraction: rangeExtractionSettingsSchema,
  expiresAt: z.date().nullable(),
}).strict();
export type CandidateRangeBatchSettings = z.infer<typeof batchSchema>;
const digest = rangeEvidenceSha256;
function integerBoundary(value: ExactTimeMs, rounding: "floor" | "ceil") {
  const exact = normalizeTimeMs(value);
  if (typeof exact === "number") return exact;
  const n = BigInt(exact.numerator), d = BigInt(exact.denominator);
  return Number((n + (rounding === "ceil" ? d - BigInt(1) : BigInt(0))) / d);
}

/** Register only the integer interval contained within verified media, never an outward coverage claim. */
export function containedRangeMapping(interval: { startMs: ExactTimeMs; endMs: ExactTimeMs }, originMs: number) {
  return sourceTimeMappingSchema.parse({ sourceInterval: {
    startMs: integerBoundary(interval.startMs, "ceil"), endMs: integerBoundary(interval.endMs, "floor"),
  }, artifactOriginMs: integerBoundary(interval.startMs, "ceil") + originMs, timeScale: "1:1" });
}

/** One materialization, sequential extraction/publication, and a persisted coverage manifest.
 * Callers supply retained candidates and measured settings. No production worker invokes this batch yet.
 */
export async function runCandidateRangeBatch(prisma: PrismaClient, storage: StorageProvider,
  request: SourceLeaseRequest, settingsInput: CandidateRangeBatchSettings) {
  const settings = batchSchema.parse(settingsInput);
  if (!storage.uploadFileIfAbsent || !storage.getObjectIdentity || !storage.getStorageIdentity) throw new Error("MEDIA_PUBLICATION_STORAGE_UNSUPPORTED");
  return withMaterializedSource(prisma, storage, request, async source => {
    if (!source.width || !source.height) throw new Error("RANGE_ORIGINAL_DIMENSIONS_REQUIRED");
    const input = { path: source.sourcePath, sha256: source.sha256, byteCount: source.byteCount,
      sourceDurationMs: settings.sourceDurationMs, sourceOriginMs: settings.sourceOriginMs };
    const keyframes = await discoverSourceKeyframes(input, settings.keyframes);
    const plan = planCandidateRanges({ sourceSha256: source.sha256, sourceDurationMs: settings.sourceDurationMs,
      candidates: settings.candidates, handles: settings.handles, keyframeTimesMs: keyframes.keyframeTimesMs });
    const owner = { workspaceId: request.workspaceId, ownerId: request.ownerId, sessionId: source.sessionId };
    const ranges = [];
    for (const [rangeIndex, planned] of plan.ranges.entries()) {
      const built = await extractCandidateRange({ ...input, width: source.width, height: source.height },
        planned.sourceInterval, source.directory, settings.extraction);
      const mapping = containedRangeMapping(planned.sourceInterval, settings.sourceOriginMs);
      for (const coverage of plan.coverage.filter(item => item.rangeIndex === rangeIndex)) {
        if (coverage.requestedInterval.startMs < mapping.sourceInterval.startMs || coverage.requestedInterval.endMs > mapping.sourceInterval.endMs) {
          throw new Error("RANGE_REGISTERED_COVERAGE_INCOMPLETE");
        }
      }
      const mappingEvidence = { version: "contained-range-mapping-v2", mapping, extractionEvidenceSha256: built.evidenceSha256 };
      const identity = { sourceVideoId: source.sourceVideoId, sourceSha256: source.sha256, kind: "CANDIDATE_RANGE" as const,
        sourceInterval: mapping.sourceInterval, derivationVersion: built.evidence.version,
        configurationSha256: digest({ exactInterval: built.evidence.sourceInterval, originMs: settings.sourceOriginMs,
          mode: settings.extraction.mode, threads: settings.extraction.threads, toolchainSha256: built.evidence.toolchainSha256 }) };
      const record: ArtifactRecord = { ...identity,
        storageKey: `sources/${source.sourceVideoId}/artifacts/${artifactIdentityKey(identity)}.nut`,
        sha256: built.sha256, byteCount: BigInt(built.byteCount), retentionClass: "RENDER_SOURCE", expiresAt: settings.expiresAt,
        mappingStatus: "VERIFIED", mappingEvidenceSha256: digest(mappingEvidence), visualQuality: "NOT_REVIEWED" };
      const published = await publishMediaArtifact(prisma, storage, owner, record, built.path, "application/octet-stream",
        { extraction: built.evidence, mappingEvidence });
      ranges.push({ ...published, rangeIndex, candidateIds: planned.candidateIds, mapping });
    }
    // Candidate membership belongs to a plan manifest, not an immutable reusable range record.
    const manifestDocument = { version: "candidate-range-manifest-v1", sourceVideoId: source.sourceVideoId,
      keyframeEvidenceSha256: keyframes.evidenceSha256, plan,
      ranges: ranges.map(range => ({ rangeIndex: range.rangeIndex, artifactId: range.artifact.id,
        sha256: range.artifact.sha256, mappingEvidenceSha256: range.artifact.mappingEvidenceSha256,
        candidateIds: range.candidateIds, mapping: range.mapping })) };
    const manifestPath = path.join(source.directory, "candidate-range-manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifestDocument), { flag: "wx" });
    const bytes = await fileIdentity(manifestPath);
    const identity = { sourceVideoId: source.sourceVideoId, sourceSha256: source.sha256, kind: "LOCAL_EVIDENCE" as const,
      sourceInterval: { startMs: 0, endMs: settings.sourceDurationMs }, derivationVersion: manifestDocument.version,
      configurationSha256: digest(manifestDocument) };
    const record: ArtifactRecord = { ...identity,
      storageKey: `sources/${source.sourceVideoId}/artifacts/${artifactIdentityKey(identity)}.json`,
      sha256: bytes.sha256, byteCount: BigInt(bytes.byteCount), retentionClass: "RENDER_SOURCE", expiresAt: settings.expiresAt,
      mappingStatus: "DECLARED", mappingEvidenceSha256: null, visualQuality: "NOT_APPLICABLE" };
    const manifest = await publishMediaArtifact(prisma, storage, owner, record, manifestPath, "application/json",
      { version: manifestDocument.version, planSha256: plan.planSha256, rangeCount: ranges.length });
    return { sourceVideoId: source.sourceVideoId, sourceSha256: source.sha256, sessionId: source.sessionId,
      sourceDownload: source.download, plan, ranges, manifest };
  });
}
