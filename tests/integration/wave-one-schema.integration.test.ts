import {
  AuthProvider,
  EditorialExceptionState,
  GeneratedClipStatus,
  PrismaClient,
  ProcessingJobState,
  SchedulePublishStatus,
  ServiceSlot,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const prisma = new PrismaClient();
let userId: string;
let workspaceId: string;
let serial = 0;

function nextDate() {
  serial += 1;
  return new Date(Date.UTC(2035, 0, serial));
}

async function createProject(label: string, serviceSlot: ServiceSlot = ServiceSlot.PRIMARY) {
  return prisma.project.create({
    data: { workspaceId, name: `Wave 1 ${label} ${serial}`, serviceSlot },
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
      endMs: 10_000,
      title: `Wave 1 ${label}`,
      summary: "Wave 1 schema fixture.",
      status: GeneratedClipStatus.KEPT,
    },
  });
}

async function createExport(clipId: string, label: string, editVersion?: number) {
  serial += 1;
  return prisma.exportJob.create({
    data: {
      workspaceId,
      clipId,
      state: ProcessingJobState.SUCCEEDED,
      idempotencyKey: `wave-one-${label}-${serial}`,
      filename: `${label}.mp4`,
      editVersion,
    },
  });
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `wave-one-${Date.now()}@example.com`, authProvider: AuthProvider.DEV },
  });
  userId = user.id;
  const workspace = await prisma.workspace.create({
    data: { ownerId: user.id, name: "Wave 1 schema tests" },
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

describe("agentic editor Wave 1 schema", () => {
  it("keeps historical export identity and QC fields null", async () => {
    const project = await createProject("legacy export");
    const clip = await createClip(project.id, "legacy export");
    const legacy = await createExport(clip.id, "legacy-export");

    expect(legacy.editVersion).toBeNull();
    expect(legacy.priority).toBe(0);
    expect(legacy.qcStatus).toBeNull();
    expect(legacy.qcChecksum).toBeNull();
  });

  it("binds one export to one slot and clears the binding when the export is deleted", async () => {
    const project = await createProject("export binding");
    const firstClip = await createClip(project.id, "first bound clip");
    const secondClip = await createClip(project.id, "second bound clip");
    const exportJob = await createExport(firstClip.id, "bound-export", 0);
    const firstSlot = await prisma.scheduledPost.create({
      data: {
        workspaceId,
        projectId: project.id,
        clipId: firstClip.id,
        exportJobId: exportJob.id,
        scheduledDate: nextDate(),
      },
    });

    await expect(
      prisma.scheduledPost.create({
        data: {
          workspaceId,
          projectId: project.id,
          clipId: secondClip.id,
          exportJobId: exportJob.id,
          scheduledDate: nextDate(),
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    await prisma.exportJob.delete({ where: { id: exportJob.id } });
    await expect(
      prisma.scheduledPost.findUniqueOrThrow({ where: { id: firstSlot.id } }),
    ).resolves.toMatchObject({ exportJobId: null, clipId: firstClip.id, projectId: project.id });
  });

  it("round-trips UNMATCHED and preserves a detached historical slot", async () => {
    const project = await createProject("unmatched", ServiceSlot.UNMATCHED);
    const clip = await createClip(project.id, "detached clip");
    const slot = await prisma.scheduledPost.create({
      data: { workspaceId, projectId: project.id, clipId: clip.id, scheduledDate: nextDate() },
    });

    await expect(prisma.project.findUniqueOrThrow({ where: { id: project.id } })).resolves.toMatchObject({
      serviceSlot: ServiceSlot.UNMATCHED,
    });
    await prisma.project.delete({ where: { id: project.id } });
    await expect(prisma.scheduledPost.findUniqueOrThrow({ where: { id: slot.id } })).resolves.toMatchObject({
      projectId: null,
      clipId: null,
    });
  });

  it("retains exception snapshots after resolution and live-row deletion", async () => {
    const project = await createProject("exception");
    const slot = await prisma.scheduledPost.create({
      data: { workspaceId, projectId: project.id, scheduledDate: nextDate(), publishStatus: "UNFILLED" },
    });
    const exception = await prisma.editorialException.create({
      data: {
        workspaceId,
        projectId: project.id,
        scheduledPostId: slot.id,
        exceptionType: "unfilled_slot",
        message: "No eligible clip is available.",
        projectSnapshot: { projectId: project.id, name: project.name },
        slotSnapshot: { scheduledPostId: slot.id, scheduledDate: slot.scheduledDate.toISOString() },
      },
    });

    const resolved = await prisma.editorialException.update({
      where: { id: exception.id },
      data: {
        state: EditorialExceptionState.RESOLVED,
        resolvedAt: new Date(),
        resolvedByUserId: userId,
        resolutionReason: "Operator supplied a clip.",
      },
    });
    expect(resolved.state).toBe(EditorialExceptionState.RESOLVED);

    await prisma.scheduledPost.delete({ where: { id: slot.id } });
    await prisma.project.delete({ where: { id: project.id } });
    const retained = await prisma.editorialException.findUniqueOrThrow({ where: { id: exception.id } });
    expect(retained.projectId).toBeNull();
    expect(retained.scheduledPostId).toBeNull();
    expect(retained.projectSnapshot).toEqual({ projectId: project.id, name: project.name });
    expect(retained.slotSnapshot).toMatchObject({ scheduledPostId: slot.id });
  });

  it("retains publish intent snapshots when the expected clip and export disappear", async () => {
    const project = await createProject("publish intent");
    const clip = await createClip(project.id, "publish intent clip");
    const exportJob = await createExport(clip.id, "publish-intent", 0);
    const slot = await prisma.scheduledPost.create({
      data: {
        workspaceId,
        projectId: project.id,
        clipId: clip.id,
        exportJobId: exportJob.id,
        scheduledDate: nextDate(),
      },
    });
    const attempt = await prisma.publishAttempt.create({
      data: {
        scheduledPostId: slot.id,
        expectedClipId: clip.id,
        expectedExportJobId: exportJob.id,
      },
    });

    await prisma.generatedClip.delete({ where: { id: clip.id } });
    const retained = await prisma.publishAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(retained.expectedClipId).toBe(clip.id);
    expect(retained.expectedExportJobId).toBe(exportJob.id);
    await expect(prisma.scheduledPost.findUniqueOrThrow({ where: { id: slot.id } })).resolves.toMatchObject({
      clipId: null,
      exportJobId: null,
    });
  });

  it("lets only MISSED rows share a workspace date", async () => {
    const reservingStatuses = [
      SchedulePublishStatus.NOT_STARTED,
      SchedulePublishStatus.IN_PROGRESS,
      SchedulePublishStatus.SUCCEEDED,
      SchedulePublishStatus.FAILED,
      SchedulePublishStatus.BLOCKED,
      SchedulePublishStatus.UNFILLED,
    ];

    for (const status of reservingStatuses) {
      const date = nextDate();
      await prisma.scheduledPost.create({ data: { workspaceId, scheduledDate: date, publishStatus: status } });
      await prisma.scheduledPost.create({
        data: { workspaceId, scheduledDate: date, publishStatus: SchedulePublishStatus.MISSED },
      });
      await expect(
        prisma.scheduledPost.create({
          data: { workspaceId, scheduledDate: date, publishStatus: SchedulePublishStatus.NOT_STARTED },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
    }

    const releasedDate = nextDate();
    await prisma.scheduledPost.createMany({
      data: [
        { workspaceId, scheduledDate: releasedDate, publishStatus: SchedulePublishStatus.MISSED },
        { workspaceId, scheduledDate: releasedDate, publishStatus: SchedulePublishStatus.MISSED },
      ],
    });
    await expect(
      prisma.scheduledPost.create({
        data: { workspaceId, scheduledDate: releasedDate, publishStatus: SchedulePublishStatus.NOT_STARTED },
      }),
    ).resolves.toMatchObject({ publishStatus: SchedulePublishStatus.NOT_STARTED });
  });

  it("stores a direct clip attribution on operational events", async () => {
    const project = await createProject("event attribution");
    const clip = await createClip(project.id, "event attribution clip");
    const event = await prisma.operationalEvent.create({
      data: {
        workspaceId,
        projectId: project.id,
        clipId: clip.id,
        category: "cost",
        eventType: "processing_cost_fact",
        message: "Attributed Wave 1 fact.",
      },
    });
    expect(event.clipId).toBe(clip.id);
  });
});
