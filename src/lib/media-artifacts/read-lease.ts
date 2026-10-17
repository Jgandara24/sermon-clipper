import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { DerivedMediaArtifact, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { sha256Schema, sourceIntervalSchema } from "./types";
import { fileIdentity } from "@/lib/storage/file-identity";
import type { StorageDownloadResult, StorageProvider } from "@/lib/storage/types";

const requestSchema = z.object({ workspaceId: z.string().uuid(), sourceVideoId: z.string().uuid(),
  artifactId: z.string().uuid(), sourceSha256: sha256Schema, ownerId: z.string().uuid(),
  exportJobId: z.string().uuid().optional(), sourceRange: sourceIntervalSchema, temporaryRoot: z.string().min(1) }).strict();
export type RangeReadRequest = z.infer<typeof requestSchema>;
const publicationSchema = z.object({ version: z.literal("artifact-publication-v1"), storageIdentity: sha256Schema,
  sha256: sha256Schema, byteCount: z.string().regex(/^[1-9]\d*$/), objectIdentity: z.object({
    token: z.string().min(1), byteCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sha256: z.string().optional(), etag: z.string().optional(), versionId: z.string().optional(),
  }) });
export type MaterializedRange = { artifact: DerivedMediaArtifact; path: string; directory: string; sessionId: string;
  sourceWidth: number; sourceHeight: number; retentionHeldByExportJobId?: string; download: StorageDownloadResult | void };

/** Pins an approved range against source/artifact cleanup without acquiring the original.
 * The callback must await all work. Failures after callback admission leave an uncertain session.
 */
export async function withMaterializedRange<T>(prisma: PrismaClient, storage: StorageProvider,
  requestInput: RangeReadRequest, work: (input: MaterializedRange) => Promise<T>): Promise<T> {
  const request = requestSchema.parse(requestInput);
  if (!path.isAbsolute(request.temporaryRoot)) throw new Error("RANGE_READ_ABSOLUTE_ROOT_REQUIRED");
  if (!storage.getObjectIdentity || !storage.getStorageIdentity) throw new Error("RANGE_READ_STORAGE_UNSUPPORTED");
  const storageIdentity = sha256Schema.parse(storage.getStorageIdentity());
  const admitted = await prisma.$transaction(async tx => {
    const sources = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM source_videos
      WHERE id = ${request.sourceVideoId}::uuid AND workspace_id = ${request.workspaceId}::uuid FOR UPDATE`;
    if (sources.length !== 1) throw new Error("MEDIA_SOURCE_NOT_FOUND");
    const source = await tx.sourceVideo.findUniqueOrThrow({ where: { id: request.sourceVideoId } });
    if (!source.width || !source.height) throw new Error("RANGE_ORIGINAL_DIMENSIONS_REQUIRED");
    const [gate] = await tx.$queryRaw<{ state: string; generation: bigint }[]>`SELECT state, generation FROM source_media_gates
      WHERE source_id = ${source.id}::uuid FOR SHARE`;
    if (!gate || gate.state !== "ACTIVE") throw new Error("MEDIA_SOURCE_NOT_ACTIVE");
    if (await tx.sourceMediaSession.findFirst({ where: { sourceId: source.id, state: { not: "COMPLETE" } } })) {
      throw new Error("MEDIA_SOURCE_SESSION_UNFINISHED");
    }
    let exportPin: Awaited<ReturnType<typeof tx.exportRangeInput.findUnique>> = null;
    if (request.exportJobId) {
      await tx.$queryRaw`SELECT id FROM export_jobs WHERE id=${request.exportJobId}::uuid FOR SHARE`;
      const job = await tx.exportJob.findUnique({ where: { id: request.exportJobId } });
      exportPin = await tx.exportRangeInput.findUnique({ where: { exportJobId: request.exportJobId } });
      if (!job || !exportPin || job.state !== "RUNNING" || job.workspaceId !== request.workspaceId ||
        job.editVersion !== exportPin.editVersion || exportPin.sourceVideoId !== request.sourceVideoId ||
        exportPin.artifactId !== request.artifactId || exportPin.sourceSha256 !== request.sourceSha256 ||
        exportPin.startMs !== BigInt(request.sourceRange.startMs) || exportPin.endMs !== BigInt(request.sourceRange.endMs)) {
        throw new Error("RANGE_READ_EXPORT_PIN_CHANGED");
      }
    }
    await tx.$queryRaw`SELECT id FROM derived_media_artifacts WHERE id = ${request.artifactId}::uuid FOR SHARE`;
    const artifact = await tx.derivedMediaArtifact.findUnique({ where: { id: request.artifactId } });
    const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    if (!artifact || artifact.sourceVideoId !== source.id || artifact.sourceSha256 !== request.sourceSha256 ||
      artifact.kind !== "CANDIDATE_RANGE" || artifact.retentionClass !== "RENDER_SOURCE" || artifact.deletedAt ||
      artifact.publicationState !== "READY" || artifact.mappingStatus !== "VERIFIED" || !artifact.mappingEvidenceSha256 ||
      artifact.visualQuality !== "ACCEPTED" || (!exportPin && artifact.expiresAt && artifact.expiresAt <= now) ||
      artifact.startMs > BigInt(request.sourceRange.startMs) || artifact.endMs < BigInt(request.sourceRange.endMs)) {
      throw new Error("RANGE_READ_NOT_APPROVED_OR_COVERED");
    }
    const review = await tx.mediaArtifactReview.findFirst({ where: { artifactId: artifact.id }, orderBy: { revision: "desc" } });
    if (!review || review.decision !== "ACCEPTED" || review.sourceSha256 !== artifact.sourceSha256 ||
      review.artifactSha256 !== artifact.sha256 || review.mappingEvidenceSha256 !== artifact.mappingEvidenceSha256) {
      throw new Error("RANGE_READ_REVIEW_EVIDENCE_REQUIRED");
    }
    if (exportPin && (exportPin.reviewId !== review.id || exportPin.artifactSha256 !== artifact.sha256 ||
      exportPin.mappingEvidenceSha256 !== artifact.mappingEvidenceSha256)) throw new Error("RANGE_READ_EXPORT_PIN_CHANGED");
    const publication = publicationSchema.parse(artifact.publicationEvidence);
    if (publication.storageIdentity !== storageIdentity || publication.sha256 !== artifact.sha256 ||
      BigInt(publication.byteCount) !== artifact.byteCount || BigInt(publication.objectIdentity.byteCount) !== artifact.byteCount) {
      throw new Error("RANGE_READ_PUBLICATION_MISMATCH");
    }
    if (!new RegExp(`^sources/${source.id}/artifacts/${artifact.identityKey}\\.[a-z0-9]+$`).test(artifact.storageKey)) {
      throw new Error("RANGE_READ_KEY_OUTSIDE_NAMESPACE");
    }
    const session = await tx.sourceMediaSession.create({ data: { id: randomUUID(), sourceId: source.id,
      ownerId: request.ownerId, generation: gate.generation, purpose: "P4_RANGE_RENDER" } });
    await tx.cleanupAuditEvent.create({ data: { id: randomUUID(), targetType: "session", targetId: session.id,
      revision: BigInt(0), action: "ACTIVE", actorId: request.ownerId, evidence: { purpose: "P4_RANGE_RENDER",
        workspaceId: request.workspaceId, artifactId: artifact.id, reviewId: review.id, reviewRevision: review.revision, sha256: artifact.sha256,
        byteCount: artifact.byteCount.toString(), sourceRange: request.sourceRange, exportJobId: request.exportJobId ?? null } } });
    return { artifact, publication, session, sourceWidth: source.width, sourceHeight: source.height };
  });
  let directory: string | undefined;
  let callbackStarted = false, callbackSucceeded = false, temporaryFilesRemoved = false;
  let value!: T;
  const failures: unknown[] = [];
  try {
    await mkdir(request.temporaryRoot, { recursive: true });
    directory = await mkdtemp(path.join(request.temporaryRoot, "range-read-"));
    const file = path.join(directory, "range.nut");
    if (storage.getStorageIdentity() !== storageIdentity) throw new Error("RANGE_READ_STORAGE_CHANGED");
    const current = await storage.getObjectIdentity(admitted.artifact.storageKey);
    const expected = admitted.publication.objectIdentity;
    if (!current || current.token !== expected.token || current.byteCount !== expected.byteCount) throw new Error("RANGE_READ_OBJECT_CHANGED");
    const download = await storage.downloadToFile(admitted.artifact.storageKey, file, expected);
    const actual = await fileIdentity(file);
    if (actual.sha256 !== admitted.artifact.sha256 || BigInt(actual.byteCount) !== admitted.artifact.byteCount) throw new Error("RANGE_READ_BYTES_CHANGED");
    await chmod(file, 0o400);
    callbackStarted = true;
    value = await work({ artifact: admitted.artifact, path: file, directory, sessionId: admitted.session.id,
      sourceWidth: admitted.sourceWidth, sourceHeight: admitted.sourceHeight, retentionHeldByExportJobId: request.exportJobId, download });
    callbackSucceeded = true;
  } catch (error) { failures.push(error); }
  try {
    if (directory) await rm(directory, { recursive: true, force: true });
    temporaryFilesRemoved = true;
  } catch (error) { failures.push(error); }
  try {
    await prisma.$transaction(async tx => {
      const [session] = await tx.$queryRaw<{ state: string; revision: bigint }[]>`SELECT state, revision FROM source_media_sessions
        WHERE id = ${admitted.session.id}::uuid AND owner_id = ${request.ownerId}::uuid AND source_id = ${request.sourceVideoId}::uuid FOR UPDATE`;
      if (!session || session.state !== "ACTIVE") throw new Error("RANGE_READ_OWNER_OR_STATE_CHANGED");
      const state = temporaryFilesRemoved && (!callbackStarted || callbackSucceeded) ? "COMPLETE" : "UNCERTAIN";
      const revision = session.revision + BigInt(1);
      const evidence = { artifactId: admitted.artifact.id, callbackStarted, callbackSucceeded, temporaryFilesRemoved };
      await tx.$executeRaw`UPDATE source_media_sessions SET state = ${state}, revision = ${revision},
        updated_at = GREATEST(updated_at, clock_timestamp()), terminal_evidence = ${JSON.stringify(evidence)}::jsonb
        WHERE id = ${admitted.session.id}::uuid`;
      await tx.cleanupAuditEvent.create({ data: { id: randomUUID(), targetType: "session", targetId: admitted.session.id,
        revision, action: state, actorId: request.ownerId, evidence } });
    });
  } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Range read or settlement failed.");
  return value;
}
