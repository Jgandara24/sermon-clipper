import { reconcileMultipartUploads } from "@/lib/uploads/multipart-recovery";
import { purgeExpiredMultipartUploads } from "@/lib/uploads/multipart-cleanup";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { LocalDiskStorageProvider } from "@/lib/storage/local-disk-provider";
import {
  registerMultipartUpload, initiateMultipartUpload, signMultipartUploadPart,
  listMultipartUploadParts, completeMultipartUpload, abortMultipartUpload, recoverMultipartCompletion, recoverMultipartInitiation, recoverMultipartCancellation,
} from "@/lib/uploads/multipart-session";
import type { MultipartSession, MultipartStorage } from "@/lib/storage/multipart";

const prisma = new PrismaClient();
const second = new PrismaClient();
afterAll(async () => { await Promise.all([prisma.$disconnect(), second.$disconnect()]); });
// Immutable audit rows remain until the disposable cluster is removed. Never use a production database.
describe.skipIf(process.env.P4_LEASE_TEST_DATABASE !== "1")("durable multipart upload", () => {
  async function fixture() {
    const user = await prisma.user.create({ data: { email: `multipart-${randomUUID()}@example.test`, authProvider: "DEV" } });
    const workspace = await prisma.workspace.create({ data: { name: "Multipart fixture", ownerId: user.id } });
    const multipart = {
      inspectAborted: vi.fn<MultipartStorage["inspectAborted"]>(async () => false),
      findInitiated: vi.fn<MultipartStorage["findInitiated"]>(async () => null),
      inspectCompleted: vi.fn<MultipartStorage["inspectCompleted"]>(async () => null),
      create: vi.fn(async () => ({ uploadId: "fixture-provider-id" })),
      signPart: vi.fn(async (_session: MultipartSession, _number: number, ttl: number) => `fixture:${ttl}`),
      listParts: vi.fn(async () => [{ partNumber: 1, byteCount: 3, etag: "part" }]),
      complete: vi.fn(async () => ({ byteCount: 3, etag: "complete" })),
      abort: vi.fn(async () => {}),
    } satisfies MultipartStorage;
    const storage = Object.assign(new LocalDiskStorageProvider(`/unused-multipart-fixture/${randomUUID()}`), { multipart });
    const input = { id: randomUUID(), workspaceId: workspace.id, filename: "service.mp4", totalBytes: 3,
      partBytes: 5 * 1024 * 1024, expiresAt: new Date(Date.now() + 60_000) };
    return { input, storage, multipart, workspace };
  }
  it("registers concurrent identical plans once and rejects changes", async () => {
    const f = await fixture();
    const rows = await Promise.all([registerMultipartUpload(prisma, f.storage, f.input), registerMultipartUpload(second, f.storage, f.input)]);
    expect(rows[0].id).toBe(rows[1].id);
    expect(rows[0]).toMatchObject({ state: "NEW", totalBytes: BigInt(3), storageKey: `src/${f.workspace.id}/multipart-${f.input.id}` });
    await expect(registerMultipartUpload(prisma, f.storage, { ...f.input, totalBytes: 4 })).rejects.toThrow("IDENTITY_CONFLICT");
    expect(f.multipart.create).not.toHaveBeenCalled();
    await expect(prisma.multipartUpload.update({ where: { id: f.input.id }, data: { totalBytes: 4 } })).rejects.toThrow("IDENTITY_IMMUTABLE");
    await expect(prisma.multipartUpload.delete({ where: { id: f.input.id } })).rejects.toThrow("AUDIT_REQUIRED");
  });
  it("initiates once across concurrent callers and reuses the persisted provider ID", async () => {
    const f = await fixture();
    await registerMultipartUpload(prisma, f.storage, f.input);
    const results = await Promise.allSettled([initiateMultipartUpload(prisma, f.storage, f.input), initiateMultipartUpload(second, f.storage, f.input)]);
    expect(results.filter(result => result.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    expect(f.multipart.create).toHaveBeenCalledTimes(1);
    expect(await initiateMultipartUpload(prisma, f.storage, f.input)).toMatchObject({ state: "UPLOADING", providerUploadId: "fixture-provider-id" });
    expect(f.multipart.create).toHaveBeenCalledTimes(1);
    await signMultipartUploadPart(prisma, f.storage, { ...f.input, partNumber: 1, expiresInSeconds: 3600 });
    expect(f.multipart.signPart.mock.calls[0][2]).toBeLessThanOrEqual(60);
  });
  it("refuses another workspace and changed storage before provider work", async () => {
    const f = await fixture();
    await registerMultipartUpload(prisma, f.storage, f.input);
    await expect(initiateMultipartUpload(prisma, f.storage, { ...f.input, workspaceId: randomUUID() })).rejects.toThrow("NOT_FOUND");
    const changed = Object.assign(new LocalDiskStorageProvider("/different-fixture"), { multipart: f.multipart });
    await expect(initiateMultipartUpload(prisma, changed, f.input)).rejects.toThrow("STORAGE_CHANGED");
    expect(f.multipart.create).not.toHaveBeenCalled();
  });
  it("keeps uncertain initiation and refuses automatic retry", async () => {
    const f = await fixture();
    await registerMultipartUpload(prisma, f.storage, f.input);
    f.multipart.create.mockRejectedValue(new Error("lost create response"));
    await expect(initiateMultipartUpload(prisma, f.storage, f.input)).rejects.toThrow("UNCERTAIN");
    expect(await prisma.multipartUpload.findUnique({ where: { id: f.input.id } })).toMatchObject({ state: "UNCERTAIN", uncertainStage: "STARTING" });
    await expect(initiateMultipartUpload(prisma, f.storage, f.input)).rejects.toThrow("INITIATION_NOT_CONFIRMED");
    await expect(abortMultipartUpload(prisma, f.storage, f.input)).rejects.toThrow("NOT_ABORTABLE");
    expect(f.multipart.create).toHaveBeenCalledTimes(1);
  });
  it("adopts one lost initiation across callers and preserves its evidence through completion", async () => {
    const f = await fixture();
    await registerMultipartUpload(prisma, f.storage, f.input);
    f.multipart.create.mockRejectedValueOnce(new Error("lost create response"));
    await expect(initiateMultipartUpload(prisma, f.storage, f.input)).rejects.toThrow("UNCERTAIN");
    f.multipart.findInitiated.mockResolvedValue({ uploadId: "recovered-provider-id" });
    const rows = await Promise.all([initiateMultipartUpload(prisma, f.storage, f.input), recoverMultipartInitiation(second, f.storage, f.input)]);
    for (const row of rows) expect(row).toMatchObject({ state: "UPLOADING", providerUploadId: "recovered-provider-id",
      initiationRecoveryEvidence: expect.objectContaining({ exactKeyMatches: 1, providerMutation: false, uploadId: "recovered-provider-id" }) });
    expect(f.multipart.create).toHaveBeenCalledTimes(1);
    await expect(prisma.multipartUpload.update({ where: { id: f.input.id }, data: {
      state: "ABORTING", initiationRecoveryEvidence: {},
    } })).rejects.toThrow();
    await completeMultipartUpload(prisma, f.storage, f.input);
    expect(await prisma.multipartUpload.findUnique({ where: { id: f.input.id } })).toMatchObject({ state: "COMPLETED",
      providerUploadId: "recovered-provider-id", initiationRecoveryEvidence: rows[0].initiationRecoveryEvidence });
  });

  it("recovers an expired initiation for cleanup without allowing new part signatures", async () => {
    const f = await fixture();
    await registerMultipartUpload(prisma, f.storage, f.input);
    f.multipart.create.mockRejectedValueOnce(new Error("lost response"));
    await expect(initiateMultipartUpload(prisma, f.storage, f.input)).rejects.toThrow("UNCERTAIN");
    f.multipart.findInitiated.mockResolvedValue({ uploadId: "expired-provider-id" });
    const clock = vi.spyOn(Date, "now").mockReturnValue(f.input.expiresAt.getTime() + 1);
    try {
      await recoverMultipartInitiation(prisma, f.storage, f.input);
      await expect(signMultipartUploadPart(prisma, f.storage, { ...f.input, partNumber: 1, expiresInSeconds: 60 })).rejects.toThrow("EXPIRED");
      await purgeExpiredMultipartUploads(prisma, f.storage, { now: new Date(f.input.expiresAt.getTime() + 1) });
      expect(await prisma.multipartUpload.findUnique({ where: { id: f.input.id } })).toMatchObject({ state: "ABORTED" });
      expect(f.multipart.create).toHaveBeenCalledTimes(1);
      expect(f.multipart.abort).toHaveBeenCalledTimes(1);
    } finally { clock.mockRestore(); }
  });

  it.each(["absent", "ambiguous", "active", "workspace"])("preserves an unconfirmed initiation (%s)", async mode => {
    const f = await fixture();
    await registerMultipartUpload(prisma, f.storage, f.input);
    if (mode === "active") await prisma.multipartUpload.update({ where: { id: f.input.id }, data: { state: "STARTING" } });
    else {
      f.multipart.create.mockRejectedValueOnce(new Error("lost response"));
      await expect(initiateMultipartUpload(prisma, f.storage, f.input)).rejects.toThrow("UNCERTAIN");
    }
    if (mode === "ambiguous") f.multipart.findInitiated.mockRejectedValue(new Error("MULTIPART_INITIATION_AMBIGUOUS"));
    await expect(recoverMultipartInitiation(prisma, f.storage,
      mode === "workspace" ? { ...f.input, workspaceId: randomUUID() } : f.input)).rejects.toThrow();
    expect(await prisma.multipartUpload.findUnique({ where: { id: f.input.id } })).toMatchObject({
      state: mode === "active" ? "STARTING" : "UNCERTAIN", providerUploadId: null, initiationRecoveryEvidence: null });
    if (mode === "workspace") expect(f.multipart.findInitiated).not.toHaveBeenCalled();
  });

  it("lists stored part sizes only for a live owned upload", async () => {
    const f = await fixture();
    await registerMultipartUpload(prisma, f.storage, f.input);
    await expect(listMultipartUploadParts(prisma, f.storage, f.input)).rejects.toThrow("NOT_WRITABLE");
    await initiateMultipartUpload(prisma, f.storage, f.input);
    expect(await listMultipartUploadParts(prisma, f.storage, f.input)).toEqual({ parts: [{ partNumber: 1, byteCount: 3 }] });
    await expect(listMultipartUploadParts(prisma, f.storage, { ...f.input, workspaceId: randomUUID() })).rejects.toThrow("NOT_FOUND");
    const clock = vi.spyOn(Date, "now").mockReturnValue(f.input.expiresAt.getTime() + 1);
    try { await expect(listMultipartUploadParts(prisma, f.storage, f.input)).rejects.toThrow("EXPIRED"); }
    finally { clock.mockRestore(); }
    expect(f.multipart.listParts).toHaveBeenCalledTimes(1);
    expect(f.multipart.complete).not.toHaveBeenCalled();
  });

  it("completes once and returns the same source after a repeated request", async () => {
    const f = await fixture();
    await registerMultipartUpload(prisma, f.storage, f.input);
    await initiateMultipartUpload(prisma, f.storage, f.input);
    const outcomes = await Promise.allSettled([completeMultipartUpload(prisma, f.storage, f.input), completeMultipartUpload(second, f.storage, f.input)]);
    expect(outcomes.some(result => result.status === "fulfilled")).toBe(true);
    expect(f.multipart.complete).toHaveBeenCalledTimes(1);
    const source = await completeMultipartUpload(prisma, f.storage, f.input);
    expect(source).toMatchObject({ workspaceId: f.workspace.id, filename: "service.mp4", sizeBytes: BigInt(3) });
    expect(await prisma.sourceVideo.count({ where: { workspaceId: f.workspace.id } })).toBe(1);
    expect(await prisma.multipartUpload.findUnique({ where: { id: f.input.id } })).toMatchObject({ state: "COMPLETED", sourceVideoId: source.id, completedEtag: "complete" });
    await expect(abortMultipartUpload(prisma, f.storage, f.input)).rejects.toThrow("NOT_ABORTABLE");
    await prisma.sourceVideo.delete({ where: { id: source.id } });
    await expect(completeMultipartUpload(prisma, f.storage, f.input)).rejects.toThrow("SOURCE_REMOVED");
  });
  it("keeps an incomplete upload writable without a completion claim", async () => {
    const f = await fixture();
    await registerMultipartUpload(prisma, f.storage, f.input);
    await initiateMultipartUpload(prisma, f.storage, f.input);
    f.multipart.listParts.mockResolvedValue([]);
    await expect(completeMultipartUpload(prisma, f.storage, f.input)).rejects.toThrow("INCOMPLETE");
    expect(await prisma.multipartUpload.findUnique({ where: { id: f.input.id } })).toMatchObject({ state: "UPLOADING" });
    expect(f.multipart.complete).not.toHaveBeenCalled();
  });
  it("preserves uncertainty when source registration fails after remote completion", async () => {
    const f = await fixture();
    await registerMultipartUpload(prisma, f.storage, f.input);
    await initiateMultipartUpload(prisma, f.storage, f.input);
    const broken = prisma.$extends({ query: { sourceVideo: { async create() { throw new Error("injected database failure"); } } } }) as unknown as PrismaClient;
    await expect(completeMultipartUpload(broken, f.storage, f.input)).rejects.toThrow("UNCERTAIN");
    expect(await prisma.sourceVideo.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    expect(await prisma.multipartUpload.findUnique({ where: { id: f.input.id } })).toMatchObject({ state: "UNCERTAIN", uncertainStage: "COMPLETING" });
    await expect(completeMultipartUpload(prisma, f.storage, f.input)).rejects.toThrow("COMPLETION_NOT_CONFIRMED");
    expect(f.multipart.complete).toHaveBeenCalledTimes(1);
    expect(f.multipart.abort).not.toHaveBeenCalled();
  });
  it("recovers confirmed completion once across callers after the session expires", async () => {
    const f = await fixture();
    await registerMultipartUpload(prisma, f.storage, f.input);
    await initiateMultipartUpload(prisma, f.storage, f.input);
    f.multipart.complete.mockRejectedValueOnce(new Error("lost completion response"));
    await expect(completeMultipartUpload(prisma, f.storage, f.input)).rejects.toThrow("UNCERTAIN");
    f.multipart.inspectCompleted.mockResolvedValue({ etag: "recovered-object", byteCount: 3 });
    const clock = vi.spyOn(Date, "now").mockReturnValue(f.input.expiresAt.getTime() + 1);
    try {
      const sources = await Promise.all([completeMultipartUpload(prisma, f.storage, f.input),
        recoverMultipartCompletion(second, f.storage, f.input)]);
      expect(sources[0].id).toBe(sources[1].id);
      expect(await prisma.sourceVideo.count({ where: { workspaceId: f.workspace.id } })).toBe(1);
      const row = await prisma.multipartUpload.findUniqueOrThrow({ where: { id: f.input.id } });
      expect(row).toMatchObject({ state: "COMPLETED", uncertainStage: null, completedEtag: "recovered-object",
        recoveryEvidence: expect.objectContaining({ version: "multipart-completion-recovery-v1", etag: "recovered-object",
          sessionId: f.input.id, byteCount: "3", providerMutation: false }) });
      await expect(prisma.multipartUpload.update({ where: { id: row.id }, data: { recoveryEvidence: {} } })).rejects.toThrow();
      expect((await completeMultipartUpload(prisma, f.storage, f.input)).id).toBe(sources[0].id);
      expect(f.multipart.complete).toHaveBeenCalledTimes(1);
      expect(f.multipart.abort).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it("rolls back recovered source creation and retains uncertainty after a database failure", async () => {
    const f = await fixture();
    await registerMultipartUpload(prisma, f.storage, f.input);
    await initiateMultipartUpload(prisma, f.storage, f.input);
    f.multipart.complete.mockRejectedValueOnce(new Error("lost completion response"));
    await expect(completeMultipartUpload(prisma, f.storage, f.input)).rejects.toThrow("UNCERTAIN");
    f.multipart.inspectCompleted.mockResolvedValue({ etag: "recovered", byteCount: 3 });
    const broken = prisma.$extends({ query: { multipartUpload: { async update() { throw new Error("injected recovery failure"); } } } }) as unknown as PrismaClient;
    await expect(recoverMultipartCompletion(broken, f.storage, f.input)).rejects.toThrow("injected recovery failure");
    expect(await prisma.sourceVideo.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    expect(await prisma.multipartUpload.findUnique({ where: { id: f.input.id } })).toMatchObject({ state: "UNCERTAIN", recoveryEvidence: null });
    expect((await recoverMultipartCompletion(prisma, f.storage, f.input)).workspaceId).toBe(f.workspace.id);
    expect(f.multipart.complete).toHaveBeenCalledTimes(1);
  });

  it.each(["absent", "denied", "mismatch", "active", "workspace"])("refuses unproven completion recovery (%s)", async mode => {
    const f = await fixture();
    await registerMultipartUpload(prisma, f.storage, f.input);
    await initiateMultipartUpload(prisma, f.storage, f.input);
    if (mode === "active") {
      await prisma.multipartUpload.update({ where: { id: f.input.id }, data: { state: "COMPLETING" } });
    } else {
      f.multipart.complete.mockRejectedValueOnce(new Error("lost completion response"));
      await expect(completeMultipartUpload(prisma, f.storage, f.input)).rejects.toThrow("UNCERTAIN");
    }
    if (mode === "denied") f.multipart.inspectCompleted.mockRejectedValue(new Error("AccessDenied"));
    if (mode === "mismatch") f.multipart.inspectCompleted.mockResolvedValue({ etag: "wrong-size", byteCount: 4 });
    const request = mode === "workspace" ? { ...f.input, workspaceId: randomUUID() } : f.input;
    await expect(recoverMultipartCompletion(prisma, f.storage, request)).rejects.toThrow();
    expect(await prisma.sourceVideo.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    expect(await prisma.multipartUpload.findUnique({ where: { id: f.input.id } })).toMatchObject({ state: mode === "active" ? "COMPLETING" : "UNCERTAIN" });
    if (mode === "workspace") expect(f.multipart.inspectCompleted).not.toHaveBeenCalled();
  });

  it("prevents cancellation while a remote completion remains active", async () => {
    const f = await fixture();
    await registerMultipartUpload(prisma, f.storage, f.input);
    await initiateMultipartUpload(prisma, f.storage, f.input);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.multipart.complete.mockImplementation(async () => { entered(); await gate; return { byteCount: 3, etag: "complete" }; });
    const completing = completeMultipartUpload(prisma, f.storage, f.input);
    await started;
    try {
      await expect(abortMultipartUpload(second, f.storage, f.input)).rejects.toThrow("NOT_ABORTABLE");
      await expect(signMultipartUploadPart(second, f.storage, { ...f.input, partNumber: 1, expiresInSeconds: 60 })).rejects.toThrow("NOT_WRITABLE");
      expect(f.multipart.abort).not.toHaveBeenCalled();
    } finally { release(); await completing; }
  });
  it.each([false, true])("cancels once and retains provider failures (failure=%s)", async failure => {
    const f = await fixture();
    await registerMultipartUpload(prisma, f.storage, f.input);
    await initiateMultipartUpload(prisma, f.storage, f.input);
    if (failure) f.multipart.abort.mockRejectedValue(new Error("lost abort response"));
    const outcomes = await Promise.allSettled([abortMultipartUpload(prisma, f.storage, f.input), abortMultipartUpload(second, f.storage, f.input)]);
    if (!failure) expect(outcomes.some(result => result.status === "fulfilled")).toBe(true);
    expect(f.multipart.abort).toHaveBeenCalledTimes(1);
    expect(await prisma.multipartUpload.findUnique({ where: { id: f.input.id } }))
      .toMatchObject({ state: failure ? "UNCERTAIN" : "ABORTED" });
    if (!failure) await abortMultipartUpload(prisma, f.storage, f.input);
  });
  it("recovers cancellation once and retains immutable absence evidence", async () => {
    const f = await fixture();
    await registerMultipartUpload(prisma, f.storage, f.input);
    await initiateMultipartUpload(prisma, f.storage, f.input);
    f.multipart.abort.mockRejectedValueOnce(new Error("lost cancellation response"));
    await expect(abortMultipartUpload(prisma, f.storage, f.input)).rejects.toThrow("UNCERTAIN");
    f.multipart.inspectAborted.mockResolvedValue(true);
    await Promise.all([abortMultipartUpload(prisma, f.storage, f.input), recoverMultipartCancellation(second, f.storage, f.input)]);
    const row = await prisma.multipartUpload.findUniqueOrThrow({ where: { id: f.input.id } });
    expect(row).toMatchObject({ state: "ABORTED", uncertainStage: null,
      cancellationRecoveryEvidence: expect.objectContaining({ uploadAbsent: true, completedObjectAbsent: true,
        uploadId: "fixture-provider-id", providerMutation: false }) });
    await abortMultipartUpload(prisma, f.storage, f.input);
    expect(f.multipart.abort).toHaveBeenCalledTimes(1);
    await expect(prisma.multipartUpload.update({ where: { id: row.id }, data: { cancellationRecoveryEvidence: {} } })).rejects.toThrow();
  });

  it.each(["present", "denied", "active", "workspace"])("keeps unproven cancellation unresolved (%s)", async mode => {
    const f = await fixture();
    await registerMultipartUpload(prisma, f.storage, f.input);
    await initiateMultipartUpload(prisma, f.storage, f.input);
    if (mode === "active") await prisma.multipartUpload.update({ where: { id: f.input.id }, data: { state: "ABORTING" } });
    else {
      f.multipart.abort.mockRejectedValueOnce(new Error("lost cancellation response"));
      await expect(abortMultipartUpload(prisma, f.storage, f.input)).rejects.toThrow("UNCERTAIN");
    }
    if (mode === "denied") f.multipart.inspectAborted.mockRejectedValue(new Error("AccessDenied"));
    await expect(recoverMultipartCancellation(prisma, f.storage,
      mode === "workspace" ? { ...f.input, workspaceId: randomUUID() } : f.input)).rejects.toThrow();
    expect(await prisma.multipartUpload.findUnique({ where: { id: f.input.id } })).toMatchObject({
      state: mode === "active" ? "ABORTING" : "UNCERTAIN", cancellationRecoveryEvidence: null });
    if (mode === "workspace") expect(f.multipart.inspectAborted).not.toHaveBeenCalled();
    expect(f.multipart.abort).toHaveBeenCalledTimes(mode === "active" ? 0 : 1);
  });

  it.each(["STARTING", "COMPLETING", "ABORTING"] as const)("confirms %s while the original response remains delayed", async stage => {
    const f = await fixture();
    await registerMultipartUpload(prisma, f.storage, f.input);
    if (stage !== "STARTING") await initiateMultipartUpload(prisma, f.storage, f.input);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    if (stage === "STARTING") {
      f.multipart.create.mockImplementation(async () => { entered(); await gate; return { uploadId: "fixture-provider-id" }; });
      f.multipart.findInitiated.mockResolvedValue({ uploadId: "fixture-provider-id" });
    } else if (stage === "COMPLETING") {
      f.multipart.complete.mockImplementation(async () => { entered(); await gate; return { byteCount: 3, etag: "complete" }; });
      f.multipart.inspectCompleted.mockResolvedValue({ byteCount: 3, etag: "complete" });
    } else {
      f.multipart.abort.mockImplementation(async () => { entered(); await gate; });
      f.multipart.inspectAborted.mockResolvedValue(true);
    }
    const operation = stage === "STARTING" ? initiateMultipartUpload(prisma, f.storage, f.input)
      : stage === "COMPLETING" ? completeMultipartUpload(prisma, f.storage, f.input)
      : abortMultipartUpload(prisma, f.storage, f.input);
    await started;
    try {
      expect(await reconcileMultipartUploads(second, f.storage)).toMatchObject({ scanned: 1, recovered: 1, failed: 0 });
    } finally { release(); }
    await operation;
    expect(await prisma.multipartUpload.findUnique({ where: { id: f.input.id } })).toMatchObject({
      state: stage === "STARTING" ? "UPLOADING" : stage === "COMPLETING" ? "COMPLETED" : "ABORTED" });
    expect(f.multipart.create).toHaveBeenCalledTimes(1);
    expect(f.multipart.complete).toHaveBeenCalledTimes(stage === "COMPLETING" ? 1 : 0);
    expect(f.multipart.abort).toHaveBeenCalledTimes(stage === "ABORTING" ? 1 : 0);
    expect(await prisma.sourceVideo.count({ where: { workspaceId: f.workspace.id } })).toBe(stage === "COMPLETING" ? 1 : 0);
  });

  it("advances recovery past unresolved rows and confirms a process-interrupted claim", async () => {
    const f = await fixture();
    const inputs = ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002"]
      .map(id => ({ ...f.input, id }));
    for (const input of inputs) {
      await registerMultipartUpload(prisma, f.storage, input);
      // Simulates a process exit after durable claim. No live provider operation exists in this case.
      await prisma.multipartUpload.update({ where: { id: input.id }, data: { state: "STARTING" } });
    }
    f.multipart.findInitiated.mockImplementation(async plan => plan.sessionId === inputs[1].id ? { uploadId: "recovered" } : null);
    const first = await reconcileMultipartUploads(prisma, f.storage, { limit: 1 });
    expect(first).toMatchObject({ scanned: 1, pending: 1, recovered: 0, nextCursor: inputs[0].id });
    const secondPage = await reconcileMultipartUploads(prisma, f.storage, { limit: 1, afterId: first.nextCursor! });
    expect(secondPage).toMatchObject({ scanned: 1, pending: 0, recovered: 1 });
    expect(await reconcileMultipartUploads(prisma, f.storage, { limit: 1, afterId: secondPage.nextCursor! }))
      .toMatchObject({ scanned: 0, nextCursor: null });
    expect(f.multipart.create).not.toHaveBeenCalled();
    expect(await prisma.multipartUpload.findUnique({ where: { id: inputs[0].id } })).toMatchObject({ state: "STARTING" });
    expect(await prisma.multipartUpload.findUnique({ where: { id: inputs[1].id } })).toMatchObject({ state: "UPLOADING", providerUploadId: "recovered" });
  });

  it("rejects the plan limit and refuses expired provider work", async () => {
    const f = await fixture();
    await expect(registerMultipartUpload(prisma, f.storage, { ...f.input, totalBytes: 100 * 1024 ** 3,
      partBytes: 128 * 1024 ** 2 })).rejects.toThrow("PLAN_LIMIT_EXCEEDED");
    expect(await prisma.multipartUpload.count({ where: { id: f.input.id } })).toBe(0);
    await registerMultipartUpload(prisma, f.storage, f.input);
    await initiateMultipartUpload(prisma, f.storage, f.input);
    const clock = vi.spyOn(Date, "now").mockReturnValue(f.input.expiresAt.getTime() + 1);
    try {
      await expect(signMultipartUploadPart(prisma, f.storage, { ...f.input, partNumber: 1, expiresInSeconds: 60 })).rejects.toThrow("EXPIRED");
      await expect(completeMultipartUpload(prisma, f.storage, f.input)).rejects.toThrow("EXPIRED");
      await abortMultipartUpload(prisma, f.storage, f.input);
      expect(f.multipart.abort).toHaveBeenCalledTimes(1);
      expect(f.multipart.complete).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it("cleans only expired owned uploads and preserves active or uncertain claims", async () => {
    const f = await fixture();
    async function add(state: "NEW" | "UPLOADING" | "COMPLETING" | "UNCERTAIN" | "COMPLETED", live = false) {
      const input = { ...f.input, id: randomUUID(), expiresAt: new Date(Date.now() + (live ? 3_600_000 : 60_000)) };
      await registerMultipartUpload(prisma, f.storage, input);
      if (state !== "NEW") await initiateMultipartUpload(prisma, f.storage, input);
      if (state === "COMPLETING") await prisma.multipartUpload.update({ where: { id: input.id }, data: { state } });
      if (state === "UNCERTAIN") {
        await prisma.multipartUpload.update({ where: { id: input.id }, data: { state: "ABORTING" } });
        await prisma.multipartUpload.update({ where: { id: input.id }, data: { state, uncertainStage: "ABORTING" } });
      }
      if (state === "COMPLETED") await completeMultipartUpload(prisma, f.storage, input);
      return input;
    }
    const fresh = await add("NEW");
    const uploaded = await add("UPLOADING");
    const active = await add("COMPLETING");
    const uncertain = await add("UNCERTAIN");
    const completed = await add("COMPLETED");
    const live = await add("UPLOADING", true);
    const other = await fixture();
    await registerMultipartUpload(prisma, other.storage, other.input);
    const now = new Date(Date.now() + 120_000);
    expect(await purgeExpiredMultipartUploads(prisma, f.storage, { now })).toEqual({ scanned: 2, aborted: 2, raced: 0, failed: 0, needsReview: 2 });
    expect(f.multipart.abort).toHaveBeenCalledTimes(1);
    for (const [input, state] of [[fresh, "ABORTED"], [uploaded, "ABORTED"], [active, "COMPLETING"],
      [uncertain, "UNCERTAIN"], [completed, "COMPLETED"], [live, "UPLOADING"], [other.input, "NEW"]] as const) {
      expect(await prisma.multipartUpload.findUnique({ where: { id: input.id } })).toMatchObject({ state });
    }
    expect(await purgeExpiredMultipartUploads(prisma, f.storage, { now })).toEqual({ scanned: 0, aborted: 0, raced: 0, failed: 0, needsReview: 2 });
  });

  it("continues cleanup after one uncertain abort and does not retry it", async () => {
    const f = await fixture();
    for (let index = 0; index < 2; index++) {
      const input = { ...f.input, id: randomUUID() };
      await registerMultipartUpload(prisma, f.storage, input);
      await initiateMultipartUpload(prisma, f.storage, input);
    }
    f.multipart.abort.mockRejectedValueOnce(new Error("lost abort response"));
    const now = new Date(Date.now() + 120_000);
    expect(await purgeExpiredMultipartUploads(prisma, f.storage, { now }))
      .toMatchObject({ scanned: 2, aborted: 1, failed: 1, needsReview: 1 });
    await purgeExpiredMultipartUploads(prisma, f.storage, { now });
    expect(f.multipart.abort).toHaveBeenCalledTimes(2);
  });

  it("bounds cleanup batches and avoids duplicate provider calls across workers", async () => {
    const f = await fixture();
    await registerMultipartUpload(prisma, f.storage, f.input);
    await initiateMultipartUpload(prisma, f.storage, f.input);
    const options = { now: new Date(Date.now() + 120_000), limit: 1 };
    await Promise.all([purgeExpiredMultipartUploads(prisma, f.storage, options), purgeExpiredMultipartUploads(second, f.storage, options)]);
    expect(f.multipart.abort).toHaveBeenCalledTimes(1);
    expect(await prisma.multipartUpload.findUnique({ where: { id: f.input.id } })).toMatchObject({ state: "ABORTED" });
    for (let index = 0; index < 2; index++) await registerMultipartUpload(prisma, f.storage, { ...f.input, id: randomUUID() });
    expect(await purgeExpiredMultipartUploads(prisma, f.storage, options)).toMatchObject({ scanned: 1, aborted: 1 });
    expect(await purgeExpiredMultipartUploads(prisma, f.storage, options)).toMatchObject({ scanned: 1, aborted: 1 });
  });

  it("cancels an unstarted upload without provider calls", async () => {
    const f = await fixture();
    await registerMultipartUpload(prisma, f.storage, f.input);
    await abortMultipartUpload(prisma, f.storage, f.input);
    expect(await prisma.multipartUpload.findUnique({ where: { id: f.input.id } })).toMatchObject({ state: "ABORTED" });
    expect(f.multipart.create).not.toHaveBeenCalled();
    expect(f.multipart.abort).not.toHaveBeenCalled();
  });
});
