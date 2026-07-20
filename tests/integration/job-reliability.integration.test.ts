import {
  AuthProvider,
  GeneratedClipStatus,
  PrismaClient,
  ProcessingJobState,
  ProcessingJobType,
  ProjectStatus,
  WorkspaceRole,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  markExportJobFailedOrRetry,
  recoverStaleExportJobs,
  requeueFailedExportJob,
} from "@/lib/exports/queue";
import {
  applyStaleFailureSideEffects,
  claimNextJob,
  markJobFailedOrRetry,
  recoverStaleProcessingJobs,
} from "@/lib/jobs/queue";

const prisma = new PrismaClient();

let userId: string;
let workspaceId: string;
let projectId: string;
let clipId: string;

function uniqueKey(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      email: `${uniqueKey("worker-reliability")}@example.com`,
      authProvider: AuthProvider.DEV,
    },
  });
  userId = user.id;

  const workspace = await prisma.workspace.create({
    data: {
      name: "Worker Reliability",
      ownerId: user.id,
    },
  });
  workspaceId = workspace.id;

  await prisma.workspaceMember.create({
    data: { workspaceId, userId, role: WorkspaceRole.OWNER },
  });

  const project = await prisma.project.create({
    data: {
      workspaceId,
      name: "Worker Reliability Project",
      status: ProjectStatus.PROCESSING,
    },
  });
  projectId = project.id;

  const clip = await prisma.generatedClip.create({
    data: {
      workspaceId,
      projectId,
      rank: 1,
      startMs: 0,
      endMs: 10_000,
      title: "Worker Reliability Clip",
      summary: "A clip used to test export queue reliability.",
      status: GeneratedClipStatus.SUGGESTED,
    },
  });
  clipId = clip.id;
});

afterAll(async () => {
  if (workspaceId) {
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {});
  }
  await prisma.user.delete({ where: { id: userId } }).catch(() => {});
  await prisma.$disconnect();
});

