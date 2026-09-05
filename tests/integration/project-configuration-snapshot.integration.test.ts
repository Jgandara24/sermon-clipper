import { randomUUID } from "node:crypto";
import {
  AuthProvider,
  PrismaClient,
  SchedulePublishStatus,
  SourceOrigin,
  WorkspaceRole,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setCandidateLimitOverride } from "@/lib/operations/candidate-limit-override";
import {
  correctProjectServiceContext,
  createDraftProjectForWorkspace,
  createProjectFromUploadedSourceVideo,
  readProjectProcessingConfig,
} from "@/lib/project-service";
import { updateWorkspaceSettings } from "@/lib/workspace-settings";

const prisma = new PrismaClient();

let userId: string;
let workspaceId: string;

function uniqueKey(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function churchProfile(input: {
  sermonsPerWeek: 1 | 2;
  serviceDay?: string;
  secondServiceDay?: string | null;
}) {
  return {
    timezone: "UTC",
    serviceDay: input.serviceDay ?? "Sunday",
    sermonsPerWeek: input.sermonsPerWeek,
    secondServiceDay: input.secondServiceDay ?? null,
    postsPerDay: 1,
  };
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `${uniqueKey("project-snapshot")}@example.test`, authProvider: AuthProvider.DEV },
  });
  userId = user.id;
  const workspace = await prisma.workspace.create({
    data: {
      name: "Project Configuration Snapshot",
      ownerId: user.id,
      settings: { churchProfile: churchProfile({ sermonsPerWeek: 1 }) },
    },
  });
  workspaceId = workspace.id;
  await prisma.workspaceMember.create({
    data: { workspaceId, userId, role: WorkspaceRole.OWNER },
  });
});

