import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { HeuristicAnalysisProvider } from "@/lib/analysis/heuristic-provider";
import { createAnalyzeJobHandler } from "@/lib/jobs/handlers/analyze";
import { runTranscribeJob } from "@/lib/jobs/handlers/transcribe";
import { getStorageProvider } from "@/lib/storage";

// Synthetic SRT and an explicit local analysis provider. No worker loop or paid call runs.
const prisma = new PrismaClient();
const cleanup: { workspaceId: string; userId: string }[] = [];
const text = "God gives joy through trials. His grace teaches us patience when the road is hard.";
const srt = Buffer.from(`1\n00:00:00,000 --> 00:01:00,000\n${text}\n`);
beforeAll(async () => { await prisma.$connect(); });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  for (const row of cleanup) {
    await prisma.workspace.delete({ where: { id: row.workspaceId } });
    await prisma.user.delete({ where: { id: row.userId } });
  }
  await prisma.$disconnect();
});

async function seed() {
  const user = await prisma.user.create({ data: { email: `handoff-${randomUUID()}@example.test`, authProvider: "DEV" } });
  const workspace = await prisma.workspace.create({ data: { ownerId: user.id, name: "Local handoff fixture" } });
  cleanup.push({ workspaceId: workspace.id, userId: user.id });
  const source = await prisma.sourceVideo.create({ data: {
    workspaceId: workspace.id, origin: "UPLOAD", durationS: 60, srtOverrideKey: `local-${randomUUID()}.srt`,
  } });
  const project = await prisma.project.create({ data: {
    workspaceId: workspace.id, sourceVideoId: source.id, name: "Local handoff", status: "READY",
  } });
  const job = await prisma.processingJob.create({ data: {
    projectId: project.id, type: "TRANSCRIBE", state: "RUNNING", attempt: 1, idempotencyKey: randomUUID(),
  } });
  const read = vi.spyOn(getStorageProvider(), "readAsBuffer").mockResolvedValue(srt);
  return { user, workspace, source, project, job, read };
}
type Fixture = Awaited<ReturnType<typeof seed>>;
function sourceSnapshot(fixture: Fixture) {
  return prisma.sourceVideo.findUniqueOrThrow({ where: { id: fixture.source.id }, include: {
    transcript: { include: { segments: { orderBy: { idx: "asc" } } } },
  } });
}
function analyzeJobs(fixture: Fixture) {
  return prisma.processingJob.findMany({ where: { projectId: fixture.project.id, type: "ANALYZE" }, orderBy: { createdAt: "asc" } });
}
const analyze = createAnalyzeJobHandler({ selectProvider: async () => ({
  provider: new HeuristicAnalysisProvider(), providerKind: "heuristic", selectionReason: "test_no_api_key", emergencyOverride: false,
}) });
async function completeAnalysis(fixture: Fixture) {
  const job = await prisma.processingJob.findFirstOrThrow({ where: {
    projectId: fixture.project.id, type: "ANALYZE", state: "QUEUED",
  } });
  const running = await prisma.processingJob.update({ where: { id: job.id }, data: { state: "RUNNING", attempt: 1 } });
  await analyze({ job: running, prisma });
  return prisma.processingJob.update({ where: { id: job.id }, data: { state: "SUCCEEDED", finishedAt: new Date() } });
}

