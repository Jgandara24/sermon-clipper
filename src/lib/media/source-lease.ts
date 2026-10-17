import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { fileIdentity } from "@/lib/storage/file-identity";
import type { StorageDownloadResult, StorageProvider } from "@/lib/storage/types";

const purpose = "P4_DERIVATIVE_BUILD";
const requestSchema = z.object({
  workspaceId: z.string().uuid(), sourceVideoId: z.string().uuid(), ownerId: z.string().uuid(),
  temporaryRoot: z.string().min(1),
}).strict();
export type SourceLeaseRequest = z.infer<typeof requestSchema>;

export type MaterializedSource = {
  sessionId: string;
  sourceVideoId: string;
  sourcePath: string;
  directory: string;
  sha256: string;
  byteCount: number;
  width: number | null;
  height: number | null;
  transcriptRevision: number;
  download: StorageDownloadResult | void;
};

export class SourceMediaBusyError extends Error {
  constructor() { super("Source media has an unfinished session."); }
}

async function admit(prisma: PrismaClient, input: SourceLeaseRequest) {
  return prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM source_videos WHERE id = ${input.sourceVideoId}::uuid
        AND workspace_id = ${input.workspaceId}::uuid FOR UPDATE
    `;
    if (rows.length !== 1) throw new Error("MEDIA_SOURCE_NOT_FOUND");
    const source = await tx.sourceVideo.findUniqueOrThrow({ where: { id: input.sourceVideoId } });
    if (!source.storageKey) throw new Error("MEDIA_SOURCE_NOT_RENDERABLE");
    // New sources have no backfill gate. The source lock serializes gate creation with cleanup.
    await tx.sourceMediaGate.upsert({ where: { sourceId: source.id },
      create: { sourceId: source.id }, update: {} });
    const [gate] = await tx.$queryRaw<{ state: string; generation: bigint }[]>`
      SELECT state, generation FROM source_media_gates WHERE source_id = ${source.id}::uuid FOR UPDATE
    `;
    if (gate.state !== "ACTIVE") throw new Error("MEDIA_SOURCE_NOT_ACTIVE");
    const open = await tx.sourceMediaSession.findFirst({ where: {
      sourceId: source.id, state: { not: "COMPLETE" },
    }, select: { id: true } });
    if (open) throw new SourceMediaBusyError();
    const session = await tx.sourceMediaSession.create({ data: {
      id: randomUUID(), sourceId: source.id, ownerId: input.ownerId, generation: gate.generation, purpose,
    } });
    await tx.cleanupAuditEvent.create({ data: {
      id: randomUUID(), targetType: "session", targetId: session.id, revision: BigInt(0), action: "ACTIVE",
      actorId: input.ownerId, evidence: { reason: "derivative_batch_admitted", workspaceId: input.workspaceId },
    } });
    return { source, session };
  });
}

async function settle(prisma: PrismaClient, input: SourceLeaseRequest, sessionId: string,
  state: "COMPLETE" | "UNCERTAIN", evidence: { callbackStarted: boolean; callbackSucceeded: boolean; temporaryFilesRemoved: boolean }) {
  const settledState = await prisma.$transaction(async tx => {
    const sessions = await tx.$queryRaw<{ revision: bigint; state: string }[]>`
      SELECT revision, state FROM source_media_sessions WHERE id = ${sessionId}::uuid
        AND owner_id = ${input.ownerId}::uuid AND source_id = ${input.sourceVideoId}::uuid FOR UPDATE
    `;
    if (sessions.length !== 1 || sessions[0].state !== "ACTIVE") throw new Error("MEDIA_SESSION_OWNER_OR_STATE_CHANGED");
    const pending = await tx.derivedMediaArtifact.count({ where: {
      publicationSessionId: sessionId, publicationState: "PENDING", deletedAt: null,
    } });
    const actualState = state === "COMPLETE" && pending > 0 ? "UNCERTAIN" : state;
    const settlementEvidence = { ...evidence, pendingPublications: pending };
    const revision = sessions[0].revision + BigInt(1);
    // Keep database timestamp precision and avoid worker clock skew.
    await tx.$executeRaw`
      UPDATE source_media_sessions SET state = ${actualState}, revision = ${revision},
        updated_at = GREATEST(updated_at, clock_timestamp()), terminal_evidence = ${JSON.stringify(settlementEvidence)}::jsonb
      WHERE id = ${sessionId}::uuid
    `;
    await tx.cleanupAuditEvent.create({ data: {
      id: randomUUID(), targetType: "session", targetId: sessionId, revision, action: actualState,
      actorId: input.ownerId, evidence: settlementEvidence,
    } });
    return actualState;
  });
  if (settledState !== state) throw new Error("MEDIA_SESSION_HAS_PENDING_PUBLICATIONS");
}

/**
 * One source acquisition for a whole callback batch. The callback must await every child process
 * and remote write before returning. Rejection leaves UNCERTAIN because this layer cannot prove
 * whether the callback left remote work behind. No timeout or process age transfers ownership.
 */
export async function withMaterializedSource<T>(prisma: PrismaClient, storage: StorageProvider,
  request: SourceLeaseRequest, work: (source: MaterializedSource) => Promise<T>): Promise<T> {
  const input = requestSchema.parse(request);
  const { source, session } = await admit(prisma, input);
  let directory: string | undefined;
  let callbackStarted = false;
  let callbackSucceeded = false;
  let temporaryFilesRemoved = false;
  const failures: unknown[] = [];
  let value!: T;
  try {
    await mkdir(input.temporaryRoot, { recursive: true });
    directory = await mkdtemp(path.join(input.temporaryRoot, "source-batch-"));
    const sourcePath = path.join(directory, "source");
    const identity = await storage.getObjectIdentity?.(source.storageKey!);
    if (!identity) throw new Error("MEDIA_SOURCE_IDENTITY_UNAVAILABLE");
    const download = await storage.downloadToFile(source.storageKey!, sourcePath, identity);
    const actual = await fileIdentity(sourcePath);
    if (actual.byteCount !== identity.byteCount || (identity.sha256 && actual.sha256 !== identity.sha256)) {
      throw new Error("MEDIA_SOURCE_IDENTITY_CHANGED");
    }
    await chmod(sourcePath, 0o400);
    callbackStarted = true;
    value = await work({
      sessionId: session.id, sourceVideoId: source.id, sourcePath, directory,
      ...actual, width: source.width, height: source.height, transcriptRevision: source.transcriptRevision, download,
    });
    callbackSucceeded = true;
  } catch (error) {
    failures.push(error);
  }
  try {
    if (directory) await rm(directory, { recursive: true, force: true });
    temporaryFilesRemoved = true;
  } catch (error) { failures.push(error); }
  const uncertain = !temporaryFilesRemoved || (callbackStarted && !callbackSucceeded);
  try {
    await settle(prisma, input, session.id, uncertain ? "UNCERTAIN" : "COMPLETE",
      { callbackStarted, callbackSucceeded, temporaryFilesRemoved });
  } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Source media work or settlement failed.");
  return value;
}
