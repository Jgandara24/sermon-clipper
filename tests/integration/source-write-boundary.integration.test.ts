/** Real commits on separate connections. Only auth and SRT bytes are local fixtures. */
import { PrismaClient, type Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ user: { id: "" }, workspace: { id: "" } }));
vi.mock("@/lib/api/auth", () => ({ requireApiWorkspace: async () => auth }));

import { PUT as saveEdit } from "@/app/api/clips/[id]/edit-state/route";
import { POST as requestApproval } from "@/app/api/clips/[id]/approval/route";
import { POST as requestExport } from "@/app/api/clips/[id]/exports/route";
import { buildDefaultEditorState } from "@/lib/editor/types";
import { HeuristicAnalysisProvider } from "@/lib/analysis/heuristic-provider";
import { createAnalyzeJobHandler } from "@/lib/jobs/handlers/analyze";
import { runTranscribeJob } from "@/lib/jobs/handlers/transcribe";
import { getStorageProvider } from "@/lib/storage";

const prisma = new PrismaClient();
const users: string[] = [];
const workspaces: string[] = [];

async function seed() {
  const user = await prisma.user.create({ data: { email: `write-boundary-${randomUUID()}@example.test`, authProvider: "DEV" } });
  users.push(user.id);
  const workspace = await prisma.workspace.create({ data: { ownerId: user.id, name: "Local source boundary" } });
  workspaces.push(workspace.id);
  auth.user.id = user.id;
  auth.workspace.id = workspace.id;
  const source = await prisma.sourceVideo.create({ data: {
    workspaceId: workspace.id, origin: "UPLOAD", durationS: 60, srtOverrideKey: "local-fixture.srt",
    transcript: { create: { language: "en", provider: "local-fixture", fullText: "old source words",
      segments: { create: { idx: 0, startMs: 0, endMs: 60000, text: "old source words",
        words: [{ text: "old", startMs: 0, endMs: 500 }] } } } },
  }, include: { transcript: { include: { segments: true } } } });
  const project = await prisma.project.create({ data: {
    workspaceId: workspace.id, sourceVideoId: source.id, name: "Local fixture", status: "READY",
  } });
  const clip = await prisma.generatedClip.create({ data: {
    workspaceId: workspace.id, projectId: project.id, rank: 1,
    startMs: 0, endMs: 60000, title: "Old clip", summary: "Local fixture only",
  } });
  const job = await prisma.processingJob.create({ data: {
    projectId: project.id, type: "TRANSCRIBE", state: "RUNNING", idempotencyKey: `local:${randomUUID()}`,
  } });
  const state = buildDefaultEditorState({ sourceVideoId: source.id, startMs: 0, endMs: 60000 });
  state.wordEdits.textOverrides = [{ wordId: `${source.transcript!.segments[0].id}:0`, text: "corrected" }];
  return { user, workspace, source, project, clip, job, state };
}
type Fixture = Awaited<ReturnType<typeof seed>>;
type WriteKind = "edit" | "approval" | "export";
const tables = { edit: "clip_edits", approval: "clip_approvals", export: "export_jobs" };

function writeRequest(fixture: Fixture, kind: WriteKind) {
  const route = { edit: saveEdit, approval: requestApproval, export: requestExport }[kind];
  return route(new Request("http://local.test/clip", {
    method: kind === "edit" ? "PUT" : "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(kind === "edit" ? { baseVersion: 0, state: fixture.state } : {}),
  }), { params: Promise.resolve({ id: fixture.clip.id }) });
}

async function durableWrite(tx: Prisma.TransactionClient, fixture: Fixture, kind: WriteKind | "post" | "detached review") {
  if (kind === "edit") return tx.clipEdit.create({ data: {
    clipId: fixture.clip.id, version: 1, editorState: fixture.state as unknown as Prisma.InputJsonValue,
  } });
  if (kind === "approval") return tx.clipApproval.create({ data: {
    workspaceId: fixture.workspace.id, clipId: fixture.clip.id,
    reviewToken: randomUUID(), reviewTokenExpiresAt: new Date("2027-01-01"),
  } });
  if (kind === "post") return tx.scheduledPost.create({ data: {
    workspaceId: fixture.workspace.id, projectId: fixture.project.id,
    clipId: fixture.clip.id, scheduledDate: new Date("2027-01-01"), publishStatus: "BLOCKED",
  } });
  if (kind === "detached review") return tx.clipReview.create({ data: {
    workspaceId: fixture.workspace.id, decision: "ACCEPT", projectIdSnapshot: fixture.project.id,
    scheduledPostIdSnapshot: randomUUID(), clipIdSnapshot: randomUUID(), exportJobIdSnapshot: randomUUID(),
    clipRank: 1, clipStartMs: 0, clipEndMs: 60000, editVersion: 0, checksum: "local-fixture-only",
  } });
  return tx.exportJob.create({ data: {
    workspaceId: fixture.workspace.id, clipId: fixture.clip.id, filename: "fixture.mp4", idempotencyKey: randomUUID(),
  } });
}