it("queues a new analysis after retrying a transcript whose previous analysis completed", async () => {
  const fixture = await seed();
  await runTranscribeJob({ job: fixture.job, prisma });
  const first = await sourceSnapshot(fixture);
  const completed = await completeAnalysis(fixture);
  const oldClips = await prisma.generatedClip.findMany({ where: { projectId: fixture.project.id } });
  expect(oldClips.length).toBeGreaterThan(0);
  expect(oldClips.every((clip) => clip.transcriptRevision === first.transcriptRevision)).toBe(true);

  const retry = await prisma.processingJob.update({ where: { id: fixture.job.id }, data: { attempt: 2 } });
  await runTranscribeJob({ job: retry, prisma });
  const next = await sourceSnapshot(fixture);
  const jobs = await analyzeJobs(fixture);
  expect(next.transcriptRevision).toBe(first.transcriptRevision + 1);
  expect(jobs).toHaveLength(2);
  expect(jobs.find((job) => job.id === completed.id)).toEqual(completed);
  expect(jobs.find((job) => job.state === "QUEUED")?.idempotencyKey)
    .toBe(`analyze:${fixture.project.id}:${fixture.job.id}:${next.transcript!.id}`);
  // Old clips cannot accept new word edits before the queued rebuild finishes.
  await expect(prisma.clipEdit.create({ data: { clipId: oldClips[0].id, version: 2, editorState: {} } }))
    .rejects.toThrow("CLIP_TRANSCRIPT_CHANGED");
  await completeAnalysis(fixture);
  const rebuilt = await prisma.generatedClip.findMany({ where: { projectId: fixture.project.id } });
  expect(rebuilt.length).toBeGreaterThan(0);
  expect(rebuilt.every((clip) => clip.transcriptRevision === next.transcriptRevision)).toBe(true);
  expect(rebuilt.some((clip) => oldClips.some((old) => old.id === clip.id))).toBe(false);
  const costs = await prisma.operationalEvent.findMany({ where: {
    jobId: fixture.job.id, eventType: "processing_cost_fact", metadata: { path: ["stage"], equals: "transcription" },
  } });
  expect(costs.map((cost) => cost.metadata)).toEqual(expect.arrayContaining([
    expect.objectContaining({ attempt: 1, provider: "srt_upload", outcome: "succeeded" }),
    expect.objectContaining({ attempt: 2, provider: "srt_upload", outcome: "succeeded" }),
  ]));
});

it.each([false, true])("rolls back transcript and revision if enqueue fails (replacement=%s)", async (replacement) => {
  const fixture = await seed();
  if (replacement) await runTranscribeJob({ job: fixture.job, prisma });
  const before = await sourceSnapshot(fixture);
  const jobsBefore = await analyzeJobs(fixture);
  const broken = prisma.$extends({ query: { processingJob: { async create({ args, query }) {
    if (args.data.projectId === fixture.project.id && args.data.type === "ANALYZE") throw new Error("Injected analysis insert failure");
    return query(args);
  } } } }) as unknown as PrismaClient;
  await expect(runTranscribeJob({ job: fixture.job, prisma: broken })).rejects.toThrow("Injected analysis insert failure");
  expect(await sourceSnapshot(fixture)).toEqual(before);
  expect(await analyzeJobs(fixture)).toEqual(jobsBefore);
  // External work already performed is still a cost fact even when its database result rolls back.
  expect(await prisma.operationalEvent.count({ where: {
    jobId: fixture.job.id, eventType: "processing_cost_fact", metadata: { path: ["stage"], equals: "transcription" },
  } })).toBe(replacement ? 2 : 1);
});

it("refuses a retry before reading input when a person saved work after the first analysis", async () => {
  const fixture = await seed();
  await runTranscribeJob({ job: fixture.job, prisma });
  await completeAnalysis(fixture);
  const clip = await prisma.generatedClip.findFirstOrThrow({ where: { projectId: fixture.project.id } });
  const edit = await prisma.clipEdit.create({ data: { clipId: clip.id, version: 2, editorState: { human: true } } });
  const before = await sourceSnapshot(fixture);
  const jobsBefore = await analyzeJobs(fixture);
  fixture.read.mockClear();
  const retry = await prisma.processingJob.update({ where: { id: fixture.job.id }, data: { attempt: 2 } });
  await expect(runTranscribeJob({ job: retry, prisma })).rejects.toMatchObject({ code: "REANALYSIS_BLOCKED", preservesProject: true });
  expect(fixture.read).not.toHaveBeenCalled();
  expect(await sourceSnapshot(fixture)).toEqual(before);
  expect(await analyzeJobs(fixture)).toEqual(jobsBefore);
  expect(await prisma.clipEdit.findUnique({ where: { id: edit.id } })).toEqual(edit);
  expect((await prisma.project.findUniqueOrThrow({ where: { id: fixture.project.id } })).status).toBe("READY");
});

