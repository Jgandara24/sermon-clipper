import type { Prisma, PrismaClient } from "@prisma/client";
import { artifactIdentityKey, artifactRecordSchema, type ArtifactRecord } from "./types";

/** Call inside a transaction. This shares the source lock used by retention. */
export async function lockMediaSource(tx: Prisma.TransactionClient, workspaceId: string, sourceVideoId: string) {
  const sources = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM source_videos WHERE id = ${sourceVideoId}::uuid
      AND workspace_id = ${workspaceId}::uuid FOR UPDATE
  `;
  if (sources.length !== 1) throw new Error("MEDIA_SOURCE_NOT_FOUND");
  const gates = await tx.$queryRaw<{ state: string }[]>`
    SELECT state FROM source_media_gates WHERE source_id = ${sourceVideoId}::uuid FOR SHARE
  `;
  if (gates.some(gate => gate.state !== "ACTIVE")) throw new Error("MEDIA_SOURCE_NOT_ACTIVE");
  if (await tx.sourceMediaSession.findFirst({ where: { sourceId: sourceVideoId,
    purpose: "P4_ARTIFACT_CLEANUP", state: { not: "COMPLETE" } }, select: { id: true } })) {
    throw new Error("MEDIA_ARTIFACT_CLEANUP_UNFINISHED");
  }
}

/** Registers already-created bytes. The caller must verify those bytes before registration. */
export async function registerMediaArtifact(prisma: PrismaClient, workspaceId: string, input: ArtifactRecord) {
  const record = artifactRecordSchema.parse(input);
  return prisma.$transaction(async tx => {
    await lockMediaSource(tx, workspaceId, record.sourceVideoId);
    return registerMediaArtifactInTransaction(tx, record);
  });
}

/** The caller holds the source lock. Publication reserves ownership before writing storage. */
export async function registerMediaArtifactInTransaction(tx: Prisma.TransactionClient, input: ArtifactRecord,
  publicationSessionId?: string) {
  const record = artifactRecordSchema.parse(input);
  const { sourceInterval, ...facts } = record;
  const identityKey = artifactIdentityKey({
    sourceVideoId: record.sourceVideoId, sourceSha256: record.sourceSha256, kind: record.kind,
    derivationVersion: record.derivationVersion, configurationSha256: record.configurationSha256, sourceInterval,
  });

  const existing = await tx.derivedMediaArtifact.findUnique({ where: { identityKey } });
  if (existing) {
    if (existing.deletedAt) throw new Error("MEDIA_ARTIFACT_ALREADY_DELETED");
    if (existing.storageKey !== record.storageKey || existing.sha256 !== record.sha256 ||
        existing.byteCount !== record.byteCount || existing.retentionClass !== record.retentionClass) {
      throw new Error("MEDIA_ARTIFACT_IDENTITY_CONFLICT");
    }
    // A retry cannot overwrite later mapping, review, or retention decisions.
    return existing;
  }
  return tx.derivedMediaArtifact.create({ data: {
    ...facts, publicationSessionId, identityKey, startMs: BigInt(sourceInterval.startMs), endMs: BigInt(sourceInterval.endMs),
  } });
}
