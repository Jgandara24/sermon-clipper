import { AuthProvider, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getProjectCostReport,
  rollupProcessingCosts,
} from "@/lib/cost/rollup";
import { recordProcessingCostFact } from "@/lib/cost/record";

const prisma = new PrismaClient();
const createdUserIds: string[] = [];
const createdWorkspaceIds: string[] = [];
let workspaceA: string;
let workspaceB: string;
let projectA: string;

async function workspace(label: string) {
  const user = await prisma.user.create({
    data: { email: `rollup-${label}-${Date.now()}@example.com`, authProvider: AuthProvider.DEV },
  });
  createdUserIds.push(user.id);
  const created = await prisma.workspace.create({ data: { name: label, ownerId: user.id } });
  createdWorkspaceIds.push(created.id);
  return created.id;
}

beforeAll(async () => {
  workspaceA = await workspace("Cost Rollup A");
  workspaceB = await workspace("Cost Rollup B");
  const project = await prisma.project.create({ data: { workspaceId: workspaceA, name: "Cost Project A" } });
  projectA = project.id;
});

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: createdWorkspaceIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

async function costFact(input: {
  workspaceId?: string;
  projectId?: string | null;
  stage?: "render" | "transcription";
  unitCostUsd?: number | null;
  attempt?: number;
  outcome?: "succeeded" | "failed";
}) {
  return recordProcessingCostFact(prisma, {
    workspaceId: input.workspaceId ?? workspaceA,
    projectId: input.projectId === undefined ? projectA : input.projectId,
    stage: input.stage ?? "render",
    quantity: 1,
    unit: "operation",
    unitCostUsd: input.unitCostUsd === undefined ? 0.25 : input.unitCostUsd,
    provider: "test-provider",
    model: null,
    providerProvenance: "integration-test",
    attempt: input.attempt,
    outcome: input.outcome,
  });
}

describe("daily cost rollups", () => {
  it("is idempotent and keeps workspace, retry, failure, and unpriced facts exact", async () => {
    const known = await costFact({ attempt: 2, outcome: "failed" });
    const unpriced = await costFact({ unitCostUsd: null, stage: "transcription" });
    await costFact({ workspaceId: workspaceB, projectId: null });
    const from = new Date(Math.min(known.createdAt.getTime(), unpriced.createdAt.getTime()) - 1_000);
    const to = new Date(Date.now() + 60_000);

    const first = await rollupProcessingCosts(prisma, { from, to, workspaceId: workspaceA });
    const firstRows = await prisma.dailyCostRollup.findMany({
      where: { workspaceId: workspaceA },
      orderBy: { dimensionKey: "asc" },
    });
    const second = await rollupProcessingCosts(prisma, { from, to, workspaceId: workspaceA });
    const secondRows = await prisma.dailyCostRollup.findMany({
      where: { workspaceId: workspaceA },
      orderBy: { dimensionKey: "asc" },
    });

    expect(first).toEqual(second);
    expect(secondRows.map((row) => ({ ...row, id: null, createdAt: null, updatedAt: null }))).toEqual(
      firstRows.map((row) => ({ ...row, id: null, createdAt: null, updatedAt: null })),
    );
    expect(secondRows.reduce((sum, row) => sum + Number(row.totalCostUsd), 0)).toBeCloseTo(0.25, 9);
    expect(secondRows.reduce((sum, row) => sum + row.retryCount, 0)).toBe(1);
    expect(secondRows.reduce((sum, row) => sum + row.failureCount, 0)).toBe(1);
    expect(secondRows.reduce((sum, row) => sum + row.unpricedEventCount, 0)).toBe(1);
    await expect(prisma.dailyCostRollup.count({ where: { workspaceId: workspaceB } })).resolves.toBe(0);
  });

  it("replaces a day when a late event arrives", async () => {
    const before = await prisma.dailyCostRollup.aggregate({
      where: { workspaceId: workspaceA, projectId: projectA },
      _sum: { eventCount: true },
    });
    const late = await costFact({});
    await rollupProcessingCosts(prisma, {
      from: new Date(late.createdAt.getTime() - 60_000),
      to: new Date(late.createdAt.getTime() + 60_000),
      workspaceId: workspaceA,
    });
    const after = await prisma.dailyCostRollup.aggregate({
      where: { workspaceId: workspaceA, projectId: projectA },
      _sum: { eventCount: true },
    });
    expect(after._sum.eventCount).toBeGreaterThan(before._sum.eventCount ?? 0);
  });

  it("rolls up more than 1,000 raw events and reports project totals", async () => {
    const base = Date.now();
    await prisma.operationalEvent.createMany({
      data: Array.from({ length: 1_005 }, (_, index) => ({
        workspaceId: workspaceA,
        projectId: projectA,
        category: "cost",
        eventType: "processing_cost_fact",
        message: "Bulk cost fact.",
        createdAt: new Date(base + index),
        metadata: {
          schemaVersion: 1,
          stage: "render",
          quantity: 1,
          unit: "operation",
          unitCostUsd: 0.001,
          provider: "bulk-provider",
          model: null,
          providerProvenance: "integration-test",
          pricingStatus: "priced",
          totalCostUsd: 0.001,
          bytes: null,
          cpuTimeMs: null,
          wallTimeMs: null,
          attempt: 1,
          retry: false,
          outcome: "succeeded",
        },
      })),
    });
    await rollupProcessingCosts(prisma, {
      from: new Date(base - 1_000),
      to: new Date(base + 10_000),
      workspaceId: workspaceA,
    });

    const report = await getProjectCostReport(prisma, projectA);
    const bulk = report.stages.find((row) => row.provider === "bulk-provider");
    expect(bulk?.eventCount).toBe(1_005);
    expect(bulk?.knownCostUsd).toBeCloseTo(1.005, 9);
  });
});
