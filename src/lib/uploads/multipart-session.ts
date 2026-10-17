import { Prisma, type MultipartUpload, type PrismaClient, type SourceVideo } from "@prisma/client";
import { z } from "zod";
import { planForCode } from "@/lib/billing/plans";
import { validateMultipartPlan, type MultipartSession } from "@/lib/storage/multipart";
import type { StorageProvider } from "@/lib/storage/types";

const registrationSchema = z.object({
  id: z.string().uuid(), workspaceId: z.string().uuid(), filename: z.string().trim().min(1).max(255),
  totalBytes: z.number().int().positive().safe(), partBytes: z.number().int().positive().safe(), expiresAt: z.date(),
}).strict();
function canConfirm(row: MultipartUpload, stage: string) {
  return row.state === stage || (row.state === "UNCERTAIN" && row.uncertainStage === stage);
}

type UploadRequest = { id: string; workspaceId: string };

function storageIdentity(storage: StorageProvider) {
  const identity = storage.getStorageIdentity?.();
  if (!identity || !storage.multipart) throw new Error("MULTIPART_STORAGE_UNAVAILABLE");
  return identity;
}
function plan(row: MultipartUpload) {
  return { sessionId: row.id, key: row.storageKey, totalBytes: Number(row.totalBytes), partBytes: Number(row.partBytes) };
}
function session(row: MultipartUpload): MultipartSession {
  if (!row.providerUploadId) throw new Error("MULTIPART_PROVIDER_ID_MISSING");
  return { ...plan(row), uploadId: row.providerUploadId };
}
async function load(prisma: PrismaClient, storage: StorageProvider, request: UploadRequest) {
  const row = await prisma.multipartUpload.findFirst({ where: { id: request.id, workspaceId: request.workspaceId } });
  if (!row) throw new Error("MULTIPART_UPLOAD_NOT_FOUND");
  if (row.storageIdentity !== storageIdentity(storage)) throw new Error("MULTIPART_STORAGE_CHANGED");
  return row;
}
function assertLive(row: MultipartUpload) {
  if (row.expiresAt.getTime() <= Date.now()) throw new Error("MULTIPART_UPLOAD_EXPIRED");
}
async function claim(prisma: PrismaClient, row: MultipartUpload, state: string, requireLive: boolean) {
  const changed = await prisma.multipartUpload.updateMany({ where: {
    id: row.id, workspaceId: row.workspaceId, state: row.state,
    ...(requireLive ? { expiresAt: { gt: new Date() } } : {}),
  }, data: { state } });
  if (changed.count !== 1) throw new Error("MULTIPART_UPLOAD_STATE_CHANGED");
}
async function uncertain(prisma: PrismaClient, row: MultipartUpload, stage: string, cause: unknown): Promise<never> {
  try {
    await prisma.multipartUpload.updateMany({ where: { id: row.id, state: stage },
      data: { state: "UNCERTAIN", uncertainStage: stage } });
  } catch (recordError) {
    // A retained claimed state also forbids automatic retry. Never reset a claim by elapsed time alone.
    throw new AggregateError([cause, recordError], "MULTIPART_UPLOAD_UNCERTAIN");
  }
  throw new Error("MULTIPART_UPLOAD_UNCERTAIN", { cause });
}

/** Authentication and rate limiting belong to the HTTP caller. This service enforces persisted workspace and plan limits. */
export async function registerMultipartUpload(prisma: PrismaClient, storage: StorageProvider,
  input: z.infer<typeof registrationSchema>) {
  const request = registrationSchema.parse(input);
  const identity = storageIdentity(storage);
  const key = `src/${request.workspaceId}/multipart-${request.id}`;
  validateMultipartPlan({ key, sessionId: request.id, totalBytes: request.totalBytes, partBytes: request.partBytes });
  if (request.expiresAt.getTime() <= Date.now()) throw new Error("MULTIPART_UPLOAD_EXPIRED");
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: request.workspaceId }, select: { planCode: true } });
  if (request.totalBytes > planForCode(workspace.planCode).maxUploadBytes) throw new Error("MULTIPART_PLAN_LIMIT_EXCEEDED");
  await prisma.multipartUpload.createMany({ data: { ...request, totalBytes: BigInt(request.totalBytes),
    partBytes: BigInt(request.partBytes), storageIdentity: identity, storageKey: key }, skipDuplicates: true });
  const row = await load(prisma, storage, request);
  if (row.storageKey !== key || row.filename !== request.filename || row.totalBytes !== BigInt(request.totalBytes) ||
      row.partBytes !== BigInt(request.partBytes) || row.expiresAt.getTime() !== request.expiresAt.getTime()) {
    throw new Error("MULTIPART_UPLOAD_IDENTITY_CONFLICT");
  }
  return row;
}

