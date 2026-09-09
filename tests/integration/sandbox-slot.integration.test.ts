import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareSandboxSlot } from "@/lib/operations/sandbox-slot";
import type { SandboxSlotInput } from "@/lib/operations/sandbox-slot-input";
import { HUMAN_REFERENCE_PROGRAM_KEY } from "@/lib/review/program-key";

const prisma = new PrismaClient();
const runtime = { AUTOMATIC_PUBLISHING_ENABLED: "false", AUTOMATIC_SCHEDULE_ARMING_ENABLED: "false" };
const options = { runtime, now: new Date("2026-09-09T12:00:00Z"), sourceExists: async () => true };
let operatorId: string;
const workspaceIds: string[] = [];

beforeAll(async () => {
  // These fixtures insert rows. Never run this file against a remote database.
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Use a local test database.");
  operatorId = (await prisma.user.create({ data: {
    email: `sandbox-${randomUUID()}@example.com`, authProvider: "DEV", isPlatformOperator: true,
  } })).id;
});
afterAll(async () => {
  if (operatorId) {
    await prisma.operationalEvent.deleteMany({ where: { eventType: "sandbox_slot_prepared",
      metadata: { path: ["operatorUserId"], equals: operatorId } } });
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma.user.delete({ where: { id: operatorId } });
  }
  await prisma.$disconnect();
});

async function fixture(): Promise<SandboxSlotInput & { sourceId: string; reserveId: string }> {
  const workspace = await prisma.workspace.create({ data: {
    ownerId: operatorId, name: "Dedicated sandbox fixture",
    settings: { churchProfile: { timezone: "America/Chicago", serviceDay: "Sunday", sermonsPerWeek: 1 } },
  } });
  workspaceIds.push(workspace.id);
  const source = await prisma.sourceVideo.create({ data: {
    workspaceId: workspace.id, origin: "UPLOAD", storageKey: `src/${workspace.id}/test.mp4`, durationS: 200,
    transcript: { create: { language: "en", provider: "elevenlabs_scribe_v2", fullText: "Test words.",
      segments: { create: { idx: 0, startMs: 0, endMs: 200_000, text: "Test words." } } } },
  } });
  const project = await prisma.project.create({ data: {
    workspaceId: workspace.id, sourceVideoId: source.id, name: "P2 fixture", status: "READY",
  } });
  const clips = [];
  for (const rank of [1, 2, 3]) {
    clips.push(await prisma.generatedClip.create({ data: {
      workspaceId: workspace.id, projectId: project.id, rank, title: `Clip ${rank}`, summary: "Fixture.",
      startMs: (rank - 1) * 40_000, endMs: rank * 40_000, status: "SUGGESTED",
      edits: { create: { version: 1, editorState: { systemInitial: true } } },
    } }));
  }
  return { operatorUserId: operatorId, workspaceId: workspace.id, projectId: project.id, clipId: clips[0].id,
    sourceId: source.id, reserveId: clips[1].id, date: "2026-09-10", apply: false };
}

function input(f: Awaited<ReturnType<typeof fixture>>): SandboxSlotInput {
  return { operatorUserId: f.operatorUserId, workspaceId: f.workspaceId, projectId: f.projectId,
    clipId: f.clipId, date: f.date, apply: f.apply };
}

async function apply(f: Awaited<ReturnType<typeof fixture>>, confirmation: string) {
  return prepareSandboxSlot(prisma, { ...input(f), apply: true, confirmation,
    confirmedSandboxWorkspaceId: f.workspaceId }, options);
}

async function writeCounts(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    slots: await prisma.scheduledPost.count({ where: { workspaceId: f.workspaceId } }),
    jobs: await prisma.processingJob.count({ where: { projectId: f.projectId } }),
    exports: await prisma.exportJob.count({ where: { workspaceId: f.workspaceId } }),
    reviews: await prisma.clipReview.count({ where: { projectIdSnapshot: f.projectId } }),
    audits: await prisma.operationalEvent.count({ where: { eventType: "sandbox_slot_prepared",
      metadata: { path: ["projectId"], equals: f.projectId } } }),
  };
}

