import {
  AuthProvider,
  ClipApprovalState,
  ExportPreset,
  PrismaClient,
  ProcessingJobState,
  SourceOrigin,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auditLegacyExports,
  auditScheduledPostCollisions,
} from "@/lib/audits/preflight";

const prisma = new PrismaClient();
let userId: string;
let workspaceId: string;
const exportedFileIds: string[] = [];

function unique(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `${unique("preflight")}@example.test`, authProvider: AuthProvider.DEV },
  });
  userId = user.id;
  const workspace = await prisma.workspace.create({
    data: { name: "Preflight Audit", ownerId: user.id },
  });
  workspaceId = workspace.id;
  const source = await prisma.sourceVideo.create({
    data: { workspaceId, origin: SourceOrigin.UPLOAD, filename: "preflight.mp4" },
  });
  const project = await prisma.project.create({
    data: { workspaceId, sourceVideoId: source.id, name: "Preflight Project" },
  });

  const clips = await Promise.all(
    [1, 2, 3].map((rank) =>
      prisma.generatedClip.create({
        data: {
          workspaceId,
          projectId: project.id,
          rank,
          startMs: rank * 1_000,
          endMs: rank * 1_000 + 30_000,
          title: `Clip ${rank}`,
          summary: "Preflight fixture",
        },
      }),
    ),
  );

  for (const [index, clip] of clips.slice(0, 2).entries()) {
    const file = await prisma.exportedFile.create({
      data: {
        storageKey: `exports/preflight-${clip.id}.mp4`,
        bytes: BigInt(1_000 + index),
        width: 1080,
        height: 1920,
        checksum: unique("checksum"),
        downloadExpiresAt: new Date("2027-01-01T00:00:00.000Z"),
      },
    });
    exportedFileIds.push(file.id);
    await prisma.exportJob.create({
      data: {
        clipId: clip.id,
        workspaceId,
        preset: ExportPreset.MP4_1080,
        state: ProcessingJobState.SUCCEEDED,
        idempotencyKey: unique("legacy-export"),
        filename: `clip-${index + 1}.mp4`,
        outputFileId: file.id,
        finishedAt: new Date(),
      },
    });
  }

  const approval = await prisma.clipApproval.create({
    data: {
      workspaceId,
      clipId: clips[0].id,
      state: ClipApprovalState.DRAFT,
      reviewToken: unique("review"),
      reviewTokenExpiresAt: new Date("2027-01-01T00:00:00.000Z"),
    },
  });
  await prisma.clipApprovalAuditEvent.create({
    data: {
      approvalId: approval.id,
      workspaceId,
      eventType: "review_link_revoked",
      metadata: { reason: "clip_edited_after_approval" },
    },
  });

  const collisionDate = new Date("2026-09-01T00:00:00.000Z");
  await prisma.scheduledPost.create({
    data: {
      workspaceId,
      clipId: clips[0].id,
      scheduledDate: collisionDate,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    },
  });
  await prisma.scheduledPost.create({
    data: {
      workspaceId,
      clipId: clips[1].id,
      scheduledDate: new Date("2026-09-03T00:00:00.000Z"),
      createdAt: new Date("2026-08-02T00:00:00.000Z"),
    },
  });
  await prisma.scheduledPost.create({
    data: {
      workspaceId,
      clipId: clips[2].id,
      scheduledDate: new Date("2026-09-02T00:00:00.000Z"),
    },
  });
});

afterAll(async () => {
  if (workspaceId) await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {});
  if (exportedFileIds.length > 0) {
    await prisma.exportedFile.deleteMany({ where: { id: { in: exportedFileIds } } });
  }
  if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => {});
  await prisma.$disconnect();
});

describe("P0.15 preflight audits", () => {
  it("reports no duplicate active dates after the Wave 1 constraint", async () => {
    const result = await auditScheduledPostCollisions(prisma, { workspaceId });
    expect(result).toMatchObject({
      duplicateDateCount: 0,
      duplicateRowCount: 0,
      extraRowCount: 0,
      collisions: [],
    });
  });

  it("counts legacy exports and the rows they can still publish", async () => {
    await expect(auditLegacyExports(prisma, { workspaceId })).resolves.toMatchObject({
      succeededExportsWithoutProvableEditVersion: 2,
      armedScheduledPostsBackedOnlyByLegacyExports: 2,
      clipsWithDemotedApprovalsAndPublishableExports: 1,
    });
  });
});