// These tests use PREVIEW_RENDER as a deliberately handlerless job type so a concurrently running
// worker or test file can never execute real work against these rows (CLEANUP gained a real
// retention handler and is no longer safe for this).
describe("processing job reliability", () => {
  it("does not claim retrying jobs before runAfter", async () => {
    const future = new Date(Date.now() + 60_000);
    await prisma.processingJob.create({
      data: {
        projectId,
        type: ProcessingJobType.PREVIEW_RENDER,
        state: ProcessingJobState.RETRYING,
        idempotencyKey: uniqueKey("future-processing"),
        runAfter: future,
      },
    });

    const claimed = await claimNextJob(prisma, [ProcessingJobType.PREVIEW_RENDER]);

    expect(claimed).toBeNull();
  });

  it("claims eligible retrying jobs and records heartbeat ownership", async () => {
    const job = await prisma.processingJob.create({
      data: {
        projectId,
        type: ProcessingJobType.PREVIEW_RENDER,
        state: ProcessingJobState.RETRYING,
        idempotencyKey: uniqueKey("eligible-processing"),
        runAfter: new Date(Date.now() - 1_000),
      },
    });

    const claimed = await claimNextJob(prisma, [ProcessingJobType.PREVIEW_RENDER]);

    expect(claimed?.id).toBe(job.id);
    expect(claimed?.state).toBe(ProcessingJobState.RUNNING);
    expect(claimed?.attempt).toBe(1);
    expect(claimed?.heartbeatAt).toBeInstanceOf(Date);
    expect(claimed?.workerId).toBeTruthy();
  });

  it("schedules transient failures and terminally fails exhausted jobs", async () => {
    const retryingJob = await prisma.processingJob.create({
      data: {
        projectId,
        type: ProcessingJobType.PREVIEW_RENDER,
        state: ProcessingJobState.RUNNING,
        idempotencyKey: uniqueKey("retry-processing"),
        attempt: 1,
        maxAttempts: 3,
      },
    });

    const retryOutcome = await markJobFailedOrRetry(prisma, retryingJob, {
      code: "TEST_FAILURE",
      message: "Temporary failure.",
    });

    expect(retryOutcome).toBe("RETRYING");
    const retried = await prisma.processingJob.findUniqueOrThrow({ where: { id: retryingJob.id } });
    expect(retried.state).toBe(ProcessingJobState.RETRYING);
    expect(retried.runAfter.getTime()).toBeGreaterThan(Date.now());

    const exhaustedJob = await prisma.processingJob.create({
      data: {
        projectId,
        type: ProcessingJobType.PREVIEW_RENDER,
        state: ProcessingJobState.RUNNING,
        idempotencyKey: uniqueKey("failed-processing"),
        attempt: 3,
        maxAttempts: 3,
      },
    });

    const failedOutcome = await markJobFailedOrRetry(prisma, exhaustedJob, {
      code: "TEST_FAILURE",
      message: "Permanent failure.",
    });

    expect(failedOutcome).toBe("FAILED");
    const failed = await prisma.processingJob.findUniqueOrThrow({ where: { id: exhaustedJob.id } });
    expect(failed.state).toBe(ProcessingJobState.FAILED);
    expect(failed.finishedAt).toBeInstanceOf(Date);
  });

  it("recovers stale running jobs or fails them after max attempts", async () => {
    const now = new Date("2026-07-07T15:00:00.000Z");
    const staleTime = new Date("2026-07-07T14:00:00.000Z");
    const retryJob = await prisma.processingJob.create({
      data: {
        projectId,
        type: ProcessingJobType.PREVIEW_RENDER,
        state: ProcessingJobState.RUNNING,
        idempotencyKey: uniqueKey("stale-retry-processing"),
        attempt: 1,
        maxAttempts: 3,
        startedAt: staleTime,
        heartbeatAt: staleTime,
      },
    });
    const failJob = await prisma.processingJob.create({
      data: {
        projectId,
        type: ProcessingJobType.PREVIEW_RENDER,
        state: ProcessingJobState.RUNNING,
        idempotencyKey: uniqueKey("stale-fail-processing"),
        attempt: 3,
        maxAttempts: 3,
        startedAt: staleTime,
        heartbeatAt: staleTime,
      },
    });

    const recovery = await recoverStaleProcessingJobs(prisma, [ProcessingJobType.PREVIEW_RENDER], now);

    expect(recovery.recovered).toBeGreaterThanOrEqual(1);
    expect(recovery.failed).toBeGreaterThanOrEqual(1);
    expect(recovery.failedJobIds).toContain(failJob.id);

    const [retried, failed] = await Promise.all([
      prisma.processingJob.findUniqueOrThrow({ where: { id: retryJob.id } }),
      prisma.processingJob.findUniqueOrThrow({ where: { id: failJob.id } }),
    ]);
    expect(retried.state).toBe(ProcessingJobState.RETRYING);
    expect(retried.runAfter.toISOString()).toBe(now.toISOString());
    expect(failed.state).toBe(ProcessingJobState.FAILED);
    expect(failed.staleRecoveredAt?.toISOString()).toBe(now.toISOString());
  });
});

