import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";

const COST_FACT_SCHEMA_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

export type CostRollupSourceEvent = {
  id: string;
  workspaceId: string | null;
  projectId: string | null;
  clipId: string | null;
  jobId: string | null;
  createdAt: Date;
  category: string;
  eventType: string;
  metadata: unknown;
};

export type DailyCostAggregate = {
  workspaceId: string;
  projectId: string | null;
  day: Date;
  dimensionKey: string;
  stage: string;
  provider: string;
  model: string | null;
  unit: string;
  quantity: number;
  totalCostUsd: number;
  bytes: bigint;
  cpuTimeMs: bigint;
  wallTimeMs: bigint;
  eventCount: number;
  retryCount: number;
  failureCount: number;
  unpricedEventCount: number;
  sourceLastEventAt: Date;
  clipIds: string[];
};

type NormalizedCost = {
  workspaceId: string;
  projectId: string | null;
  clipId: string | null;
  day: Date;
  stage: string;
  provider: string;
  model: string | null;
  unit: string;
  quantity: number;
  totalCostUsd: number | null;
  bytes: number;
  cpuTimeMs: number;
  wallTimeMs: number;
  retry: boolean;
  failed: boolean;
  unpriced: boolean;
  createdAt: Date;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNonNegative(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function utcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function utcDayCeiling(value: Date): Date {
  const floor = utcDay(value);
  return value.getTime() === floor.getTime() ? floor : new Date(floor.getTime() + DAY_MS);
}

function readCostFact(event: CostRollupSourceEvent): NormalizedCost | null {
  if (
    !event.workspaceId ||
    event.category !== "cost" ||
    event.eventType !== "processing_cost_fact"
  ) {
    return null;
  }
  const metadata = record(event.metadata);
  if (
    !metadata ||
    metadata.schemaVersion !== COST_FACT_SCHEMA_VERSION ||
    typeof metadata.stage !== "string" ||
    typeof metadata.provider !== "string" ||
    typeof metadata.unit !== "string" ||
    typeof metadata.quantity !== "number"
  ) {
    return null;
  }
  const totalCostUsd =
    typeof metadata.totalCostUsd === "number" && Number.isFinite(metadata.totalCostUsd)
      ? metadata.totalCostUsd
      : null;
  const legacyClipId = typeof metadata.clipId === "string" ? metadata.clipId : null;
  return {
    workspaceId: event.workspaceId,
    projectId: event.projectId,
    clipId: event.clipId ?? legacyClipId,
    day: utcDay(event.createdAt),
    stage: metadata.stage,
    provider: metadata.provider,
    model: typeof metadata.model === "string" ? metadata.model : null,
    unit: metadata.unit,
    quantity: finiteNonNegative(metadata.quantity),
    totalCostUsd,
    bytes: finiteNonNegative(metadata.bytes),
    cpuTimeMs: finiteNonNegative(metadata.cpuTimeMs),
    wallTimeMs: finiteNonNegative(metadata.wallTimeMs),
    retry: metadata.retry === true || finiteNonNegative(metadata.attempt, 1) > 1,
    failed: metadata.outcome === "failed",
    unpriced: metadata.pricingStatus === "unpriced" || totalCostUsd === null,
    createdAt: event.createdAt,
  };
}

function readLegacyAnalysis(event: CostRollupSourceEvent): NormalizedCost | null {
  if (
    !event.workspaceId ||
    event.category !== "analysis" ||
    event.eventType !== "processing_job_succeeded"
  ) {
    return null;
  }
  const usage = record(record(event.metadata)?.usage);
  if (!usage || typeof usage.estimatedCostUsd !== "number") return null;
  const unpricedModels = Array.isArray(usage.unpricedModels) ? usage.unpricedModels : [];
  return {
    workspaceId: event.workspaceId,
    projectId: event.projectId,
    clipId: event.clipId,
    day: utcDay(event.createdAt),
    stage: "analysis_legacy",
    provider: "anthropic_legacy",
    model: null,
    unit: "job",
    quantity: 1,
    totalCostUsd: finiteNonNegative(usage.estimatedCostUsd),
    bytes: 0,
    cpuTimeMs: 0,
    wallTimeMs: 0,
    retry: false,
    failed: false,
    unpriced: unpricedModels.length > 0,
    createdAt: event.createdAt,
  };
}

function dimensionKey(cost: NormalizedCost): string {
  return createHash("sha256")
    .update(JSON.stringify([cost.projectId, cost.stage, cost.provider, cost.model, cost.unit]))
    .digest("hex");
}

/** Pure aggregation used by the worker, CLI, and tests. */
export function aggregateCostEvents(events: CostRollupSourceEvent[]): DailyCostAggregate[] {
  const jobsWithAnalysisFacts = new Set(
    events
      .filter((event) => {
        const fact = readCostFact(event);
        return fact?.stage === "analysis_classification" || fact?.stage === "analysis_scoring";
      })
      .map((event) => event.jobId)
      .filter((jobId): jobId is string => jobId !== null),
  );

  const normalized: NormalizedCost[] = [];
  for (const event of events) {
    const fact = readCostFact(event);
    if (fact) {
      normalized.push(fact);
      continue;
    }
    if (event.jobId && jobsWithAnalysisFacts.has(event.jobId)) continue;
    const legacy = readLegacyAnalysis(event);
    if (legacy) normalized.push(legacy);
  }

  const groups = new Map<string, DailyCostAggregate & { clipIdSet: Set<string> }>();
  for (const cost of normalized) {
    const key = `${cost.workspaceId}:${cost.day.toISOString()}:${dimensionKey(cost)}`;
    let row = groups.get(key);
    if (!row) {
      row = {
        workspaceId: cost.workspaceId,
        projectId: cost.projectId,
        day: cost.day,
        dimensionKey: dimensionKey(cost),
        stage: cost.stage,
        provider: cost.provider,
        model: cost.model,
        unit: cost.unit,
        quantity: 0,
        totalCostUsd: 0,
        bytes: BigInt(0),
        cpuTimeMs: BigInt(0),
        wallTimeMs: BigInt(0),
        eventCount: 0,
        retryCount: 0,
        failureCount: 0,
        unpricedEventCount: 0,
        sourceLastEventAt: cost.createdAt,
        clipIds: [],
        clipIdSet: new Set<string>(),
      };
      groups.set(key, row);
    }
    row.quantity += cost.quantity;
    row.totalCostUsd += cost.totalCostUsd ?? 0;
    row.bytes += BigInt(Math.round(cost.bytes));
    row.cpuTimeMs += BigInt(Math.round(cost.cpuTimeMs));
    row.wallTimeMs += BigInt(Math.round(cost.wallTimeMs));
    row.eventCount += 1;
    row.retryCount += cost.retry ? 1 : 0;
    row.failureCount += cost.failed ? 1 : 0;
    row.unpricedEventCount += cost.unpriced ? 1 : 0;
    if (cost.createdAt > row.sourceLastEventAt) row.sourceLastEventAt = cost.createdAt;
    if (cost.clipId) row.clipIdSet.add(cost.clipId);
  }

  return [...groups.values()]
    .map(({ clipIdSet, ...row }) => ({ ...row, clipIds: [...clipIdSet].sort() }))
    .sort((a, b) =>
      [a.workspaceId, a.day.toISOString(), a.dimensionKey]
        .join(":")
        .localeCompare([b.workspaceId, b.day.toISOString(), b.dimensionKey].join(":")),
    );
}

export type RollupRange = { from: Date; to: Date; workspaceId?: string };

export function defaultCostRollupRange(now = new Date(), lookbackDays = 7): RollupRange {
  const throughDay = utcDay(now);
  return {
    from: new Date(throughDay.getTime() - lookbackDays * DAY_MS),
    to: new Date(throughDay.getTime() + DAY_MS),
  };
}

export async function rollupProcessingCosts(client: PrismaClient, range: RollupRange) {
  if (!(range.from < range.to)) throw new Error("Cost rollup range must have from before to.");
  // Rebuild whole UTC days. A partial-day replacement could erase earlier facts on the same day.
  const from = utcDay(range.from);
  const to = utcDayCeiling(range.to);
  const events = await client.operationalEvent.findMany({
    where: {
      workspaceId: range.workspaceId ?? { not: null },
      createdAt: { gte: from, lt: to },
      OR: [
        { category: "cost", eventType: "processing_cost_fact" },
        { category: "analysis", eventType: "processing_job_succeeded" },
      ],
    },
    select: {
      id: true,
      workspaceId: true,
      projectId: true,
      clipId: true,
      jobId: true,
      createdAt: true,
      category: true,
      eventType: true,
      metadata: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const rows = aggregateCostEvents(events);

  await client.$transaction(async (tx) => {
    // Replace the complete rebuilt day range. This removes a legacy-analysis dimension if a late
    // modern cost fact arrives for the same job, so the dual-read never becomes a double count.
    await tx.dailyCostRollup.deleteMany({
      where: { workspaceId: range.workspaceId, day: { gte: from, lt: to } },
    });
    for (const aggregate of rows) {
      const row = {
        workspaceId: aggregate.workspaceId,
        projectId: aggregate.projectId,
        day: aggregate.day,
        dimensionKey: aggregate.dimensionKey,
        stage: aggregate.stage,
        provider: aggregate.provider,
        model: aggregate.model,
        unit: aggregate.unit,
        quantity: aggregate.quantity,
        totalCostUsd: aggregate.totalCostUsd,
        bytes: aggregate.bytes,
        cpuTimeMs: aggregate.cpuTimeMs,
        wallTimeMs: aggregate.wallTimeMs,
        eventCount: aggregate.eventCount,
        retryCount: aggregate.retryCount,
        failureCount: aggregate.failureCount,
        unpricedEventCount: aggregate.unpricedEventCount,
        sourceLastEventAt: aggregate.sourceLastEventAt,
      };
      await tx.dailyCostRollup.upsert({
        where: {
          workspaceId_day_dimensionKey: {
            workspaceId: row.workspaceId,
            day: row.day,
            dimensionKey: row.dimensionKey,
          },
        },
        create: row,
        update: row,
      });
    }
  });

  return {
    sourceEventCount: events.length,
    rollupRowCount: rows.length,
    unpricedEventCount: rows.reduce((sum, row) => sum + row.unpricedEventCount, 0),
  };
}

export type CostSummary = {
  knownCostUsd: number;
  eventCount: number;
  retryCount: number;
  failureCount: number;
  unpricedEventCount: number;
  stages: Array<{
    stage: string;
    provider: string;
    model: string | null;
    knownCostUsd: number;
    eventCount: number;
    unpricedEventCount: number;
  }>;
};

function summarizeRows(
  rows: Array<{
    stage: string;
    provider: string;
    model: string | null;
    totalCostUsd: Prisma.Decimal;
    eventCount: number;
    retryCount: number;
    failureCount: number;
    unpricedEventCount: number;
  }>,
): CostSummary {
  const stages = new Map<string, CostSummary["stages"][number]>();
  const summary: CostSummary = {
    knownCostUsd: 0,
    eventCount: 0,
    retryCount: 0,
    failureCount: 0,
    unpricedEventCount: 0,
    stages: [],
  };
  for (const row of rows) {
    const cost = Number(row.totalCostUsd);
    summary.knownCostUsd += cost;
    summary.eventCount += row.eventCount;
    summary.retryCount += row.retryCount;
    summary.failureCount += row.failureCount;
    summary.unpricedEventCount += row.unpricedEventCount;
    const key = JSON.stringify([row.stage, row.provider, row.model]);
    const stage = stages.get(key) ?? {
      stage: row.stage,
      provider: row.provider,
      model: row.model,
      knownCostUsd: 0,
      eventCount: 0,
      unpricedEventCount: 0,
    };
    stage.knownCostUsd += cost;
    stage.eventCount += row.eventCount;
    stage.unpricedEventCount += row.unpricedEventCount;
    stages.set(key, stage);
  }
  summary.stages = [...stages.values()].sort((a, b) => a.stage.localeCompare(b.stage));
  return summary;
}

export async function getWorkspaceCostSummary(
  client: PrismaClient,
  workspaceId: string,
  options: { windowDays?: number; now?: Date } = {},
): Promise<CostSummary & { windowDays: number }> {
  const windowDays = options.windowDays ?? 30;
  const now = options.now ?? new Date();
  const from = new Date(utcDay(now).getTime() - (windowDays - 1) * DAY_MS);
  const rows = await client.dailyCostRollup.findMany({
    where: { workspaceId, day: { gte: from, lte: utcDay(now) } },
    select: {
      stage: true,
      provider: true,
      model: true,
      totalCostUsd: true,
      eventCount: true,
      retryCount: true,
      failureCount: true,
      unpricedEventCount: true,
    },
  });
  return { windowDays, ...summarizeRows(rows) };
}

export async function getProjectCostReport(client: PrismaClient, projectId: string) {
  const project = await client.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { id: true, workspaceId: true, name: true, createdAt: true },
  });
  const rows = await client.dailyCostRollup.findMany({
    where: { workspaceId: project.workspaceId, projectId },
    select: {
      day: true,
      stage: true,
      provider: true,
      model: true,
      totalCostUsd: true,
      eventCount: true,
      retryCount: true,
      failureCount: true,
      unpricedEventCount: true,
    },
    orderBy: [{ day: "asc" }, { stage: "asc" }],
  });
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    project,
    ...summarizeRows(rows),
  };
}
