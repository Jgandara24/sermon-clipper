import {
  AuthProvider,
  GeneratedClipStatus,
  PrismaClient,
  ProcessingJobState,
  SchedulePublishStatus,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildExportIdempotencyKey } from "@/lib/exports/edit-version";
import { assessFinalRender } from "@/lib/review/final-render-eligibility";
import { coordinateScheduledRenders } from "@/lib/review/render-coordinator";

const prisma = new PrismaClient();
let userId: string;
let workspaceId: string;
let serial = 0;

function nextDate() {
  serial += 1;
  return new Date(Date.UTC(2038, 0, serial));
}

async function createProject(label: string) {
  serial += 1;
  return prisma.project.create({
    data: { workspaceId, name: `Coordinator ${label} ${serial}`, series: "Sunday Mornings" },
  });
}

async function createClip(projectId: string, label: string) {
  serial += 1;
  return prisma.generatedClip.create({
    data: {
      workspaceId,
      projectId,
      rank: serial,
      startMs: 0,
      endMs: 60_000,
      title: `Coordinator ${label}`,
      summary: "Coordinator fixture.",
      status: GeneratedClipStatus.KEPT,
    },
  });
}

async function scheduleClip(
  projectId: string,
  clipId: string,
  publishStatus: SchedulePublishStatus = SchedulePublishStatus.NOT_STARTED,
) {
  return prisma.scheduledPost.create({
    data: { workspaceId, projectId, clipId, scheduledDate: nextDate(), publishStatus },
  });
}

const ON = { publishingEnabled: true };

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `coordinator-${Date.now()}@example.com`, authProvider: AuthProvider.DEV },
  });
  userId = user.id;
  const workspace = await prisma.workspace.create({
    data: { ownerId: user.id, name: "Render coordinator tests" },
  });
  workspaceId = workspace.id;
});

