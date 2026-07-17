import {
  AuthProvider,
  GeneratedClipStatus,
  PrismaClient,
  ProcessingJobState,
  ProjectStatus,
  WorkspaceRole,
} from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { checkExportJobLimits, checkUploadPresignLimit } from "@/lib/rate-limit";

const prisma = new PrismaClient();

const NOW = new Date();
const HOUR_MS = 60 * 60 * 1000;

let userId: string;
let workspaceId: string;
let otherWorkspaceId: string;
let clipId: string;

function uniqueKey(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function createExportJob(options: { state: ProcessingJobState; createdAt?: Date; workspace?: string }) {
  return prisma.exportJob.create({
    data: {
      clipId,
      workspaceId: options.workspace ?? workspaceId,
      state: options.state,
      idempotencyKey: uniqueKey("rate-limit-export"),
      filename: "rate-limit-test.mp4",
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    },
  });
}

async function recordPresignEvent(options: { createdAt?: Date; workspace?: string }) {
  return prisma.operationalEvent.create({
    data: {
      workspaceId: options.workspace ?? workspaceId,
      category: "upload",
      eventType: "upload_presigned",
      severity: "info",
      message: "Signed upload URL issued.",
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    },
  });
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `${uniqueKey("rate-limit")}@example.com`, authProvider: AuthProvider.DEV },
  });
  userId = user.id;
  const workspace = await prisma.workspace.create({
    data: { name: "Rate Limits", ownerId: user.id },
  });
  workspaceId = workspace.id;
  const other = await prisma.workspace.create({
    data: { name: "Rate Limits Other", ownerId: user.id },
  });
  otherWorkspaceId = other.id;
  await prisma.workspaceMember.create({
    data: { workspaceId, userId, role: WorkspaceRole.OWNER },
  });
  const project = await prisma.project.create({
    data: { workspaceId, name: "Rate Limit Project", status: ProjectStatus.READY },
  });
  const clip = await prisma.generatedClip.create({
    data: {
      workspaceId,
      projectId: project.id,
      rank: 1,
      startMs: 0,
      endMs: 10_000,
      title: "Rate limit clip",
      summary: "Clip used by rate limit tests.",
      status: GeneratedClipStatus.SUGGESTED,
    },
  });
  clipId = clip.id;
});

afterEach(async () => {
  await prisma.exportJob.deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } });
  await prisma.operationalEvent.deleteMany({
    where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } },
  });
  delete process.env.EXPORT_MAX_CONCURRENT_JOBS;
  delete process.env.EXPORT_DAILY_JOB_LIMIT;
  delete process.env.UPLOAD_PRESIGN_HOURLY_LIMIT;
});

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } }).catch(() => {});
  await prisma.user.delete({ where: { id: userId } }).catch(() => {});
  await prisma.$disconnect();
});

describe("export job limits", () => {
  it("allows exports below both caps", async () => {
    process.env.EXPORT_MAX_CONCURRENT_JOBS = "2";
    await createExportJob({ state: ProcessingJobState.RUNNING });

    const decision = await checkExportJobLimits(prisma, workspaceId, NOW);

    expect(decision.allowed).toBe(true);
  });

  it("rejects when the concurrent cap is reached, counting only active states", async () => {
    process.env.EXPORT_MAX_CONCURRENT_JOBS = "2";
    await createExportJob({ state: ProcessingJobState.QUEUED });
    await createExportJob({ state: ProcessingJobState.RUNNING });
    await createExportJob({ state: ProcessingJobState.SUCCEEDED });
    await createExportJob({ state: ProcessingJobState.FAILED });

    const decision = await checkExportJobLimits(prisma, workspaceId, NOW);

    expect(decision).toMatchObject({ allowed: false, reason: "export_concurrent_limit", limit: 2, current: 2 });
  });

  it("frees concurrent capacity when jobs finish", async () => {
    process.env.EXPORT_MAX_CONCURRENT_JOBS = "1";
    const job = await createExportJob({ state: ProcessingJobState.RUNNING });
    await expect(checkExportJobLimits(prisma, workspaceId, NOW)).resolves.toMatchObject({ allowed: false });

    await prisma.exportJob.update({ where: { id: job.id }, data: { state: ProcessingJobState.SUCCEEDED } });

    await expect(checkExportJobLimits(prisma, workspaceId, NOW)).resolves.toMatchObject({ allowed: true });
  });

  it("rejects on the rolling daily cap but ignores jobs older than 24h", async () => {
    process.env.EXPORT_DAILY_JOB_LIMIT = "2";
    await createExportJob({ state: ProcessingJobState.SUCCEEDED, createdAt: new Date(NOW.getTime() - 25 * HOUR_MS) });
    await createExportJob({ state: ProcessingJobState.SUCCEEDED, createdAt: new Date(NOW.getTime() - HOUR_MS) });

    await expect(checkExportJobLimits(prisma, workspaceId, NOW)).resolves.toMatchObject({ allowed: true });

    await createExportJob({ state: ProcessingJobState.SUCCEEDED, createdAt: new Date(NOW.getTime() - HOUR_MS) });

    await expect(checkExportJobLimits(prisma, workspaceId, NOW)).resolves.toMatchObject({
      allowed: false,
      reason: "export_daily_limit",
      limit: 2,
      current: 2,
    });
  });
});

describe("upload presign limit", () => {
  it("allows presigns under the hourly limit and ignores old events", async () => {
    process.env.UPLOAD_PRESIGN_HOURLY_LIMIT = "2";
    await recordPresignEvent({ createdAt: new Date(NOW.getTime() - 2 * HOUR_MS) });
    await recordPresignEvent({});

    await expect(checkUploadPresignLimit(prisma, workspaceId, NOW)).resolves.toMatchObject({ allowed: true });
  });

  it("rejects once the hourly limit is reached", async () => {
    process.env.UPLOAD_PRESIGN_HOURLY_LIMIT = "2";
    await recordPresignEvent({});
    await recordPresignEvent({});

    await expect(checkUploadPresignLimit(prisma, workspaceId, NOW)).resolves.toMatchObject({
      allowed: false,
      reason: "upload_presign_limit",
      limit: 2,
      current: 2,
    });
  });

  it("scopes counting to the workspace", async () => {
    process.env.UPLOAD_PRESIGN_HOURLY_LIMIT = "1";
    await recordPresignEvent({ workspace: otherWorkspaceId });

    await expect(checkUploadPresignLimit(prisma, workspaceId, NOW)).resolves.toMatchObject({ allowed: true });
  });
});