export async function initiateMultipartUpload(prisma: PrismaClient, storage: StorageProvider, request: UploadRequest): Promise<MultipartUpload> {
  const row = await load(prisma, storage, request);
  if (row.state === "STARTING" || (row.state === "UNCERTAIN" && row.uncertainStage === "STARTING")) {
    return recoverMultipartInitiation(prisma, storage, request);
  }
  assertLive(row);
  if (row.state === "UPLOADING") return row;
  if (row.state !== "NEW") throw new Error("MULTIPART_UPLOAD_NOT_STARTABLE");
  await claim(prisma, row, "STARTING", true);
  try {
    const result = await storage.multipart!.create(plan(row));
    await prisma.multipartUpload.updateMany({ where: { id: row.id, state: "STARTING" },
      data: { state: "UPLOADING", providerUploadId: result.uploadId } });
    const current = await load(prisma, storage, request);
    if (current.providerUploadId !== result.uploadId) throw new Error("MULTIPART_PROVIDER_ID_CONFLICT");
    return current;
  } catch (error) { return uncertain(prisma, row, "STARTING", error); }
}

export async function signMultipartUploadPart(prisma: PrismaClient, storage: StorageProvider,
  request: UploadRequest & { partNumber: number; expiresInSeconds: number }) {
  const row = await load(prisma, storage, request);
  assertLive(row);
  if (row.state !== "UPLOADING") throw new Error("MULTIPART_UPLOAD_NOT_WRITABLE");
  if (!Number.isInteger(request.expiresInSeconds) || request.expiresInSeconds < 1 || request.expiresInSeconds > 3600) {
    throw new Error("MULTIPART_INVALID_URL_EXPIRY");
  }
  const ttl = Math.min(request.expiresInSeconds, Math.floor((row.expiresAt.getTime() - Date.now()) / 1000));
  if (ttl < 1) throw new Error("MULTIPART_UPLOAD_EXPIRED");
  return storage.multipart!.signPart(session(row), request.partNumber, ttl);
}

/** Returns only planned part locations and sizes. Provider identities stay on the server. */
export async function listMultipartUploadParts(prisma: PrismaClient, storage: StorageProvider, request: UploadRequest) {
  const row = await load(prisma, storage, request);
  assertLive(row);
  if (row.state !== "UPLOADING") throw new Error("MULTIPART_UPLOAD_NOT_WRITABLE");
  const parts = await storage.multipart!.listParts(session(row));
  return { parts: parts.map(part => ({ partNumber: part.partNumber, byteCount: part.byteCount })) };
}

