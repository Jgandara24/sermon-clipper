import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import os from "node:os";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type { StorageProvider } from "@/lib/storage/types";

// The route, storage bytes, and transactions are real. No auth service or background worker runs.
const fixtureState = vi.hoisted(() => ({
  user: { id: "" }, workspace: { id: "" }, storage: null as StorageProvider | null,
  client: null as PrismaClient | null,
  after: vi.fn(), runner: vi.fn(() => { throw new Error("A worker must not run in the upload tests"); }),
}));
vi.mock("@/lib/api/auth", () => ({ requireApiWorkspace: async () => fixtureState }));
vi.mock("@/lib/prisma", () => ({ get prisma() { return fixtureState.client!; } }));
vi.mock("next/server", () => ({ after: fixtureState.after }));
vi.mock("@/lib/jobs/runner", () => ({ runOnePendingJob: fixtureState.runner }));
vi.mock("@/lib/storage", () => ({ getStorageProvider: () => fixtureState.storage! }));
import { POST } from "@/app/api/videos/[id]/srt/route";
import { LocalDiskStorageProvider } from "@/lib/storage/local-disk-provider";
import { claimNextJob } from "@/lib/jobs/queue";
import { discardUnreferencedSrt, purgeAbandonedSrts, SRT_ORPHAN_GRACE_MS, SRT_STAGE_LIFETIME_MS } from "@/lib/transcription/srt-storage";

const prisma = new PrismaClient();
let root: string;
const cleanup: { userId: string; workspaceId: string }[] = [];
const eventKeys: string[] = [];
const oldText = "1\n00:00:00,000 --> 00:00:06,000\noriginal words\n";
const newText = "1\n00:00:00,000 --> 00:00:06,000\nreplacement words\n";
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "srt-upload-test-"));
  fixtureState.storage = new LocalDiskStorageProvider(root);
  fixtureState.client = prisma;
});
afterEach(() => {
  vi.restoreAllMocks();
  fixtureState.after.mockClear();
  fixtureState.runner.mockClear();
  fixtureState.client = prisma;
});
afterAll(async () => {
  for (const key of eventKeys) await prisma.operationalEvent.deleteMany({ where: {
    eventType: "srt_storage_cleanup_pending", metadata: { path: ["storageKey"], equals: key },
  } });
  for (const row of cleanup) {
    await prisma.workspace.delete({ where: { id: row.workspaceId } });
    await prisma.user.delete({ where: { id: row.userId } });
  }
  await prisma.$disconnect();
  await rm(root, { recursive: true, force: true });
});

