import { describe, expect, it } from "vitest";
import { aggregateCostEvents, type CostRollupSourceEvent } from "@/lib/cost/rollup";

function factEvent(
  id: string,
  overrides: Partial<CostRollupSourceEvent> & { metadata?: Record<string, unknown> } = {},
): CostRollupSourceEvent {
  const { metadata, ...eventOverrides } = overrides;
  return {
    id,
    workspaceId: "workspace-a",
    projectId: "project-a",
    clipId: "clip-a",
    jobId: `job-${id}`,
    createdAt: new Date("2026-08-12T12:00:00.000Z"),
    category: "cost",
    eventType: "processing_cost_fact",
    metadata: {
      schemaVersion: 1,
      stage: "render",
      quantity: 2,
      unit: "second",
      unitCostUsd: 0.1,
      provider: "ffmpeg",
      model: null,
      providerProvenance: "runtime",
      pricingStatus: "priced",
      totalCostUsd: 0.2,
      bytes: 100,
      cpuTimeMs: 50,
      wallTimeMs: 75,
      attempt: 1,
      retry: false,
      outcome: "succeeded",
      ...metadata,
    },
    ...eventOverrides,
  };
}

describe("daily processing-cost aggregation", () => {
  it("sums retries, failures, bytes, runtime, and known cost", () => {
    const retry = factEvent("retry", {
      metadata: { attempt: 2, retry: true, outcome: "failed", totalCostUsd: 0.3 },
    });
    const rows = aggregateCostEvents([factEvent("first"), retry]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId: "workspace-a",
      projectId: "project-a",
      day: new Date("2026-08-12T00:00:00.000Z"),
      stage: "render",
      provider: "ffmpeg",
      model: null,
      unit: "second",
      quantity: 4,
      totalCostUsd: 0.5,
      bytes: BigInt(200),
      cpuTimeMs: BigInt(100),
      wallTimeMs: BigInt(150),
      eventCount: 2,
      retryCount: 1,
      failureCount: 1,
      unpricedEventCount: 0,
    });
  });

  it("keeps unknown price visible instead of treating it as a known zero", () => {
    const rows = aggregateCostEvents([
      factEvent("unpriced", {
        metadata: { unitCostUsd: null, pricingStatus: "unpriced", totalCostUsd: null },
      }),
    ]);
    expect(rows[0]).toMatchObject({ totalCostUsd: 0, unpricedEventCount: 1, eventCount: 1 });
  });

  it("uses direct clip attribution and falls back to legacy metadata", () => {
    const rows = aggregateCostEvents([
      factEvent("direct", { clipId: "direct-clip" }),
      factEvent("legacy", { clipId: null, metadata: { clipId: "legacy-clip", provider: "other" } }),
    ]);
    expect(rows.map((row) => row.clipIds).sort()).toEqual([["direct-clip"], ["legacy-clip"]]);
  });

  it("reconciles legacy ANALYZE usage without double-counting a job that has cost facts", () => {
    const modern = factEvent("modern", {
      jobId: "job-modern",
      metadata: { stage: "analysis_scoring", provider: "anthropic", totalCostUsd: 0.2 },
    });
    const modernLegacy: CostRollupSourceEvent = {
      ...modern,
      id: "modern-success",
      category: "analysis",
      eventType: "processing_job_succeeded",
      metadata: {
        usage: { totalInputTokens: 100, totalOutputTokens: 10, estimatedCostUsd: 99, unpricedModels: [] },
      },
    };
    const legacyOnly: CostRollupSourceEvent = {
      ...modernLegacy,
      id: "legacy-success",
      jobId: "job-legacy",
      metadata: {
        usage: { totalInputTokens: 100, totalOutputTokens: 10, estimatedCostUsd: 0.3, unpricedModels: [] },
      },
    };

    const rows = aggregateCostEvents([modern, modernLegacy, legacyOnly]);
    expect(rows.reduce((sum, row) => sum + row.totalCostUsd, 0)).toBeCloseTo(0.5, 9);
    expect(rows.find((row) => row.stage === "analysis_legacy")).toMatchObject({
      eventCount: 1,
      totalCostUsd: 0.3,
    });
  });
});