export async function completeMultipartUpload(prisma: PrismaClient, storage: StorageProvider, request: UploadRequest): Promise<SourceVideo> {
  const row = await load(prisma, storage, request);
  if (row.state === "COMPLETED") {
    const source = await prisma.sourceVideo.findFirst({ where: { id: row.sourceVideoId!, workspaceId: row.workspaceId } });
    if (!source) throw new Error("MULTIPART_COMPLETED_SOURCE_REMOVED");
    return source;
  }
  if (row.state === "COMPLETING" || (row.state === "UNCERTAIN" && row.uncertainStage === "COMPLETING")) {
    return recoverMultipartCompletion(prisma, storage, request);
  }
  assertLive(row);
  if (row.state !== "UPLOADING") throw new Error("MULTIPART_UPLOAD_NOT_COMPLETABLE");
  const parts = await storage.multipart!.listParts(session(row));
  if (parts.length !== validateMultipartPlan(plan(row)) || parts.some((part, index) => part.partNumber !== index + 1)) {
    throw new Error("MULTIPART_INCOMPLETE");
  }
  await claim(prisma, row, "COMPLETING", true);
  try {
    const result = await storage.multipart!.complete(session(row));
    if (!result.etag || result.byteCount !== Number(row.totalBytes)) throw new Error("MULTIPART_COMPLETION_MISMATCH");
    return await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM multipart_uploads WHERE id=${row.id}::uuid FOR UPDATE`;
      const current = await tx.multipartUpload.findUniqueOrThrow({ where: { id: row.id } });
      if (current.state === "COMPLETED") {
        if (current.completedEtag !== result.etag) throw new Error("MULTIPART_COMPLETED_OBJECT_MISMATCH");
        const source = await tx.sourceVideo.findFirst({ where: { id: current.sourceVideoId!, workspaceId: row.workspaceId } });
        if (!source) throw new Error("MULTIPART_COMPLETED_SOURCE_REMOVED");
        return source;
      }
      if (current.state !== "COMPLETING") throw new Error("MULTIPART_UPLOAD_STATE_CHANGED");
      const source = await tx.sourceVideo.create({ data: { workspaceId: row.workspaceId, origin: "UPLOAD",
        filename: row.filename, sizeBytes: row.totalBytes, storageKey: row.storageKey, language: "en" } });
      await tx.multipartUpload.update({ where: { id: row.id }, data: {
        state: "COMPLETED", sourceVideoId: source.id, completedEtag: result.etag,
      } });
      return source;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  } catch (error) { return uncertain(prisma, row, "COMPLETING", error); }
}

/** Also serves expired sessions. Never races an active completion or an uncertain provider operation. */
export async function abortMultipartUpload(prisma: PrismaClient, storage: StorageProvider, request: UploadRequest): Promise<void> {
  const row = await load(prisma, storage, request);
  if (row.state === "ABORTED") return;
  if (row.state === "ABORTING" || (row.state === "UNCERTAIN" && row.uncertainStage === "ABORTING")) {
    return recoverMultipartCancellation(prisma, storage, request);
  }
  if (row.state === "NEW") { await claim(prisma, row, "ABORTED", false); return; }
  if (row.state !== "UPLOADING") throw new Error("MULTIPART_UPLOAD_NOT_ABORTABLE");
  await claim(prisma, row, "ABORTING", false);
  try {
    await storage.multipart!.abort(session(row));
    await prisma.multipartUpload.updateMany({ where: { id: row.id, state: "ABORTING" }, data: { state: "ABORTED" } });
    if ((await load(prisma, storage, request)).state !== "ABORTED") throw new Error("MULTIPART_UPLOAD_STATE_CHANGED");
  } catch (error) { return uncertain(prisma, row, "ABORTING", error); }
}


/** Read-only provider recovery. Confirms observed completion without repeating a provider operation or resetting a claim. */
export async function recoverMultipartCompletion(prisma: PrismaClient, storage: StorageProvider, request: UploadRequest): Promise<SourceVideo> {
  const row = await load(prisma, storage, request);
  if (row.state === "COMPLETED") return completeMultipartUpload(prisma, storage, request);
  if (!canConfirm(row, "COMPLETING")) {
    throw new Error("MULTIPART_COMPLETION_NOT_RECOVERABLE");
  }
  const inspected = await storage.multipart!.inspectCompleted(plan(row));
  if (!inspected) throw new Error("MULTIPART_COMPLETION_NOT_CONFIRMED");
  if (!inspected.etag || inspected.byteCount !== Number(row.totalBytes)) throw new Error("MULTIPART_COMPLETED_OBJECT_MISMATCH");
  const observedAt = new Date().toISOString();
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM multipart_uploads WHERE id=${row.id}::uuid AND workspace_id=${row.workspaceId}::uuid FOR UPDATE`;
    const current = await tx.multipartUpload.findUniqueOrThrow({ where: { id: row.id } });
    if (current.state === "COMPLETED") {
      const source = await tx.sourceVideo.findFirst({ where: { id: current.sourceVideoId!, workspaceId: current.workspaceId } });
      if (!source) throw new Error("MULTIPART_COMPLETED_SOURCE_REMOVED");
      return source;
    }
    if (!canConfirm(current, "COMPLETING")) {
      throw new Error("MULTIPART_UPLOAD_STATE_CHANGED");
    }
    const source = await tx.sourceVideo.create({ data: { workspaceId: row.workspaceId, origin: "UPLOAD",
      filename: row.filename, sizeBytes: row.totalBytes, storageKey: row.storageKey, language: "en" } });
    await tx.multipartUpload.update({ where: { id: row.id }, data: {
      state: "COMPLETED", uncertainStage: null, sourceVideoId: source.id, completedEtag: inspected.etag,
      recoveryEvidence: { version: "multipart-completion-recovery-v1", observedAt, sessionId: row.id,
        storageIdentity: row.storageIdentity, storageKey: row.storageKey, byteCount: row.totalBytes.toString(),
        etag: inspected.etag, providerMutation: false },
    } });
    return source;
  });
}


