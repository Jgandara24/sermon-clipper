import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { fileIdentity } from "@/lib/storage/file-identity";
import type { StorageProvider } from "@/lib/storage/types";
import { sha256Schema, artifactRecordSchema, type ArtifactRecord } from "./types";
import { lockMediaSource, registerMediaArtifactInTransaction } from "./persistence";

const storedIdentitySchema = z.object({
  token: z.string().min(1), byteCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().optional(), etag: z.string().optional(), versionId: z.string().optional(),
});

const ownerSchema = z.object({
  workspaceId: z.string().uuid(), sessionId: z.string().uuid(), ownerId: z.string().uuid(),
}).strict();
export type PublicationOwner = z.infer<typeof ownerSchema>;

async function lockOwner(tx: Prisma.TransactionClient, sourceId: string, owner: PublicationOwner) {
  await lockMediaSource(tx, owner.workspaceId, sourceId);
  const sessions = await tx.$queryRaw<{ id: string }[]>`
    SELECT s.id FROM source_media_sessions s
    JOIN source_media_gates g ON g.source_id = s.source_id AND g.generation = s.generation
    WHERE s.id = ${owner.sessionId}::uuid AND s.source_id = ${sourceId}::uuid
      AND s.owner_id = ${owner.ownerId}::uuid AND s.state = 'ACTIVE'
      AND s.purpose = 'P4_DERIVATIVE_BUILD' AND g.state = 'ACTIVE'
    FOR UPDATE OF s
  `;
  if (sessions.length !== 1) throw new Error("MEDIA_PUBLICATION_OWNER_OR_STATE_CHANGED");
}

/** Call within the source lease callback and await completion before releasing the lease.
 * PENDING owns the storage key before upload. Failure preserves this record for recovery.
 * READY proves stored bytes only; source-time mapping and visual quality remain separate.
 */
export async function publishMediaArtifact(prisma: PrismaClient, storage: StorageProvider,
  ownerInput: PublicationOwner, input: ArtifactRecord, sourcePath: string, contentType?: string, derivationEvidence?: Prisma.InputJsonObject) {
  const owner = ownerSchema.parse(ownerInput);
  const record = artifactRecordSchema.parse(input);
  if (!storage.uploadFileIfAbsent || !storage.getObjectIdentity) throw new Error("MEDIA_PUBLICATION_STORAGE_UNSUPPORTED");
  const storageIdentity = sha256Schema.parse(storage.getStorageIdentity?.());
  const local = await fileIdentity(sourcePath);
  if (local.sha256 !== record.sha256 || BigInt(local.byteCount) !== record.byteCount) {
    throw new Error("MEDIA_PUBLICATION_LOCAL_BYTES_MISMATCH");
  }
  const reserved = await prisma.$transaction(async tx => {
    await lockOwner(tx, record.sourceVideoId, owner);
    const artifact = await registerMediaArtifactInTransaction(tx, record, owner.sessionId);
    if (artifact.publicationState !== "READY" && artifact.publicationSessionId !== owner.sessionId) throw new Error("MEDIA_PUBLICATION_SESSION_CONFLICT");
    return artifact;
  });
  const reuse = reserved.publicationState === "READY";
  if (reuse && z.object({ storageIdentity: sha256Schema }).parse(reserved.publicationEvidence).storageIdentity !== storageIdentity) {
    throw new Error("MEDIA_PUBLICATION_STORAGE_LOCATION_CHANGED");
  }
  if (!reuse) await storage.uploadFileIfAbsent(record.storageKey, sourcePath, contentType);
  const currentIdentity = await storage.getObjectIdentity(record.storageKey);
  if (!currentIdentity || BigInt(currentIdentity.byteCount) !== record.byteCount) throw new Error("MEDIA_PUBLICATION_STORED_SIZE_MISMATCH");
  const identity = reuse ? z.object({ objectIdentity: storedIdentitySchema }).parse(reserved.publicationEvidence).objectIdentity
    : currentIdentity;
  if (identity.token !== currentIdentity.token || identity.byteCount !== currentIdentity.byteCount) {
    throw new Error("MEDIA_PUBLICATION_STORED_IDENTITY_CHANGED");
  }
  const directory = await mkdtemp(path.join(path.dirname(sourcePath), "publication-check-"));
  let download;
  try {
    const verificationPath = path.join(directory, "stored");
    download = await storage.downloadToFile(record.storageKey, verificationPath, identity);
    const actual = await fileIdentity(verificationPath);
    if (actual.sha256 !== record.sha256 || BigInt(actual.byteCount) !== record.byteCount) {
      throw new Error("MEDIA_PUBLICATION_STORED_BYTES_MISMATCH");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  // No database lock spans the network transfer. Recheck ownership before publishing readiness.
  const artifact = await prisma.$transaction(async tx => {
    await lockOwner(tx, record.sourceVideoId, owner);
    const current = await tx.derivedMediaArtifact.findUniqueOrThrow({ where: { id: reserved.id } });
    if (reuse) {
      if (current.deletedAt || current.publicationState !== "READY") throw new Error("MEDIA_PUBLICATION_STATE_CHANGED");
      return current;
    }
    if (current.deletedAt || current.publicationState !== "PENDING" || current.publicationSessionId !== owner.sessionId) {
      throw new Error("MEDIA_PUBLICATION_STATE_CHANGED");
    }
    return tx.derivedMediaArtifact.update({ where: { id: reserved.id }, data: {
      publicationState: "READY",
      publicationEvidence: {
        version: "artifact-publication-v1", storageIdentity, sha256: record.sha256, byteCount: record.byteCount.toString(),
        objectIdentity: { ...identity }, verifiedAt: new Date().toISOString(),
        ...(derivationEvidence ? { derivation: derivationEvidence } : {}),
      },
    } });
  });
  return { artifact, download };
}
