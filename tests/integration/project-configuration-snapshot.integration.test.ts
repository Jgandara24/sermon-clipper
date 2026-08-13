import { AuthProvider, PrismaClient, SourceOrigin, WorkspaceRole } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setCandidateLimitOverride } from "@/lib/operations/candidate-limit-override";
import {
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
