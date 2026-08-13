import { describe, expect, it } from "vitest";
import { buildProcessingCostFact } from "@/lib/cost/types";
import { recordProcessingCostFact } from "@/lib/cost/record";

describe("buildProcessingCostFact", () => {
  it("builds a paid provider cost fact", () => {
    expect(
      buildProcessingCostFact({
        stage: "analysis_scoring",
        quantity: 1_000,
        unit: "token",
        unitCostUsd: 0.000_003,
        provider: "anthropic",
        model: "claude-sonnet-5",
        providerProvenance: "claude_available",
        cacheState: "miss",
      }),
    ).toMatchObject({
      schemaVersion: 1,
      pricingStatus: "priced",
      totalCostUsd: 0.003,
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
  });

  it("distinguishes known zero cost from an unknown price", () => {
    const common = {
      stage: "transcription" as const,
      quantity: 60,
      unit: "minute" as const,
      provider: "local_whisper_cpp",
      model: "base.en",
      providerProvenance: "configured_model",
    };

    expect(buildProcessingCostFact({ ...common, unitCostUsd: 0 })).toMatchObject({
      pricingStatus: "zero_cost",
      totalCostUsd: 0,
    });
    expect(buildProcessingCostFact({ ...common, unitCostUsd: null })).toMatchObject({
      pricingStatus: "unpriced",
      totalCostUsd: null,
    });
  });
});

describe("recordProcessingCostFact", () => {
  it("records a cost event without writing the customer usage ledger", async () => {
    const creates: unknown[] = [];
    const client = {
      operationalEvent: {
        create: async (args: unknown) => {
          creates.push(args);
          return { id: "cost-event" };
        },
      },
      usageLedger: {
        create: async () => {
          throw new Error("COGS must not write UsageLedger");
        },
      },
    };

    await recordProcessingCostFact(client as never, {
      workspaceId: "00000000-0000-4000-8000-000000000001",
      stage: "local_audio_extraction",
      quantity: 30,
      unit: "minute",
      unitCostUsd: 0,
      provider: "local_ffmpeg",
      model: null,
      providerProvenance: "configured_binary",
      bytes: 24_000_000,
      cpuTimeMs: 12_000,
      wallTimeMs: 8_000,
      cacheState: "not_applicable",
      projectId: "00000000-0000-4000-8000-000000000002",
      clipId: "00000000-0000-4000-8000-000000000003",
      jobId: "00000000-0000-4000-8000-000000000004",
      attempt: 2,
    });

    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({
      data: {
        category: "cost",
        eventType: "processing_cost_fact",
        projectId: "00000000-0000-4000-8000-000000000002",
        jobId: "00000000-0000-4000-8000-000000000004",
        metadata: {
          pricingStatus: "zero_cost",
          totalCostUsd: 0,
          clipId: "00000000-0000-4000-8000-000000000003",
          attempt: 2,
          retry: true,
        },
      },
    });
  });
});