/** Adopts one existing provider upload at the immutable exclusive key. Never sends another create request. */
export async function recoverMultipartInitiation(prisma: PrismaClient, storage: StorageProvider, request: UploadRequest): Promise<MultipartUpload> {
  const row = await load(prisma, storage, request);
  if (row.state === "UPLOADING") return row;
  if (!canConfirm(row, "STARTING") || row.providerUploadId) {
    throw new Error("MULTIPART_INITIATION_NOT_RECOVERABLE");
  }
  const found = await storage.multipart!.findInitiated(plan(row));
  if (!found) throw new Error("MULTIPART_INITIATION_NOT_CONFIRMED");
  if (!found.uploadId || found.uploadId.length > 2048) throw new Error("MULTIPART_INITIATION_AMBIGUOUS");
  const observedAt = new Date().toISOString();
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM multipart_uploads WHERE id=${row.id}::uuid AND workspace_id=${row.workspaceId}::uuid FOR UPDATE`;
    const current = await tx.multipartUpload.findUniqueOrThrow({ where: { id: row.id } });
    if (current.state === "UPLOADING") return current;
    if (!canConfirm(current, "STARTING") || current.providerUploadId) {
      throw new Error("MULTIPART_UPLOAD_STATE_CHANGED");
    }
    return tx.multipartUpload.update({ where: { id: row.id }, data: {
      state: "UPLOADING", uncertainStage: null, providerUploadId: found.uploadId,
      initiationRecoveryEvidence: { version: "multipart-initiation-recovery-v1", observedAt, sessionId: row.id,
        storageIdentity: row.storageIdentity, storageKey: row.storageKey, uploadId: found.uploadId,
        completedObjectAbsent: true, exactKeyMatches: 1, providerMutation: false },
    } });
  });
}


/** Confirms a previous cancellation using reads only. It never repeats remote cancellation or deletes an object. */
export async function recoverMultipartCancellation(prisma: PrismaClient, storage: StorageProvider, request: UploadRequest): Promise<void> {
  const row = await load(prisma, storage, request);
  if (row.state === "ABORTED") return;
  if (!canConfirm(row, "ABORTING")) {
    throw new Error("MULTIPART_CANCELLATION_NOT_RECOVERABLE");
  }
  if (!await storage.multipart!.inspectAborted(session(row))) throw new Error("MULTIPART_CANCELLATION_NOT_CONFIRMED");
  const observedAt = new Date().toISOString();
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM multipart_uploads WHERE id=${row.id}::uuid AND workspace_id=${row.workspaceId}::uuid FOR UPDATE`;
    const current = await tx.multipartUpload.findUniqueOrThrow({ where: { id: row.id } });
    if (current.state === "ABORTED") return;
    if (!canConfirm(current, "ABORTING")) throw new Error("MULTIPART_UPLOAD_STATE_CHANGED");
    await tx.multipartUpload.update({ where: { id: row.id }, data: {
      state: "ABORTED", uncertainStage: null,
      cancellationRecoveryEvidence: { version: "multipart-cancellation-recovery-v1", observedAt, sessionId: row.id,
        storageIdentity: row.storageIdentity, storageKey: row.storageKey, uploadId: row.providerUploadId,
        uploadAbsent: true, completedObjectAbsent: true, providerMutation: false },
    } });
  });
}