afterAll(async () => {
  await prisma.workspace.delete({ where: { id: workspaceId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("project configuration snapshots", () => {
  it("snapshots one-service settings through the URL and channel-import path", async () => {
    await setCandidateLimitOverride(prisma, { workspaceId, candidateLimitOverride: 12 });
    const project = await createDraftProjectForWorkspace(
      prisma,
      workspaceId,
      {
        name: "Sunday URL Service",
        sourceUrl: "https://example.test/sunday-service",
        publishedAt: new Date("2026-08-09T12:00:00.000Z"),
      },
      userId,
    );

    expect(readProjectProcessingConfig(project.processingConfig)).toMatchObject({
      configurationVersion: 1,
      candidateLimit: 12,
      targetClipCount: 6,
      timezone: "UTC",
      serviceDay: "Sunday",
      secondServiceDay: null,
      sermonsPerWeek: 1,
      serviceOccurrence: "PRIMARY",
    });

    await updateWorkspaceSettings(prisma, workspaceId, (settings) => ({
      ...settings,
      churchProfile: churchProfile({
        sermonsPerWeek: 2,
        serviceDay: "Saturday",
        secondServiceDay: "Tuesday",
      }),
    }));
    await setCandidateLimitOverride(prisma, { workspaceId, candidateLimitOverride: 9 });

    const unchanged = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(readProjectProcessingConfig(unchanged.processingConfig)).toMatchObject({
      candidateLimit: 12,
      targetClipCount: 6,
      serviceDay: "Sunday",
      sermonsPerWeek: 1,
      serviceOccurrence: "PRIMARY",
    });
  });

  it("snapshots two-service settings through the upload path", async () => {
    const currentWeekday = new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      timeZone: "UTC",
    }).format(new Date());
    await updateWorkspaceSettings(prisma, workspaceId, (settings) => ({
      ...settings,
      churchProfile: churchProfile({
        sermonsPerWeek: 2,
        serviceDay: currentWeekday === "Sunday" ? "Monday" : "Sunday",
        secondServiceDay: currentWeekday,
      }),
    }));
    await setCandidateLimitOverride(prisma, { workspaceId, candidateLimitOverride: 9 });
    const sourceVideo = await prisma.sourceVideo.create({
      data: {
        workspaceId,
        origin: SourceOrigin.UPLOAD,
        filename: "two-service.mp4",
        storageKey: uniqueKey("two-service"),
      },
    });

    const project = await createProjectFromUploadedSourceVideo(
      prisma,
      workspaceId,
      { name: "Second Weekly Service", sourceVideoId: sourceVideo.id },
      userId,
    );

    expect(readProjectProcessingConfig(project.processingConfig)).toMatchObject({
      configurationVersion: 1,
      candidateLimit: 9,
      targetClipCount: 3,
      timezone: "UTC",
      secondServiceDay: currentWeekday,
      sermonsPerWeek: 2,
      serviceOccurrence: "SECONDARY",
    });
  });
});

describe("service context capture and correction (P1.10)", () => {
  async function uploadedProject(overrides: {
    sermonDate?: Date;
    serviceOccurrence?: "PRIMARY" | "SECONDARY" | "UNMATCHED";
  }) {
    await updateWorkspaceSettings(prisma, workspaceId, (settings) => ({
      ...settings,
      churchProfile: churchProfile({ sermonsPerWeek: 2, serviceDay: "Sunday", secondServiceDay: "Wednesday" }),
    }));
    const sourceVideo = await prisma.sourceVideo.create({
      data: {
        workspaceId,
        origin: SourceOrigin.UPLOAD,
        filename: "stated.mp4",
        storageKey: uniqueKey("stated"),
      },
    });
    return createProjectFromUploadedSourceVideo(
      prisma,
      workspaceId,
      { name: `Stated ${uniqueKey("p")}`, sourceVideoId: sourceVideo.id, ...overrides },
      userId,
    );
  }

  it("stores the stated service date rather than the upload time", async () => {
    const project = await uploadedProject({ sermonDate: new Date("2026-07-19T00:00:00.000Z") });
    expect(project.sermonDate?.toISOString()).toBe("2026-07-19T00:00:00.000Z");
    expect(project.serviceSlot).toBe("PRIMARY");
  });

  it("derives the occurrence from the stated date when the uploader does not pick one", async () => {
    const project = await uploadedProject({ sermonDate: new Date("2026-07-22T00:00:00.000Z") });
    expect(project.serviceSlot).toBe("SECONDARY");
  });

  it("records a stated special service as UNMATCHED, snapshot included", async () => {
    const project = await uploadedProject({
      sermonDate: new Date("2026-07-19T00:00:00.000Z"),
      serviceOccurrence: "UNMATCHED",
    });
    expect(project.serviceSlot).toBe("UNMATCHED");
    expect(readProjectProcessingConfig(project.processingConfig).serviceOccurrence).toBe("UNMATCHED");
  });

  it("corrects both the column and the snapshot, so scheduling sees the change", async () => {
    const project = await uploadedProject({ sermonDate: new Date("2026-07-19T00:00:00.000Z") });

    const result = await correctProjectServiceContext(prisma, {
      projectId: project.id,
      workspaceId,
      sermonDate: new Date("2026-07-22T00:00:00.000Z"),
      serviceOccurrence: "SECONDARY",
    });
    expect(result.ok).toBe(true);

    const corrected = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(corrected.sermonDate?.toISOString()).toBe("2026-07-22T00:00:00.000Z");
    expect(corrected.serviceSlot).toBe("SECONDARY");
    // P1.9 schedules from the snapshot, so a correction that missed it would do nothing.
    expect(readProjectProcessingConfig(corrected.processingConfig).serviceOccurrence).toBe("SECONDARY");
  });

  it("is the remedy for a legacy project misfiled as PRIMARY before P1.8", async () => {
    const project = await uploadedProject({ sermonDate: new Date("2026-07-19T00:00:00.000Z") });
    // Simulate the pre-P1.8 record: a Tuesday service filed as the Sunday one.
    await prisma.project.update({
      where: { id: project.id },
      data: { sermonDate: new Date("2026-07-21T00:00:00.000Z"), serviceSlot: "PRIMARY" },
    });

    await correctProjectServiceContext(prisma, {
      projectId: project.id,
      workspaceId,
      sermonDate: new Date("2026-07-21T00:00:00.000Z"),
      serviceOccurrence: "UNMATCHED",
    });

    const corrected = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(corrected.serviceSlot).toBe("UNMATCHED");
  });

  it("refuses a correction once a slot has published, and changes nothing", async () => {
    const project = await uploadedProject({ sermonDate: new Date("2026-07-19T00:00:00.000Z") });
    await prisma.scheduledPost.create({
      data: {
        workspaceId,
        projectId: project.id,
        scheduledDate: new Date("2026-07-20T00:00:00.000Z"),
        publishStatus: SchedulePublishStatus.SUCCEEDED,
      },
    });

    const result = await correctProjectServiceContext(prisma, {
      projectId: project.id,
      workspaceId,
      sermonDate: new Date("2026-07-22T00:00:00.000Z"),
      serviceOccurrence: "SECONDARY",
    });

    expect(result).toEqual({ ok: false, reason: "durable_work" });
    const unchanged = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(unchanged.sermonDate?.toISOString()).toBe("2026-07-19T00:00:00.000Z");
    expect(unchanged.serviceSlot).toBe("PRIMARY");
  });

  it("reports another workspace's project as missing rather than as forbidden", async () => {
    const project = await uploadedProject({ sermonDate: new Date("2026-07-19T00:00:00.000Z") });
    // Any workspace id that is not this project's exercises the ownership guard.
    const result = await correctProjectServiceContext(prisma, {
      projectId: project.id,
      workspaceId: randomUUID(),
      sermonDate: new Date("2026-07-22T00:00:00.000Z"),
      serviceOccurrence: "SECONDARY",
    });

    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});
