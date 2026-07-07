import { AuthProvider, Prisma, PrismaClient, ProcessingJobType } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  InsufficientBalanceError,
  grantMinutes,
  releaseReservationForJob,
  releaseReservationsForProject,
  reserveMinutesForJob,
  settleReservationForJob,
} from "@/lib/usage-ledger";

const prisma = new PrismaClient();

let workspaceId: string;
let userId: string;
let projectId: string;

function uniqueKey(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function createJob() {
  return prisma.processingJob.create({
    data: {
      projectId,
      type: ProcessingJobType.FINALIZE,
      idempotencyKey: uniqueKey("job"),
    },
  });
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `${uniqueKey("ledger-test")}@example.com`, authProvider: AuthProvider.DEV },
  });
  userId = user.id;

  const workspace = await prisma.workspace.create({
    data: {
      name: "Ledger Integration Test Workspace",
      ownerId: user.id,
      minuteBalance: new Prisma.Decimal("10.00"),
    },
  });
  workspaceId = workspace.id;

  const project = await prisma.project.create({
    data: { workspaceId, name: "Ledger Integration Test Project" },
  });
  projectId = project.id;
});

afterAll(async () => {
  await prisma.workspace.delete({ where: { id: workspaceId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("usage ledger against a real database", () => {
  it("reserves and settles, decrementing the workspace balance", async () => {
    const job = await createJob();

    const reservation = await reserveMinutesForJob(prisma, {
      workspaceId,
      projectId,
      jobId: job.id,
      minutes: 4,
    });
    expect(reservation.balanceAfter.toString()).toBe("6");

    const settled = await settleReservationForJob(prisma, job.id);
    expect(settled?.id).toBe(reservation.id);

    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    expect(workspace.minuteBalance.toString()).toBe("6");
  });

  it("is idempotent: reserving twice for the same job does not double-charge", async () => {
    const job = await createJob();

    const first = await reserveMinutesForJob(prisma, {
      workspaceId,
      projectId,
      jobId: job.id,
      minutes: 1,
    });
    const second = await reserveMinutesForJob(prisma, {
      workspaceId,
      projectId,
      jobId: job.id,
      minutes: 1,
    });

    expect(second.id).toBe(first.id);
  });

  it("releases a reservation and restores the balance, idempotently", async () => {
    const job = await createJob();
    const before = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });

    await reserveMinutesForJob(prisma, { workspaceId, projectId, jobId: job.id, minutes: 2 });
    const released = await releaseReservationForJob(prisma, { jobId: job.id });
    const releasedAgain = await releaseReservationForJob(prisma, { jobId: job.id });

    const after = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    expect(after.minuteBalance.toString()).toBe(before.minuteBalance.toString());
    expect(releasedAgain?.id).toBe(released?.id);
  });

  it("rejects a reservation that would take the balance negative", async () => {
    const job = await createJob();

    await expect(
      reserveMinutesForJob(prisma, { workspaceId, projectId, jobId: job.id, minutes: 999 }),
    ).rejects.toThrow(InsufficientBalanceError);
  });

  it("releasing a job that was never reserved is a no-op", async () => {
    const job = await createJob();
    const result = await releaseReservationForJob(prisma, { jobId: job.id });
    expect(result).toBeNull();
  });

  it("releases all processing reservations for a failed project", async () => {
    const isolatedProject = await prisma.project.create({
      data: { workspaceId, name: "Ledger Project Release Test" },
    });
    const job = await prisma.processingJob.create({
      data: {
        projectId: isolatedProject.id,
        type: ProcessingJobType.FINALIZE,
        idempotencyKey: uniqueKey("project-release-job"),
      },
    });
    const before = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });

    await reserveMinutesForJob(prisma, {
      workspaceId,
      projectId: isolatedProject.id,
      jobId: job.id,
      minutes: 3,
    });

    const refunds = await releaseReservationsForProject(prisma, {
      projectId: isolatedProject.id,
      note: "Released after project failure.",
    });
    const after = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });

    expect(refunds).toHaveLength(1);
    expect(after.minuteBalance.toString()).toBe(before.minuteBalance.toString());
  });

  it("grants add to the balance", async () => {
    const before = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    const grant = await grantMinutes(prisma, { workspaceId, minutes: 5 });
    expect(grant.balanceAfter.toString()).toBe(before.minuteBalance.add(5).toString());
  });
});