describe("export job reliability", () => {
  it("delays export retries and recovers stale export jobs", async () => {
    const exportJob = await prisma.exportJob.create({
      data: {
        clipId,
        workspaceId,
        filename: "worker-reliability.mp4",
        idempotencyKey: uniqueKey("export-retry"),
        state: ProcessingJobState.RUNNING,
        attempt: 1,
        maxAttempts: 3,
      },
    });

    const retryOutcome = await markExportJobFailedOrRetry(prisma, exportJob, {
      code: "RENDER_FAILED",
      message: "Temporary render failure.",
    });

    expect(retryOutcome).toBe("RETRYING");
    const retriedExport = await prisma.exportJob.findUniqueOrThrow({ where: { id: exportJob.id } });
    expect(retriedExport.state).toBe(ProcessingJobState.RETRYING);
    expect(retriedExport.runAfter.getTime()).toBeGreaterThan(Date.now());

    const staleTime = new Date("2026-07-07T14:00:00.000Z");
    const now = new Date("2026-07-07T15:00:00.000Z");
    const staleExport = await prisma.exportJob.create({
      data: {
        clipId,
        workspaceId,
        filename: "stale-worker-reliability.mp4",
        idempotencyKey: uniqueKey("export-stale"),
        state: ProcessingJobState.RUNNING,
        attempt: 1,
        maxAttempts: 3,
        startedAt: staleTime,
        heartbeatAt: staleTime,
      },
    });

    const recovery = await recoverStaleExportJobs(prisma, now);

    expect(recovery.recovered).toBeGreaterThanOrEqual(1);
    const recovered = await prisma.exportJob.findUniqueOrThrow({ where: { id: staleExport.id } });
    expect(recovered.state).toBe(ProcessingJobState.RETRYING);
    expect(recovered.runAfter.toISOString()).toBe(now.toISOString());
  });

  it("manual export retry clears failure and dead worker metadata", async () => {
    const failedExport = await prisma.exportJob.create({
      data: {
        clipId,
        workspaceId,
        filename: "manual-retry-worker-reliability.mp4",
        idempotencyKey: uniqueKey("manual-export-retry"),
        state: ProcessingJobState.FAILED,
        attempt: 3,
        maxAttempts: 3,
        errorCode: "STALE_EXPORT_TIMEOUT",
        errorMessageUser: "This export stopped responding and needs attention.",
        lastErrorAt: new Date("2026-07-07T14:00:00.000Z"),
        startedAt: new Date("2026-07-07T14:00:00.000Z"),
        finishedAt: new Date("2026-07-07T15:00:00.000Z"),
        heartbeatAt: new Date("2026-07-07T14:00:00.000Z"),
        workerId: "dead-worker",
      },
    });

    await requeueFailedExportJob(prisma, failedExport.id);

    const retried = await prisma.exportJob.findUniqueOrThrow({ where: { id: failedExport.id } });
    expect(retried.state).toBe(ProcessingJobState.QUEUED);
    expect(retried.errorCode).toBeNull();
    expect(retried.errorMessageUser).toBeNull();
    expect(retried.lastErrorAt).toBeNull();
    expect(retried.finishedAt).toBeNull();
    expect(retried.heartbeatAt).toBeNull();
    expect(retried.workerId).toBeNull();
  });
});

describe("stale failure side effects", () => {
  it("fails the project for exhausted pipeline jobs but never for CLEANUP jobs", async () => {
    const now = new Date();
    const staleTime = new Date(now.getTime() - 60 * 60 * 1000);

    const pipelineProject = await prisma.project.create({
      data: { workspaceId, name: "Stale Pipeline Project", status: ProjectStatus.PROCESSING },
    });
    const cleanupProject = await prisma.project.create({
      data: { workspaceId, name: "Healthy Cleanup Project", status: ProjectStatus.READY },
    });

    const pipelineJob = await prisma.processingJob.create({
      data: {
        projectId: pipelineProject.id,
        type: ProcessingJobType.FINALIZE,
        state: ProcessingJobState.RUNNING,
        idempotencyKey: uniqueKey("stale-side-pipeline"),
        attempt: 3,
        maxAttempts: 3,
        startedAt: staleTime,
        heartbeatAt: staleTime,
      },
    });
    const cleanupJob = await prisma.processingJob.create({
      data: {
        projectId: cleanupProject.id,
        type: ProcessingJobType.CLEANUP,
        state: ProcessingJobState.RUNNING,
        idempotencyKey: uniqueKey("stale-side-cleanup"),
        attempt: 3,
        maxAttempts: 3,
        startedAt: staleTime,
        heartbeatAt: staleTime,
      },
    });

    const recovery = await recoverStaleProcessingJobs(
      prisma,
      [ProcessingJobType.FINALIZE, ProcessingJobType.CLEANUP],
      now,
    );
    expect(recovery.failedJobs.map((j) => j.id)).toEqual(
      expect.arrayContaining([pipelineJob.id, cleanupJob.id]),
    );

    const released: string[] = [];
    await applyStaleFailureSideEffects(prisma, recovery.failedJobs, {
      releaseReservation: async (_client, jobId) => {
        released.push(jobId);
      },
    });

    // Pipeline job: reservation released, project failed.
    expect(released).toContain(pipelineJob.id);
    const failedProject = await prisma.project.findUniqueOrThrow({
      where: { id: pipelineProject.id },
    });
    expect(failedProject.status).toBe(ProjectStatus.FAILED);

    // CLEANUP job: no reservation release, healthy project untouched.
    expect(released).not.toContain(cleanupJob.id);
    const healthyProject = await prisma.project.findUniqueOrThrow({
      where: { id: cleanupProject.id },
    });
    expect(healthyProject.status).toBe(ProjectStatus.READY);
  });
});