it("refuses a result if the project changed sources during its input read", async () => {
  const fixture = await seed();
  const other = await prisma.sourceVideo.create({ data: { workspaceId: fixture.workspace.id, origin: "UPLOAD" } });
  const before = await sourceSnapshot(fixture);
  fixture.read.mockImplementationOnce(async () => {
    await prisma.project.update({ where: { id: fixture.project.id }, data: { sourceVideoId: other.id } });
    return srt;
  });
  await expect(runTranscribeJob({ job: fixture.job, prisma })).rejects.toMatchObject({ code: "TRANSCRIPT_CHANGED", preservesProject: true });
  expect(await sourceSnapshot(fixture)).toEqual(before);
  expect(await analyzeJobs(fixture)).toHaveLength(0);
});

function observe<T>(promise: Promise<T>) {
  let settled = false;
  const outcome = promise.then((value) => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }))
    .finally(() => { settled = true; });
  return { outcome, settled: () => settled };
}
async function waitForLock(settled: () => boolean, table: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (settled()) return;
    const result = await prisma.$queryRaw<{ waiting: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid()
        AND wait_event_type = 'Lock' AND query LIKE ${`%${table}%`}) AS waiting`;
    if (result[0].waiting) return;
    await delay(5);
  }
  throw new Error(`No completion or database lock wait for ${table}`);
}

it("waits for a project-first source writer before it locks the source and saves follow-up work", async () => {
  const fixture = await seed();
  let release!: () => void;
  let entered!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const writer = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM projects WHERE id = ${fixture.project.id}::uuid FOR NO KEY UPDATE`;
    entered();
    await released;
    await tx.$queryRaw`SELECT id FROM source_videos WHERE id = ${fixture.source.id}::uuid FOR UPDATE`;
    await tx.sourceVideo.update({ where: { id: fixture.source.id }, data: { srtOverrideKey: "changed-under-project-lock.srt" } });
  }, { timeout: 10000 });
  let worker: ReturnType<typeof observe<Awaited<ReturnType<typeof runTranscribeJob>>>> | undefined;
  try {
    await Promise.race([started, writer]);
    worker = observe(runTranscribeJob({ job: fixture.job, prisma }));
    await waitForLock(worker.settled, "projects");
    expect(worker.settled()).toBe(false);
  } finally {
    release();
    await writer;
  }
  expect((await worker!.outcome).error).toMatchObject({ code: "TRANSCRIPT_CHANGED", preservesProject: true });
  expect((await sourceSnapshot(fixture)).transcript).toBeNull();
  expect(await analyzeJobs(fixture)).toHaveLength(0);
});

it("allows a source-first durable post to finish its project foreign-key check", async () => {
  const fixture = await seed();
  let release!: () => void;
  let entered!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const writer = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM source_videos WHERE id = ${fixture.source.id}::uuid FOR UPDATE`;
    entered();
    await released;
    await tx.scheduledPost.create({ data: {
      workspaceId: fixture.workspace.id, projectId: fixture.project.id, scheduledDate: new Date("2027-01-01"), publishStatus: "BLOCKED",
    } });
  }, { timeout: 10000 });
  let worker: ReturnType<typeof observe<Awaited<ReturnType<typeof runTranscribeJob>>>> | undefined;
  try {
    await Promise.race([started, writer]);
    worker = observe(runTranscribeJob({ job: fixture.job, prisma }));
    await waitForLock(worker.settled, "source_videos");
  } finally {
    release();
    await writer;
  }
  expect((await worker!.outcome).error).toMatchObject({ code: "REANALYSIS_BLOCKED", preservesProject: true });
  expect((await sourceSnapshot(fixture)).transcript).toBeNull();
  expect(await analyzeJobs(fixture)).toHaveLength(0);
});