afterAll(async () => {
  if (workspaceId) {
    await prisma.publishAttempt.deleteMany({ where: { scheduledPost: { workspaceId } } });
    await prisma.workspace.delete({ where: { id: workspaceId } });
  }
  if (userId) await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("while the switch is off", () => {
  it("writes no job and no binding, and leaves the slot exactly as it was", async () => {
    const project = await createProject("switch off");
    const clip = await createClip(project.id, "switch off");
    const slot = await scheduleClip(project.id, clip.id);

    const outcome = await coordinateScheduledRenders(prisma, {
      projectId: project.id,
      publishingEnabled: false,
    });
    expect(outcome).toMatchObject({ enabled: false, slotsBound: 0, jobsCreated: 0 });

    expect(await prisma.exportJob.count({ where: { clipId: clip.id } })).toBe(0);
    await expect(
      prisma.scheduledPost.findUniqueOrThrow({ where: { id: slot.id } }),
    ).resolves.toMatchObject({ exportJobId: null });
  });
});

describe("binding a scheduled slot to its exact render", () => {
  it("enqueues one pinned render per unbound slot and writes the exact job id", async () => {
    const project = await createProject("six slots");
    const slots = [];
    for (let index = 0; index < 6; index += 1) {
      const clip = await createClip(project.id, `six-${index}`);
      slots.push(await scheduleClip(project.id, clip.id));
    }

    const outcome = await coordinateScheduledRenders(prisma, { projectId: project.id, ...ON });
    expect(outcome).toMatchObject({ enabled: true, slotsScanned: 6, slotsBound: 6, jobsCreated: 6 });
    expect(outcome.failures).toEqual([]);

    for (const slot of slots) {
      const bound = await prisma.scheduledPost.findUniqueOrThrow({
        where: { id: slot.id },
        include: { exportJob: true },
      });
      expect(bound.exportJobId).not.toBeNull();
      // The exact job for this slot's own clip, not merely the newest export in the workspace.
      expect(bound.exportJob?.clipId).toBe(bound.clipId);
      expect(bound.exportJob?.state).toBe(ProcessingJobState.QUEUED);
      // Nobody has edited these clips, so the pinned version is the machine's own document.
      expect(bound.exportJob?.editVersion).toBe(0);
    }
  });

  it("handles a three-slot project the same way", async () => {
    const project = await createProject("three slots");
    for (let index = 0; index < 3; index += 1) {
      const clip = await createClip(project.id, `three-${index}`);
      await scheduleClip(project.id, clip.id);
    }

    const outcome = await coordinateScheduledRenders(prisma, { projectId: project.id, ...ON });
    expect(outcome).toMatchObject({ slotsScanned: 3, slotsBound: 3, jobsCreated: 3 });
  });

  it("pins the newest saved edit, not version zero, once someone has edited", async () => {
    const project = await createProject("edited");
    const clip = await createClip(project.id, "edited");
    await prisma.clipEdit.create({
      data: { clipId: clip.id, version: 0, editorState: { systemInitial: true } },
    });
    await prisma.clipEdit.create({ data: { clipId: clip.id, version: 4, editorState: {} } });
    const slot = await scheduleClip(project.id, clip.id);

    await coordinateScheduledRenders(prisma, { projectId: project.id, ...ON });

    const bound = await prisma.scheduledPost.findUniqueOrThrow({
      where: { id: slot.id },
      include: { exportJob: true },
    });
    expect(bound.exportJob?.editVersion).toBe(4);
  });

  it("reuses a render that already exists rather than minting a second one", async () => {
    const project = await createProject("reuse");
    const clip = await createClip(project.id, "reuse");
    const manual = await prisma.exportJob.create({
      data: {
        workspaceId,
        clipId: clip.id,
        editVersion: 0,
        idempotencyKey: buildExportIdempotencyKey({ clipId: clip.id, editVersion: 0 }),
        filename: "manual.mp4",
      },
    });
    const slot = await scheduleClip(project.id, clip.id);

    const outcome = await coordinateScheduledRenders(prisma, { projectId: project.id, ...ON });
    // Bound, but nothing new was created: the manual render is the exact same identity.
    expect(outcome).toMatchObject({ slotsBound: 1, jobsCreated: 0 });
    await expect(
      prisma.scheduledPost.findUniqueOrThrow({ where: { id: slot.id } }),
    ).resolves.toMatchObject({ exportJobId: manual.id });
    expect(await prisma.exportJob.count({ where: { clipId: clip.id } })).toBe(1);
  });
});

describe("what the coordinator leaves alone", () => {
  it("enqueues nothing for a reserve, however highly ranked", async () => {
    const project = await createProject("reserves");
    const scheduled = await createClip(project.id, "scheduled");
    const reserveOne = await createClip(project.id, "reserve-1");
    const reserveTwo = await createClip(project.id, "reserve-2");
    await scheduleClip(project.id, scheduled.id);

    await coordinateScheduledRenders(prisma, { projectId: project.id, ...ON });

    expect(await prisma.exportJob.count({ where: { clipId: scheduled.id } })).toBe(1);
    expect(await prisma.exportJob.count({ where: { clipId: reserveOne.id } })).toBe(0);
    expect(await prisma.exportJob.count({ where: { clipId: reserveTwo.id } })).toBe(0);
  });

  it("skips a blocked, unfilled, missed, published or in-flight slot", async () => {
    const project = await createProject("states");
    const skipped: SchedulePublishStatus[] = [
      SchedulePublishStatus.BLOCKED,
      SchedulePublishStatus.UNFILLED,
      SchedulePublishStatus.MISSED,
      SchedulePublishStatus.SUCCEEDED,
      SchedulePublishStatus.IN_PROGRESS,
      SchedulePublishStatus.FAILED,
    ];
    const clips = [];
    for (const status of skipped) {
      const clip = await createClip(project.id, `state-${status}`);
      clips.push(clip);
      await scheduleClip(project.id, clip.id, status);
    }

    const outcome = await coordinateScheduledRenders(prisma, { projectId: project.id, ...ON });
    expect(outcome).toMatchObject({ slotsScanned: 0, slotsBound: 0, jobsCreated: 0 });
    for (const clip of clips) {
      expect(await prisma.exportJob.count({ where: { clipId: clip.id } })).toBe(0);
    }
  });

  it("finds nothing in a project whose pool was too thin to fill a slot", async () => {
    const project = await createProject("thin");
    await prisma.scheduledPost.create({
      data: {
        workspaceId,
        projectId: project.id,
        scheduledDate: nextDate(),
        publishStatus: SchedulePublishStatus.UNFILLED,
      },
    });

    const outcome = await coordinateScheduledRenders(prisma, { projectId: project.id, ...ON });
    expect(outcome).toMatchObject({ slotsScanned: 0, slotsBound: 0 });
  });
});

describe("idempotency and recovery", () => {
  it("catches a slot armed before the switch was on, exactly once", async () => {
    const project = await createProject("pre-existing");
    const clip = await createClip(project.id, "pre-existing");
    const slot = await scheduleClip(project.id, clip.id);

    // Armed while the switch was off: nothing was written for it then.
    await coordinateScheduledRenders(prisma, { projectId: project.id, publishingEnabled: false });
    expect(await prisma.exportJob.count({ where: { clipId: clip.id } })).toBe(0);

    const first = await coordinateScheduledRenders(prisma, { projectId: project.id, ...ON });
    expect(first).toMatchObject({ slotsBound: 1, jobsCreated: 1 });

    // And a second sweep finds nothing left to do, rather than minting a second render.
    const second = await coordinateScheduledRenders(prisma, { projectId: project.id, ...ON });
    expect(second).toMatchObject({ slotsScanned: 0, slotsBound: 0, jobsCreated: 0 });
    expect(await prisma.exportJob.count({ where: { clipId: clip.id } })).toBe(1);

    const bound = await prisma.scheduledPost.findUniqueOrThrow({ where: { id: slot.id } });
    expect(bound.exportJobId).not.toBeNull();
  });

  it("promotes only one render when two sweeps run at once", async () => {
    const project = await createProject("concurrent");
    const clip = await createClip(project.id, "concurrent");
    const slot = await scheduleClip(project.id, clip.id);

    const [a, b] = await Promise.all([
      coordinateScheduledRenders(prisma, { projectId: project.id, ...ON }),
      coordinateScheduledRenders(prisma, { projectId: project.id, ...ON }),
    ]);

    // Both reach the same job — the key is the clip and the edit version — so whichever writes
    // the binding second has nothing to correct.
    expect(await prisma.exportJob.count({ where: { clipId: clip.id } })).toBe(1);
    expect(a.failures.concat(b.failures)).toEqual([]);
    const bound = await prisma.scheduledPost.findUniqueOrThrow({ where: { id: slot.id } });
    expect(bound.exportJobId).not.toBeNull();
  });

  it("keeps going after one slot fails, and records the failure", async () => {
    const project = await createProject("partial failure");
    const healthy = await createClip(project.id, "healthy");
    const broken = await createClip(project.id, "broken");

    // A pre-existing export for a *different* edit version, plus a second slot that will collide
    // on the unique exportJobId binding, is the realistic way one item fails: the job exists but
    // the binding cannot be written because another slot already claimed that exact job.
    const shared = await prisma.exportJob.create({
      data: {
        workspaceId,
        clipId: broken.id,
        editVersion: 0,
        idempotencyKey: buildExportIdempotencyKey({ clipId: broken.id, editVersion: 0 }),
        filename: "shared.mp4",
      },
    });
    const decoy = await prisma.scheduledPost.create({
      data: {
        workspaceId,
        projectId: project.id,
        scheduledDate: nextDate(),
        publishStatus: SchedulePublishStatus.BLOCKED,
        exportJobId: shared.id,
      },
    });
    const brokenSlot = await scheduleClip(project.id, broken.id);
    const healthySlot = await scheduleClip(project.id, healthy.id);

    const outcome = await coordinateScheduledRenders(prisma, { projectId: project.id, ...ON });

    // The broken slot could not bind, and said so.
    expect(outcome.failures.map((failure) => failure.scheduledPostId)).toContain(brokenSlot.id);
    // The healthy slot after it still got its render.
    const bound = await prisma.scheduledPost.findUniqueOrThrow({ where: { id: healthySlot.id } });
    expect(bound.exportJobId).not.toBeNull();
    expect(await prisma.exportJob.count({ where: { clipId: healthy.id } })).toBe(1);

    await expect(
      prisma.operationalEvent.findFirst({
        where: {
          eventType: "scheduled_render_enqueue_failed",
          metadata: { path: ["scheduledPostId"], equals: brokenSlot.id },
        },
      }),
    ).resolves.not.toBeNull();

    await prisma.scheduledPost.delete({ where: { id: decoy.id } });
  });
});

describe("the final-render rule against real rows", () => {
  it("allows a scheduled clip and refuses its unscheduled sibling", async () => {
    const project = await createProject("eligibility");
    const scheduled = await createClip(project.id, "eligible");
    const reserve = await createClip(project.id, "ineligible");
    await scheduleClip(project.id, scheduled.id);

    await expect(
      assessFinalRender(prisma, { clipId: scheduled.id }, ON),
    ).resolves.toMatchObject({ allowed: true, reason: "SCHEDULED" });
    await expect(
      assessFinalRender(prisma, { clipId: reserve.id }, ON),
    ).resolves.toMatchObject({ allowed: false, reason: "UNSCHEDULED_RESERVE" });
  });

  it("refuses a clip whose only slot already published, and one whose date passed", async () => {
    const project = await createProject("terminal slots");
    const published = await createClip(project.id, "published");
    const missed = await createClip(project.id, "missed");
    await scheduleClip(project.id, published.id, SchedulePublishStatus.SUCCEEDED);
    await scheduleClip(project.id, missed.id, SchedulePublishStatus.MISSED);

    await expect(assessFinalRender(prisma, { clipId: published.id }, ON)).resolves.toMatchObject({
      allowed: false,
    });
    await expect(assessFinalRender(prisma, { clipId: missed.id }, ON)).resolves.toMatchObject({
      allowed: false,
    });
  });

  it("still allows a scheduled clip that no church has approved", async () => {
    // Rendering and publishing are different gates. An unapproved clip renders so a human can
    // review the exact file; P1.11 and P2.8 are what stop it reaching a page.
    const project = await createProject("unapproved");
    const clip = await createClip(project.id, "unapproved");
    await scheduleClip(project.id, clip.id);

    await expect(assessFinalRender(prisma, { clipId: clip.id }, ON)).resolves.toMatchObject({
      allowed: true,
    });
    expect(await prisma.clipApproval.count({ where: { clipId: clip.id } })).toBe(0);
  });
});
