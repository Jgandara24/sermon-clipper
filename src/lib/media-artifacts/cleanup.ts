import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { sha256Schema } from "./types";
import type { StorageProvider } from "@/lib/storage/types";

const purpose = "P4_ARTIFACT_CLEANUP";
const requestSchema = z.object({ workspaceId: z.string().uuid(), sourceVideoId: z.string().uuid(),
  ownerId: z.string().uuid(), maxArtifacts: z.number().int().min(1).max(200) }).strict();
export type ArtifactCleanupRequest = z.infer<typeof requestSchema>;

async function lockSource(tx: Prisma.TransactionClient, request: ArtifactCleanupRequest) {
  const sources = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM source_videos WHERE id = ${request.sourceVideoId}::uuid
      AND workspace_id = ${request.workspaceId}::uuid FOR UPDATE
  `;
  if (sources.length !== 1) throw new Error("MEDIA_SOURCE_NOT_FOUND");
  const [gate] = await tx.$queryRaw<{ state: string; generation: bigint }[]>`
    SELECT state, generation FROM source_media_gates WHERE source_id = ${request.sourceVideoId}::uuid FOR SHARE
  `;
  if (!gate || gate.state !== "ACTIVE") throw new Error("MEDIA_SOURCE_NOT_ACTIVE");
  return gate;
}
async function sourceEvidenceHeld(tx: Prisma.TransactionClient, sourceId: string, now: Date) {
  if (await tx.visualBoundaryEscalation.findFirst({ where: { sourceVideoId: sourceId,
    state: { in: ["STARTED", "UNCERTAIN"] } }, select: { id: true } })) return true;
  return (await tx.project.count({ where: { sourceVideoId: sourceId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } })) > 0;
}
async function settle(prisma: PrismaClient, request: ArtifactCleanupRequest, sessionId: string,
  state: "COMPLETE" | "UNCERTAIN", deletedIds: string[]) {
  await prisma.$transaction(async tx => {
    const [session] = await tx.$queryRaw<{ revision: bigint; state: string }[]>`
      SELECT revision, state FROM source_media_sessions WHERE id = ${sessionId}::uuid
        AND owner_id = ${request.ownerId}::uuid AND source_id = ${request.sourceVideoId}::uuid FOR UPDATE
    `;
    if (!session || session.state !== "ACTIVE") throw new Error("MEDIA_CLEANUP_OWNER_OR_STATE_CHANGED");
    const revision = session.revision + BigInt(1);
    const evidence = { purpose, deletedArtifactIds: deletedIds, storageWorkSettled: state === "COMPLETE" };
    await tx.$executeRaw`UPDATE source_media_sessions SET state = ${state}, revision = ${revision},
      updated_at = GREATEST(updated_at, clock_timestamp()), terminal_evidence = ${JSON.stringify(evidence)}::jsonb
      WHERE id = ${sessionId}::uuid`;
    await tx.cleanupAuditEvent.create({ data: { id: randomUUID(), targetType: "session", targetId: sessionId,
      revision, action: state, actorId: request.ownerId, evidence } });
  });
}

/** Deletes expired READY artifacts only after all source projects expire and all writers settle.
 * The initial session audit durably records every possible deletion before storage work starts.
 * Keys must belong to the immutable artifact namespace. External writers must not bypass that protocol.
 * A failure leaves UNCERTAIN; this function does not reclaim ownership or retry uncertain deletion.
 */
export async function cleanupExpiredMediaArtifacts(prisma: PrismaClient, storage: StorageProvider, input: ArtifactCleanupRequest) {
  const request = requestSchema.parse(input);
  if (!storage.getObjectIdentity) throw new Error("MEDIA_CLEANUP_IDENTITY_UNSUPPORTED");
  const storageIdentity = sha256Schema.parse(storage.getStorageIdentity?.());
  const admission = await prisma.$transaction(async tx => {
    const gate = await lockSource(tx, request);
    if (await tx.sourceMediaSession.findFirst({ where: { sourceId: request.sourceVideoId, state: { not: "COMPLETE" } } })) {
      throw new Error("MEDIA_SOURCE_SESSION_UNFINISHED");
    }
    const now = new Date();
    if (await sourceEvidenceHeld(tx, request.sourceVideoId, now)) return null;
    const artifacts = await tx.derivedMediaArtifact.findMany({ where: { sourceVideoId: request.sourceVideoId,
      deletedAt: null, publicationState: "READY", expiresAt: { lte: now },
      sermonSubmissions: { none: { state: { in: ["STARTED", "UNCERTAIN"] } } },
      exportInputs: { none: { exportJob: { state: { in: ["QUEUED", "RUNNING", "WAITING", "RETRYING"] } } } } }, take: request.maxArtifacts,
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }] });
    if (!artifacts.length) return null;
    for (const artifact of artifacts) {
      if (z.object({ storageIdentity: sha256Schema }).parse(artifact.publicationEvidence).storageIdentity !== storageIdentity) {
        throw new Error("MEDIA_CLEANUP_STORAGE_LOCATION_CHANGED");
      }
      if (!new RegExp(`^sources/${request.sourceVideoId}/artifacts/${artifact.identityKey}\\.[a-z0-9]+$`).test(artifact.storageKey)) {
        throw new Error("MEDIA_CLEANUP_KEY_OUTSIDE_ARTIFACT_NAMESPACE");
      }
    }
    const session = await tx.sourceMediaSession.create({ data: { id: randomUUID(), sourceId: request.sourceVideoId,
      ownerId: request.ownerId, generation: gate.generation, purpose } });
    await tx.cleanupAuditEvent.create({ data: { id: randomUUID(), targetType: "session", targetId: session.id,
      revision: BigInt(0), action: "ACTIVE", actorId: request.ownerId, evidence: {
        purpose, workspaceId: request.workspaceId, artifacts: artifacts.map(artifact => ({ id: artifact.id,
          storageKey: artifact.storageKey, sha256: artifact.sha256, byteCount: artifact.byteCount.toString(),
          expiresAt: artifact.expiresAt!.toISOString(), publicationEvidence: artifact.publicationEvidence })),
      } } });
    return { session, artifacts };
  });
  if (!admission) return { sessionId: null, deletedArtifactIds: [] as string[] };
  const deletedIds: string[] = [];
  let failure: unknown;
  let failed = false;
  try {
    for (const planned of admission.artifacts) {
      const removed = await prisma.$transaction(async tx => {
        const gate = await lockSource(tx, request);
        const [session] = await tx.$queryRaw<{ state: string; generation: bigint; owner_id: string }[]>`
          SELECT state, generation, owner_id FROM source_media_sessions WHERE id = ${admission.session.id}::uuid FOR UPDATE
        `;
        if (!session || session.state !== "ACTIVE" || session.owner_id !== request.ownerId || session.generation !== gate.generation) {
          throw new Error("MEDIA_CLEANUP_OWNER_OR_STATE_CHANGED");
        }
        const now = new Date();
        if (await sourceEvidenceHeld(tx, request.sourceVideoId, now)) return false;
        await tx.$queryRaw`SELECT id FROM derived_media_artifacts WHERE id = ${planned.id}::uuid FOR UPDATE`;
        const artifact = await tx.derivedMediaArtifact.findUniqueOrThrow({ where: { id: planned.id } });
        if (artifact.deletedAt || !artifact.expiresAt || artifact.expiresAt > now) return false;
        if (artifact.publicationState !== "READY") throw new Error("MEDIA_CLEANUP_ARTIFACT_NOT_READY");
        // Serialize retry/cancel transitions with the final deletion decision.
        await tx.$queryRaw`SELECT j.id FROM export_jobs j JOIN export_range_inputs i ON i.export_job_id=j.id
          WHERE i.artifact_id=${artifact.id}::uuid ORDER BY j.id FOR UPDATE OF j`;
        if (await tx.sermonTranscriptionSubmission.findFirst({ where: { artifactId: artifact.id,
          state: { in: ["STARTED", "UNCERTAIN"] } } })) throw new Error("MEDIA_ARTIFACT_TRANSCRIPTION_PENDING");
        if (await tx.exportRangeInput.findFirst({ where: { artifactId: artifact.id,
          exportJob: { state: { in: ["QUEUED", "RUNNING", "WAITING", "RETRYING"] } } } })) return false;
        const expected = z.object({ objectIdentity: z.object({ token: z.string().min(1),
          byteCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }) }).parse(artifact.publicationEvidence).objectIdentity;
        if (storage.getStorageIdentity?.() !== storageIdentity) throw new Error("MEDIA_CLEANUP_STORAGE_LOCATION_CHANGED");
        const existed = await storage.exists(artifact.storageKey);
        if (existed) {
          const actual = await storage.getObjectIdentity!(artifact.storageKey);
          if (!actual || actual.token !== expected.token || actual.byteCount !== expected.byteCount ||
              BigInt(actual.byteCount) !== artifact.byteCount) throw new Error("MEDIA_CLEANUP_OBJECT_CHANGED");
          await storage.remove(artifact.storageKey);
        }
        if (await storage.exists(artifact.storageKey)) throw new Error("MEDIA_CLEANUP_ABSENCE_UNCONFIRMED");
        await tx.derivedMediaArtifact.update({ where: { id: artifact.id }, data: {
          deletedAt: new Date(), deletionEvidence: { version: "artifact-cleanup-v1", cleanupSessionId: admission.session.id,
            storageIdentity, storageKey: artifact.storageKey, sha256: artifact.sha256, byteCount: artifact.byteCount.toString(),
            observedPublishedIdentity: expected, absentBeforeDelete: !existed, absenceVerifiedAt: new Date().toISOString() },
        } });
        return true;
      }, { timeout: 30000 });
      if (removed) deletedIds.push(planned.id);
    }
  } catch (error) { failure = error; failed = true; }
  try { await settle(prisma, request, admission.session.id, failed ? "UNCERTAIN" : "COMPLETE", deletedIds); }
  catch (error) {
    if (failed) throw new AggregateError([failure, error], "Artifact cleanup and settlement failed.");
    throw error;
  }
  if (failed) throw failure;
  return { sessionId: admission.session.id, deletedArtifactIds: deletedIds };
}