describe("one explicit sandbox slot", () => {
  it("reads without writes, then creates one unbound slot and a private audit; reserves stay unrendered", async () => {
    const f = await fixture();
    const before = await writeCounts(f);
    const workspaceBefore = await prisma.workspace.findUniqueOrThrow({ where: { id: f.workspaceId } });
    const preview = await prepareSandboxSlot(prisma, input(f), options);
    expect(preview).toMatchObject({ applied: false, scheduledPostId: null,
      plan: { reserve: { id: f.reserveId, rank: 2 }, expiresAt: null } });
    expect(await writeCounts(f)).toEqual(before);
    const result = await apply(f, preview.confirmation);
    expect(await prisma.scheduledPost.findUnique({ where: { id: result.scheduledPostId! } }))
      .toMatchObject({ projectId: f.projectId, clipId: f.clipId, platform: "FACEBOOK",
        publishStatus: "NOT_STARTED", exportJobId: null, scheduledDate: new Date("2026-09-10T00:00:00Z") });
    expect(await writeCounts(f)).toEqual({ slots: 1, jobs: 0, exports: 0, reviews: 0, audits: 1 });
    expect(await prisma.operationalEvent.findFirst({ where: { eventType: "sandbox_slot_prepared",
      metadata: { path: ["projectId"], equals: f.projectId } } }))
      .toMatchObject({ workspaceId: null, projectId: null, metadata: { operatorUserId: operatorId, reserveClipId: f.reserveId } });
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: f.workspaceId } })).settings).toEqual(workspaceBefore.settings);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: f.projectId } })).expiresAt).toBeNull();
    await expect(apply(f, preview.confirmation)).rejects.toMatchObject({ code: "SERVICE_ALREADY_SCHEDULED" });
    expect((await writeCounts(f)).slots).toBe(1);
  });

  it("refuses a workspace owner who is not a platform operator", async () => {
    const f = await fixture();
    const user = await prisma.user.create({ data: { email: `owner-${randomUUID()}@example.com`, authProvider: "DEV" } });
    await prisma.workspace.update({ where: { id: f.workspaceId }, data: { ownerId: user.id } });
    await expect(prepareSandboxSlot(prisma, { ...input(f), operatorUserId: user.id }, options))
      .rejects.toMatchObject({ name: "PlatformOperatorAuthorizationError" });
    expect((await writeCounts(f)).slots).toBe(0);
  });

  it("refuses a forged project/workspace combination", async () => {
    const a = await fixture(); const b = await fixture();
    await expect(prepareSandboxSlot(prisma, { ...input(a), workspaceId: b.workspaceId }, options))
      .rejects.toMatchObject({ code: "PROJECT_MISSING" });
  });

  it.each(["AUTOMATIC_PUBLISHING_ENABLED", "AUTOMATIC_SCHEDULE_ARMING_ENABLED"])("refuses %s when enabled", async (flag) => {
    const f = await fixture();
    await expect(prepareSandboxSlot(prisma, input(f), { ...options, runtime: { ...runtime, [flag]: "true" } }))
      .rejects.toMatchObject({ code: "AUTOMATION_NOT_OFF" });
    expect((await writeCounts(f)).slots).toBe(0);
  });

  it.each(["whisper_cpp", "unknown"])("refuses transcript provider %s", async (provider) => {
    const f = await fixture();
    await prisma.transcript.update({ where: { sourceVideoId: f.sourceId }, data: { provider } });
    await expect(prepareSandboxSlot(prisma, input(f), options)).rejects.toMatchObject({ code: "PRIMARY_TRANSCRIPT_REQUIRED" });
  });

  it("keeps a transcription hold open, even if a primary transcript is present", async () => {
    const f = await fixture();
    const hold = await prisma.editorialException.create({ data: { workspaceId: f.workspaceId,
      projectId: f.projectId, exceptionType: "transcription_provider_fallback", message: "Fixture hold." } });
    await expect(prepareSandboxSlot(prisma, input(f), options)).rejects.toMatchObject({ code: "TRANSCRIPTION_HOLD" });
    expect((await prisma.editorialException.findUniqueOrThrow({ where: { id: hold.id } })).state).toBe("OPEN");
    expect(await writeCounts(f)).toEqual({ slots: 0, jobs: 0, exports: 0, reviews: 0, audits: 0 });
  });

  it("refuses a missing source object", async () => {
    const f = await fixture();
    await expect(prepareSandboxSlot(prisma, input(f), { ...options, sourceExists: async () => false }))
      .rejects.toMatchObject({ code: "SOURCE_MISSING" });
  });

  it("checks storage again at apply and leaves no slot when the source disappears", async () => {
    const f = await fixture();
    const preview = await prepareSandboxSlot(prisma, input(f), options);
    await expect(prepareSandboxSlot(prisma, { ...input(f), apply: true,
      confirmation: preview.confirmation, confirmedSandboxWorkspaceId: f.workspaceId },
    { ...options, sourceExists: async () => false })).rejects.toMatchObject({ code: "SOURCE_MISSING" });
    expect(await writeCounts(f)).toEqual({ slots: 0, jobs: 0, exports: 0, reviews: 0, audits: 0 });
  });

  it("refuses waiting processing work and does not start it", async () => {
    const f = await fixture();
    const job = await prisma.processingJob.create({ data: {
      projectId: f.projectId, type: "ANALYZE", state: "WAITING",
      idempotencyKey: `sandbox-wait-${randomUUID()}`,
    } });
    await expect(prepareSandboxSlot(prisma, input(f), options)).rejects.toMatchObject({ code: "PROCESSING_ACTIVE" });
    expect((await prisma.processingJob.findUniqueOrThrow({ where: { id: job.id } })).state).toBe("WAITING");
    expect((await writeCounts(f)).slots).toBe(0);
  });

  it("does not use hidden clips or another service to supply the reserve", async () => {
    const f = await fixture(); await fixture();
    await prisma.generatedClip.updateMany({ where: { projectId: f.projectId, id: { not: f.clipId } }, data: { status: "HIDDEN" } });
    await expect(prepareSandboxSlot(prisma, input(f), options)).rejects.toMatchObject({ code: "NO_RESERVE" });
  });

  it("does not promise a later reserve when REPLACE would choose an invalid earlier range", async () => {
    const f = await fixture();
    // Rank 3 is valid, but the replacement policy would choose retained rank 2 first.
    await prisma.generatedClip.update({ where: { id: f.reserveId }, data: { endMs: 250_000 } });
    await expect(prepareSandboxSlot(prisma, input(f), options)).rejects.toMatchObject({ code: "RESERVE_INELIGIBLE" });
    expect((await writeCounts(f)).slots).toBe(0);
  });

  it("refuses saved human edits and keeps them intact", async () => {
    const f = await fixture();
    await prisma.clipEdit.create({ data: { clipId: f.clipId, version: 2, editorState: { captions: "human change" } } });
    await expect(prepareSandboxSlot(prisma, input(f), options)).rejects.toMatchObject({ code: "DURABLE_WORK" });
    expect(await prisma.clipEdit.count({ where: { clipId: f.clipId } })).toBe(2);
  });

  it.each(["2026-09-08", "2026-09-13"])("refuses unavailable date %s", async (date) => {
    const f = await fixture();
    await expect(prepareSandboxSlot(prisma, { ...input(f), date }, options)).rejects.toMatchObject({
      code: date.endsWith("08") ? "DATE_IN_PAST" : "SUNDAY",
    });
  });

  it("refuses an occupied workspace date", async () => {
    const f = await fixture();
    await prisma.scheduledPost.create({ data: { workspaceId: f.workspaceId, scheduledDate: new Date("2026-09-10T00:00:00Z") } });
    await expect(prepareSandboxSlot(prisma, input(f), options)).rejects.toMatchObject({ code: "DATE_TAKEN" });
  });

  it("rejects a changed range after dry-run", async () => {
    const f = await fixture();
    const preview = await prepareSandboxSlot(prisma, input(f), options);
    await prisma.generatedClip.update({ where: { id: f.clipId }, data: { endMs: 39_000 } });
    await expect(apply(f, preview.confirmation)).rejects.toMatchObject({ code: "PLAN_CHANGED" });
    expect((await writeCounts(f)).slots).toBe(0);
  });

  it("serializes competing applications so only one slot and audit exist", async () => {
    const f = await fixture();
    const preview = await prepareSandboxSlot(prisma, input(f), options);
    const results = await Promise.allSettled([apply(f, preview.confirmation), apply(f, preview.confirmation)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await writeCounts(f)).toEqual({ slots: 1, jobs: 0, exports: 0, reviews: 0, audits: 1 });
  });

  it("rolls back the slot when its audit insert fails", async () => {
    const f = await fixture();
    const preview = await prepareSandboxSlot(prisma, input(f), options);
    // The trigger affects this fixture only. It forces a failure after the slot insert,
    // testing the transaction rather than a mocked successful result.
    const suffix = randomUUID().replaceAll("-", "");
    const name = `test_sandbox_audit_${suffix}`;
    await prisma.$executeRawUnsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'sandbox_slot_prepared' AND NEW.metadata->>'projectId' = '${f.projectId}' THEN
          RAISE EXCEPTION 'fixture audit failure';
        END IF;
        RETURN NEW;
      END; $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON operational_events FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    try {
      await expect(apply(f, preview.confirmation)).rejects.toThrow();
      expect(await writeCounts(f)).toEqual({ slots: 0, jobs: 0, exports: 0, reviews: 0, audits: 0 });
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER ${name} ON operational_events`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION ${name}()`);
    }
  });

  it("extends an existing source expiry without changing settings", async () => {
    const f = await fixture();
    await prisma.project.update({ where: { id: f.projectId }, data: { expiresAt: new Date("2026-09-12T00:00:00Z") } });
    const preview = await prepareSandboxSlot(prisma, input(f), options);
    expect(preview.plan.expiresAt).toBe("2026-09-24T00:00:00.000Z");
    await apply(f, preview.confirmation);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: f.projectId } })).expiresAt?.toISOString())
      .toBe("2026-09-24T00:00:00.000Z");
  });

  it("refuses a started program without changing its state", async () => {
    const f = await fixture();
    const previous = await prisma.editorialProgram.findUnique({ where: { key: HUMAN_REFERENCE_PROGRAM_KEY } });
    // Preserve a shared local suite's row. This test does not call program:start.
    await prisma.editorialProgram.upsert({ where: { key: HUMAN_REFERENCE_PROGRAM_KEY },
      create: { key: HUMAN_REFERENCE_PROGRAM_KEY, state: "ACTIVE", startedAt: options.now },
      update: { state: "ACTIVE", startedAt: options.now } });
    try {
      await expect(prepareSandboxSlot(prisma, input(f), options)).rejects.toMatchObject({ code: "PROGRAM_STARTED" });
      expect((await writeCounts(f)).slots).toBe(0);
    } finally {
      if (previous) await prisma.editorialProgram.update({ where: { key: previous.key }, data: { state: previous.state, startedAt: previous.startedAt } });
      else await prisma.editorialProgram.delete({ where: { key: HUMAN_REFERENCE_PROGRAM_KEY } });
    }
  });
});