function observe<T>(promise: Promise<T>) {
  let settled = false;
  const outcome = promise.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  ).finally(() => { settled = true; });
  return { outcome, settled: () => settled };
}

/** Use an actual database lock wait, not a fixed delay, as the concurrency barrier. */
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
  throw new Error(`No completion or database lock wait for ${table}`);
}

beforeAll(async () => { await prisma.$connect(); });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  for (const id of workspaces) await prisma.workspace.delete({ where: { id } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.$disconnect();
});

function localSrt() {
  vi.spyOn(getStorageProvider(), "readAsBuffer").mockResolvedValue(
    Buffer.from("1\n00:00:00,000 --> 00:01:00,000\nnew source words\n"),
  );
}

function localAnalysis(beforeScore: () => Promise<void> = async () => {}) {
  const provider = new HeuristicAnalysisProvider();
  const score = provider.scoreCandidates.bind(provider);
  provider.scoreCandidates = async (...args) => {
    await beforeScore();
    return score(...args);
  };
  return createAnalyzeJobHandler({ selectProvider: async () => ({
    provider, providerKind: "heuristic", selectionReason: "test_no_api_key", emergencyOverride: false,
  }) });
}

describe("source replacement and the first durable write", () => {
  it("refuses analysis from a transcript that changed while scoring", async () => {
    const fixture = await seed();
    localSrt();
    const handler = localAnalysis(async () => { await runTranscribeJob({ job: fixture.job, prisma }); });
    const analysisJob = await prisma.processingJob.create({ data: {
      projectId: fixture.project.id, type: "ANALYZE", state: "RUNNING", idempotencyKey: randomUUID(),
    } });
    await expect(handler({ job: analysisJob, prisma })).rejects.toMatchObject({
      code: "TRANSCRIPT_CHANGED", preservesProject: true, retryable: false,
    });
    expect(await prisma.generatedClip.findUnique({ where: { id: fixture.clip.id } })).not.toBeNull();
    expect(await prisma.clipEdit.count({ where: { clip: { projectId: fixture.project.id } } })).toBe(0);
  });

  it.each(["edit", "approval", "export"] as const)("refuses a late %s after replacement wins the lock", async (kind) => {
    const fixture = await seed();
    localSrt();
    let saving: ReturnType<typeof observe<Response | undefined>> | undefined;
    const hooked = prisma.$extends({ query: { transcript: { async deleteMany({ args, query }) {
      if (args.where?.sourceVideoId === fixture.source.id && !saving) {
        // The final durable-work count is already complete; hold the transcript transaction here.
        saving = observe(writeRequest(fixture, kind));
        await waitForCompletionOrLock(saving.settled, tables[kind]);
      }
      return query(args);
    } } } });
    await runTranscribeJob({ job: fixture.job, prisma: hooked as unknown as PrismaClient });
    const saved = await saving!.outcome;
    expect(saved.error).toBeUndefined();
    expect(saved.value?.status).toBe(409);
    expect(await saved.value?.json()).toMatchObject({ error: { code: "CLIP_TRANSCRIPT_CHANGED" } });
    expect((await prisma.transcript.findUniqueOrThrow({ where: { sourceVideoId: fixture.source.id } })).id)
      .not.toBe(fixture.source.transcript!.id);
    expect(await prisma.clipEdit.count({ where: { clipId: fixture.clip.id } })).toBe(0);
    expect(await prisma.clipApproval.count({ where: { clipId: fixture.clip.id } })).toBe(0);
    expect(await prisma.exportJob.count({ where: { clipId: fixture.clip.id } })).toBe(0);
    expect(await prisma.approvalNotification.count({ where: { workspaceId: fixture.workspace.id } })).toBe(0);
  });

  it.each(["edit", "approval", "export", "post", "detached review"] as const)("preserves the transcript when an uncommitted %s wins the lock", async (kind) => {
    const fixture = await seed();
    localSrt();
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const writer = prisma.$transaction(async (tx) => {
      await durableWrite(tx, fixture, kind);
      entered();
      await released;
    }, { timeout: 10000 });
    let replacement: ReturnType<typeof observe<Awaited<ReturnType<typeof runTranscribeJob>>>> | undefined;
    try {
      await Promise.race([started, writer]);
      replacement = observe(runTranscribeJob({ job: fixture.job, prisma }));
      await waitForCompletionOrLock(replacement.settled, "source_videos");
    } finally {
      release();
      await writer;
    }
    const result = await replacement!.outcome;
    expect(result.error).toMatchObject({ code: "REANALYSIS_BLOCKED", preservesProject: true });
    expect((await prisma.transcript.findUniqueOrThrow({ where: { sourceVideoId: fixture.source.id } })).id)
      .toBe(fixture.source.transcript!.id);
    expect(await prisma.processingJob.count({ where: { projectId: fixture.project.id, type: "ANALYZE" } })).toBe(0);
  });

  it.each(["edit", "approval", "export"] as const)("refuses a late %s when analysis replaces the clip", async (kind) => {
    const fixture = await seed();
    const analysisJob = await prisma.processingJob.create({ data: {
      projectId: fixture.project.id, type: "ANALYZE", state: "RUNNING", idempotencyKey: randomUUID(),
    } });
    let saving: ReturnType<typeof observe<Response | undefined>> | undefined;
    const hooked = prisma.$extends({ query: { generatedClip: { async deleteMany({ args, query }) {
      if (args.where?.projectId === fixture.project.id && !saving) {
        saving = observe(writeRequest(fixture, kind));
        await waitForCompletionOrLock(saving.settled, tables[kind]);
      }
      return query(args);
    } } } });
    await localAnalysis()({ job: analysisJob, prisma: hooked as unknown as PrismaClient });
    const saved = await saving!.outcome;
    expect(saved.error).toBeUndefined();
    expect(saved.value?.status).toBe(409);
    expect(await saved.value?.json()).toMatchObject({ error: { code: "CLIP_TRANSCRIPT_CHANGED" } });
    expect(await prisma.generatedClip.findUnique({ where: { id: fixture.clip.id } })).toBeNull();
  });

  it("lets a source-locked post finish its project foreign-key check before analysis assesses it", async () => {
    const fixture = await seed();
    const analysisJob = await prisma.processingJob.create({ data: {
      projectId: fixture.project.id, type: "ANALYZE", state: "RUNNING", idempotencyKey: randomUUID(),
    } });
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const writer = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM source_videos WHERE id = ${fixture.source.id}::uuid FOR UPDATE`;
      entered();
      await released;
      // This FK takes KEY SHARE on the project. ANALYZE must not hold FOR UPDATE while
      // waiting for this source; NO KEY UPDATE permits the post to commit without a deadlock.
      await durableWrite(tx, fixture, "post");
    }, { timeout: 10000 });
    let analysis: ReturnType<typeof observe<Awaited<ReturnType<typeof runTranscribeJob>>>> | undefined;
    try {
      await Promise.race([started, writer]);
      analysis = observe(localAnalysis()({ job: analysisJob, prisma }));
      await waitForCompletionOrLock(analysis.settled, "source_videos");
    } finally {
      release();
      await writer;
    }
    expect((await analysis!.outcome).error).toMatchObject({ code: "REANALYSIS_BLOCKED", preservesProject: true });
    expect(await prisma.generatedClip.findUnique({ where: { id: fixture.clip.id } })).not.toBeNull();
  });

  it("pins rebuilt clips to the new revision and accepts current requests, while a sibling stays stale", async () => {
    const fixture = await seed();
    const sibling = await prisma.project.create({ data: {
      workspaceId: fixture.workspace.id, sourceVideoId: fixture.source.id, name: "Untouched sibling", status: "READY",
    } });
    await prisma.generatedClip.update({ where: { id: fixture.clip.id }, data: { projectId: sibling.id } });
    localSrt();
    await runTranscribeJob({ job: fixture.job, prisma });
    for (const kind of ["edit", "approval", "export"] as const) {
      expect((await writeRequest(fixture, kind))?.status).toBe(409);
    }
    const source = await prisma.sourceVideo.findUniqueOrThrow({ where: { id: fixture.source.id } });
    expect(source.transcriptRevision).toBe(fixture.source.transcriptRevision + 1);
    const analysisJob = await prisma.processingJob.findFirstOrThrow({ where: { projectId: fixture.project.id, type: "ANALYZE" } });
    await localAnalysis()({ job: analysisJob, prisma });
    const clip = await prisma.generatedClip.findFirstOrThrow({ where: { projectId: fixture.project.id } });
    expect(clip.transcriptRevision).toBe(source.transcriptRevision);
    const initial = await prisma.clipEdit.findFirstOrThrow({ where: { clipId: clip.id } });
    expect(initial.editorState).toMatchObject({ systemInitial: true });
    const response = await saveEdit(new Request("http://local.test/edit", { method: "PUT",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ baseVersion: initial.version, state: initial.editorState }),
    }), { params: Promise.resolve({ id: clip.id }) });
    expect(response?.status).toBe(200);
    for (const kind of ["approval", "export"] as const) {
      expect((await writeRequest({ ...fixture, clip }, kind))?.status).toBe(200);
    }
    expect((await prisma.generatedClip.findUniqueOrThrow({ where: { id: fixture.clip.id } })).transcriptRevision).toBe(0);
  });

  it("does not relabel old clips or allow an old worker to create clips against a new revision", async () => {
    const fixture = await seed();
    localSrt();
    await runTranscribeJob({ job: fixture.job, prisma });
    await expect(prisma.generatedClip.update({ where: { id: fixture.clip.id }, data: { transcriptRevision: 1 } }))
      .rejects.toThrow("CLIP_TRANSCRIPT_CHANGED");
    await expect(prisma.generatedClip.create({ data: {
      workspaceId: fixture.workspace.id, projectId: fixture.project.id, rank: 2,
      startMs: 0, endMs: 60000, title: "Old worker", summary: "Revision omitted by an old worker",
    } })).rejects.toThrow("CLIP_TRANSCRIPT_CHANGED");
  });
});