function claimantFor(projectId: string) {
  // Scope only the candidate search so this test cannot claim a different fixture's work.
  // The real claim transition, race predicate, and reread still run on separate connections.
  return prisma.$extends({ query: { processingJob: { async findFirst({ args, query }) {
    return query({ ...args, where: { ...args.where, projectId } });
  } } } }) as unknown as PrismaClient;
}
function observe<T>(promise: Promise<T>) {
  let settled = false;
  const outcome = promise.then((value) => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }))
    .finally(() => { settled = true; });
  return { outcome, settled: () => settled };
}
async function waitForCompletionOrLock(settled: () => boolean, table: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (settled()) return;
    const waiting = await prisma.$queryRaw<{ waiting: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid()
        AND wait_event_type = 'Lock' AND query LIKE ${`%${table}%`}) AS waiting`;
    if (waiting[0].waiting) return;
    await delay(5);
  }
  throw new Error(`No completion or lock wait for ${table}`);
}

it("rolls back if a worker claims the old queued job before cancellation", async () => {
  const fixture = await seed();
  const queued = await job(fixture, "QUEUED");
  let claimed: Awaited<ReturnType<typeof claimNextJob>> | undefined;
  fixtureState.client = prisma.$extends({ query: { processingJob: { async updateMany({ args, query }) {
    if (args.data.errorCode === "SRT_SUPERSEDED") {
      claimed = await claimNextJob(claimantFor(fixture.project.id), ["TRANSCRIBE"]);
    }
    return query(args);
  } } } }) as unknown as PrismaClient;
  const response = await request(fixture.source.id);
  expect(response?.status).toBe(409);
  expect(await response?.json()).toMatchObject({ error: { code: "SRT_PROCESSING_ACTIVE" } });
  expect(claimed?.id).toBe(queued.id);
  expect((await prisma.sourceVideo.findUniqueOrThrow({ where: { id: fixture.source.id } })).srtOverrideKey).toBe(fixture.currentKey);
  expect((await fixtureState.storage!.readAsBuffer(fixture.currentKey)).toString()).toBe(oldText);
  expect(await prisma.processingJob.count({ where: { projectId: fixture.project.id } })).toBe(1);
  expect(fixtureState.after).not.toHaveBeenCalled();
  // Conservative cleanup defers while the source has a running reader, then recovers by age.
  await prisma.processingJob.update({ where: { id: queued.id }, data: { state: "FAILED" } });
  await purgeAbandonedSrts(prisma, new Date(Date.now() + SRT_ORPHAN_GRACE_MS + 1000), fixtureState.storage!);
  expect((await fixtureState.storage!.list(`srt/${fixture.workspace.id}/`)).map((item) => item.key)).toEqual([fixture.currentKey]);
});

it("prevents a waiting claim from running a job canceled by the upload", async () => {
  const fixture = await seed();
  const queued = await job(fixture, "QUEUED");
  let claiming: ReturnType<typeof observe<Awaited<ReturnType<typeof claimNextJob>>>> | undefined;
  fixtureState.client = prisma.$extends({ query: { sourceVideo: { async update({ args, query }) {
    if (args.where.id === fixture.source.id && !claiming) {
      claiming = observe(claimNextJob(claimantFor(fixture.project.id), ["TRANSCRIBE"]));
      await waitForCompletionOrLock(claiming.settled, "processing_jobs");
    }
    return query(args);
  } } } }) as unknown as PrismaClient;
  expect((await request(fixture.source.id))?.status).toBe(200);
  expect(await claiming!.outcome).toEqual({ value: null, error: undefined });
  expect(await prisma.processingJob.findUnique({ where: { id: queued.id } })).toMatchObject({ state: "CANCELED" });
  expect(await prisma.processingJob.count({ where: { projectId: fixture.project.id, state: "QUEUED" } })).toBe(1);
  expect(fixtureState.runner).not.toHaveBeenCalled();
});

it("preserves a committed input when the transaction response is lost", async () => {
  const fixture = await seed();
  let loseResponse = true;
  fixtureState.client = new Proxy(prisma, { get(target, key, receiver) {
    if (key === "$transaction") return async (...args: Parameters<PrismaClient["$transaction"]>) => {
      const result = await target.$transaction(...args);
      if (loseResponse) { loseResponse = false; throw new Error("commit response lost"); }
      return result;
    };
    return Reflect.get(target, key, receiver);
  } });
  await expect(request(fixture.source.id)).rejects.toThrow("commit response lost");
  const source = await prisma.sourceVideo.findUniqueOrThrow({ where: { id: fixture.source.id } });
  expect(source.srtOverrideKey).not.toBe(fixture.currentKey);
  expect((await fixtureState.storage!.readAsBuffer(source.srtOverrideKey!)).toString()).toBe(newText);
  expect(await prisma.processingJob.count({ where: { projectId: fixture.project.id, state: "QUEUED" } })).toBe(1);
  expect(fixtureState.after).not.toHaveBeenCalled();
});

it("keeps the new input when cleanup waits for its pointer commit", async () => {
  const fixture = await seed();
  let sweeping: ReturnType<typeof observe<Awaited<ReturnType<typeof discardUnreferencedSrt>>>> | undefined;
  fixtureState.client = prisma.$extends({ query: { sourceVideo: { async update({ args, query }) {
    if (args.where.id === fixture.source.id && typeof args.data.srtOverrideKey === "string" && !sweeping) {
      sweeping = observe(discardUnreferencedSrt(prisma, args.data.srtOverrideKey, fixtureState.storage!));
      await waitForCompletionOrLock(sweeping.settled, "source_videos");
    }
    return query(args);
  } } } }) as unknown as PrismaClient;
  expect((await request(fixture.source.id))?.status).toBe(200);
  expect(await sweeping!.outcome).toEqual({ value: "kept", error: undefined });
  const source = await prisma.sourceVideo.findUniqueOrThrow({ where: { id: fixture.source.id } });
  expect(await fixtureState.storage!.exists(source.srtOverrideKey!)).toBe(true);
});

it("expires a stalled stage before it could become an orphan-sweep candidate", async () => {
  const fixture = await seed();
  const storage = fixtureState.storage!;
  const write = storage.writeFromWebStream.bind(storage);
  vi.spyOn(storage, "writeFromWebStream").mockImplementationOnce(async (...args) => {
    const result = await write(...args);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + SRT_STAGE_LIFETIME_MS + 1);
    return result;
  });
  const response = await request(fixture.source.id);
  expect(response?.status).toBe(409);
  expect(await response?.json()).toMatchObject({ error: { code: "SRT_UPLOAD_EXPIRED" } });
  await expectUnchanged(fixture);
});

it("refuses a staged file that disappeared before the pointer commit", async () => {
  const fixture = await seed();
  const storage = fixtureState.storage!;
  const write = storage.writeFromWebStream.bind(storage);
  vi.spyOn(storage, "writeFromWebStream").mockImplementationOnce(async (...args) => {
    const result = await write(...args);
    await storage.remove(args[0]);
    return result;
  });
  const response = await request(fixture.source.id);
  expect(response?.status).toBe(409);
  expect(await response?.json()).toMatchObject({ error: { code: "SRT_UPLOAD_MISSING" } });
  await expectUnchanged(fixture);
  expect(await prisma.processingJob.count({ where: { projectId: fixture.project.id } })).toBe(0);
});

it.each([new Date(0), new Date(NaN)])("keeps an object whose listing has no usable age (%s)", async (lastModified) => {
  const fixture = await seed();
  const storage = fixtureState.storage!;
  const orphan = `srt/${fixture.workspace.id}/${fixture.source.id}/${randomUUID()}.srt`;
  await storage.writeFromWebStream(orphan, new Blob([newText]).stream(), 2048);
  vi.spyOn(storage, "list").mockResolvedValueOnce([{ key: orphan, lastModified }]);
  expect(await purgeAbandonedSrts(prisma, new Date(), storage)).toMatchObject({ removed: 0, kept: 1 });
  expect(await storage.exists(orphan)).toBe(true);
});

it("recovers a failed orphan removal, records it privately, and preserves referenced/fresh/unmanaged files", async () => {
  const fixture = await seed();
  const storage = fixtureState.storage!;
  const orphan = `srt/${fixture.workspace.id}/${fixture.source.id}/${randomUUID()}.srt`;
  const fresh = `srt/${fixture.workspace.id}/${fixture.source.id}/${randomUUID()}.srt`;
  const unmanaged = `srt/${fixture.workspace.id}/leave-this-file.txt`;
  eventKeys.push(orphan);
  const old = new Date(Date.now() - SRT_ORPHAN_GRACE_MS - 1000);
  for (const key of [orphan, fresh, unmanaged]) await storage.writeFromWebStream(key, new Blob([oldText]).stream(), 2048);
  for (const key of [orphan, unmanaged, fixture.currentKey]) await utimes(storage.absolutePath(key), old, old);
  const remove = storage.remove.bind(storage);
  vi.spyOn(storage, "remove").mockImplementationOnce(async (key) => {
    if (key === orphan) throw new Error("local storage failure");
    return remove(key);
  });
  expect((await purgeAbandonedSrts(prisma, new Date(), storage)).failed).toBe(1);
  expect(await storage.exists(orphan)).toBe(true);
  const event = await prisma.operationalEvent.findFirstOrThrow({ where: {
    eventType: "srt_storage_cleanup_pending", metadata: { path: ["storageKey"], equals: orphan },
  } });
  expect(event).toMatchObject({ workspaceId: null, projectId: null, severity: "warning" });
  expect(event.metadata).not.toHaveProperty("error");
  expect((await purgeAbandonedSrts(prisma, new Date(), storage)).removed).toBeGreaterThanOrEqual(1);
  expect(await storage.exists(orphan)).toBe(false);
  for (const key of [fixture.currentKey, fresh, unmanaged]) expect(await storage.exists(key)).toBe(true);
});

it("preserves an older key referenced by another source", async () => {
  const fixture = await seed();
  const storage = fixtureState.storage!;
  const old = new Date(Date.now() - SRT_ORPHAN_GRACE_MS - 1000);
  await utimes(storage.absolutePath(fixture.currentKey), old, old);
  await prisma.sourceVideo.create({ data: {
    workspaceId: fixture.workspace.id, origin: "UPLOAD", srtOverrideKey: fixture.currentKey,
  } });
  await prisma.sourceVideo.update({ where: { id: fixture.source.id }, data: { srtOverrideKey: null } });
  await purgeAbandonedSrts(prisma, new Date(), storage);
  expect(await storage.exists(fixture.currentKey)).toBe(true);
});

async function seed() {
  const user = await prisma.user.create({ data: { email: `srt-${randomUUID()}@example.test`, authProvider: "DEV" } });
  const workspace = await prisma.workspace.create({ data: { ownerId: user.id, name: "Local SRT upload" } });
  cleanup.push({ userId: user.id, workspaceId: workspace.id });
  fixtureState.user.id = user.id;
  fixtureState.workspace.id = workspace.id;
  const source = await prisma.sourceVideo.create({ data: { workspaceId: workspace.id, origin: "UPLOAD" } });
  const currentKey = `srt/${workspace.id}/${source.id}.srt`;
  await fixtureState.storage!.writeFromWebStream(currentKey, new Blob([oldText]).stream(), 2048);
  const currentSource = await prisma.sourceVideo.update({ where: { id: source.id }, data: { srtOverrideKey: currentKey } });
  const project = await prisma.project.create({ data: {
    workspaceId: workspace.id, sourceVideoId: source.id, name: "Local SRT", status: "READY",
  } });
  return { source: currentSource, project, currentKey, workspace, user };
}
type Fixture = Awaited<ReturnType<typeof seed>>;
function request(sourceId: string, text = newText) {
  return POST(new Request("http://local.test/srt", { method: "POST", body: text }), { params: Promise.resolve({ id: sourceId }) });
}
async function job(fixture: Fixture, state: "QUEUED" | "RUNNING" | "SUCCEEDED", type: "TRANSCRIBE" | "ANALYZE" = "TRANSCRIBE") {
  return prisma.processingJob.create({ data: { projectId: fixture.project.id, type, state, idempotencyKey: randomUUID() } });
}
async function expectUnchanged(fixture: Fixture) {
  expect((await prisma.sourceVideo.findUniqueOrThrow({ where: { id: fixture.source.id } })).srtOverrideKey).toBe(fixture.currentKey);
  expect((await fixtureState.storage!.readAsBuffer(fixture.currentKey)).toString()).toBe(oldText);
  expect((await fixtureState.storage!.list(`srt/${fixture.workspace.id}/`)).map((item) => item.key)).toEqual([fixture.currentKey]);
  expect(fixtureState.after).not.toHaveBeenCalled();
  expect(fixtureState.runner).not.toHaveBeenCalled();
}

it("leaves the live SRT intact and removes staging when the pointer update fails", async () => {
  const fixture = await seed();
  fixtureState.client = prisma.$extends({ query: { sourceVideo: { async update({ args, query }) {
    if (args.where.id === fixture.source.id) throw new Error("local pointer failure");
    return query(args);
  } } } }) as unknown as PrismaClient;
  await expect(request(fixture.source.id)).rejects.toThrow("local pointer failure");
  await expectUnchanged(fixture);
  expect(await prisma.processingJob.count({ where: { projectId: fixture.project.id } })).toBe(0);
});

it("rolls back the pointer and canceled work when the new job insert fails", async () => {
  const fixture = await seed();
  const queued = await job(fixture, "QUEUED");
  const completed = await job(fixture, "SUCCEEDED");
  fixtureState.client = prisma.$extends({ query: { processingJob: { async create({ args, query }) {
    if (args.data.projectId === fixture.project.id) throw new Error("local enqueue failure");
    return query(args);
  } } } }) as unknown as PrismaClient;
  await expect(request(fixture.source.id)).rejects.toThrow("local enqueue failure");
  await expectUnchanged(fixture);
  expect(await prisma.processingJob.findUnique({ where: { id: queued.id } })).toMatchObject({ state: "QUEUED" });
  expect(await prisma.processingJob.findUnique({ where: { id: completed.id } })).toMatchObject({ state: "SUCCEEDED" });
  expect(await prisma.processingJob.count({ where: { projectId: fixture.project.id } })).toBe(2);
});

it.each(["TRANSCRIBE", "ANALYZE"] as const)("refuses a running %s and keeps its history", async (type) => {
  const fixture = await seed();
  const running = await job(fixture, "RUNNING", type);
  const completed = await job(fixture, "SUCCEEDED");
  const response = await request(fixture.source.id);
  expect(response?.status).toBe(409);
  expect(await response?.json()).toMatchObject({ error: { code: "SRT_PROCESSING_ACTIVE" } });
  await expectUnchanged(fixture);
  expect(await prisma.processingJob.findUnique({ where: { id: running.id } })).toMatchObject({ state: "RUNNING" });
  expect(await prisma.processingJob.findUnique({ where: { id: completed.id } })).toMatchObject({ state: "SUCCEEDED" });
});

it.each(["queued analysis", "sibling transcription", "reserved minutes"] as const)("preserves %s instead of canceling it", async (kind) => {
  const fixture = await seed();
  let projectId = fixture.project.id;
  if (kind === "sibling transcription") {
    const sibling = await prisma.project.create({ data: {
      workspaceId: fixture.workspace.id, sourceVideoId: fixture.source.id, name: "Sibling", status: "READY",
    } });
    projectId = sibling.id;
  }
  const queued = await prisma.processingJob.create({ data: {
    projectId, type: kind === "queued analysis" ? "ANALYZE" : "TRANSCRIBE", state: "QUEUED",
    idempotencyKey: randomUUID(), minutesReserved: kind === "reserved minutes" ? 10 : null,
  } });
  const response = await request(fixture.source.id);
  expect(response?.status).toBe(409);
  expect(await response?.json()).toMatchObject({ error: { code: "SRT_PROCESSING_ACTIVE" } });
  await expectUnchanged(fixture);
  expect(await prisma.processingJob.findUnique({ where: { id: queued.id } })).toMatchObject({ state: "QUEUED" });
});

it("refuses a human edit that commits during staging", async () => {
  const fixture = await seed();
  const clip = await prisma.generatedClip.create({ data: {
    projectId: fixture.project.id, workspaceId: fixture.workspace.id,
    rank: 1, startMs: 0, endMs: 6000, title: "Local clip", summary: "Local fixture",
  } });
  const storage = fixtureState.storage!;
  const write = storage.writeFromWebStream.bind(storage);
  vi.spyOn(storage, "writeFromWebStream").mockImplementationOnce(async (...args) => {
    const result = await write(...args);
    await prisma.clipEdit.create({ data: { clipId: clip.id, version: 1, editorState: { version: 1 } } });
    return result;
  });
  const response = await request(fixture.source.id);
  expect(response?.status).toBe(409);
  expect(await response?.json()).toMatchObject({ error: { code: "REANALYSIS_BLOCKED" } });
  await expectUnchanged(fixture);
  expect(await prisma.processingJob.count({ where: { projectId: fixture.project.id } })).toBe(0);
  expect(await prisma.clipEdit.count({ where: { clipId: clip.id } })).toBe(1);
});

it("commits one new immutable input/job and retains canceled/completed history", async () => {
  const fixture = await seed();
  const queued = await job(fixture, "QUEUED");
  const completed = await job(fixture, "SUCCEEDED");
  const response = await request(fixture.source.id);
  expect(response?.status).toBe(200);
  const source = await prisma.sourceVideo.findUniqueOrThrow({ where: { id: fixture.source.id } });
  expect(source.srtOverrideKey).not.toBe(fixture.currentKey);
  expect((await fixtureState.storage!.readAsBuffer(source.srtOverrideKey!)).toString()).toBe(newText);
  expect((await fixtureState.storage!.readAsBuffer(fixture.currentKey)).toString()).toBe(oldText);
  expect(await prisma.processingJob.findUnique({ where: { id: queued.id } })).toMatchObject({ state: "CANCELED", errorCode: "SRT_SUPERSEDED" });
  expect(await prisma.processingJob.findUnique({ where: { id: completed.id } })).toMatchObject({ state: "SUCCEEDED" });
  expect(await prisma.processingJob.count({ where: { projectId: fixture.project.id, state: "QUEUED" } })).toBe(1);
  expect(fixtureState.after).toHaveBeenCalledTimes(1);
  expect(fixtureState.runner).not.toHaveBeenCalled();
});

it("allows one of two uploads based on the same source version to commit", async () => {
  const fixture = await seed();
  const storage = fixtureState.storage!;
  const write = storage.writeFromWebStream.bind(storage);
  let arrived = 0;
  let release!: () => void;
  const bothStaged = new Promise<void>((resolve) => { release = resolve; });
  vi.spyOn(storage, "writeFromWebStream").mockImplementation(async (...args) => {
    const result = await write(...args);
    if (++arrived === 2) release();
    await bothStaged;
    return result;
  });
  const responses = await Promise.all([request(fixture.source.id), request(fixture.source.id)]);
  expect(responses.map((response) => response?.status).sort()).toEqual([200, 409]);
  const refusal = responses.find((response) => response?.status === 409);
  expect(await refusal?.json()).toMatchObject({ error: { code: "SRT_SOURCE_CHANGED" } });
  expect(await prisma.processingJob.count({ where: { projectId: fixture.project.id, state: "QUEUED" } })).toBe(1);
  expect((await storage.readAsBuffer(fixture.currentKey)).toString()).toBe(oldText);
  expect((await storage.list(`srt/${fixture.workspace.id}/`))).toHaveLength(2);
  expect(fixtureState.after).toHaveBeenCalledTimes(1);
  expect(fixtureState.runner).not.toHaveBeenCalled();
});
