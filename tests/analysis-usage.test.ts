import { describe, expect, it } from "vitest";
import {
  analysisCallCostFact,
  buildAnalysisUsage,
  estimateCallCostUsd,
  type AnalysisModelCall,
} from "@/lib/analysis/usage";

function call(overrides: Partial<AnalysisModelCall>): AnalysisModelCall {
  return {
    stage: "analysis_scoring",
    provider: "anthropic",
    model: "claude-sonnet-5",
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    pricing: {
      provider: "anthropic",
      model: "claude-sonnet-5",
      effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      effectiveUntil: new Date("2026-09-01T00:00:00Z"),
      inputPerMillionUsd: 2,
      cacheReadPerMillionUsd: 0.2,
      cacheWritePerMillionUsd: 2.5,
      outputPerMillionUsd: 10,
      pricingSourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
    },
    ...overrides,
  };
}

describe("estimateCallCostUsd", () => {
  it("prices sonnet input and output at list price", () => {
    // The active Sonnet 5 promotion: 1M input at $2 + 1M output at $10.
    expect(
      estimateCallCostUsd(call({ inputTokens: 1_000_000, outputTokens: 1_000_000 })),
    ).toBeCloseTo(12, 6);
  });

  it("prices haiku separately from sonnet", () => {
    // 1M input at $1 + 1M output at $5
    expect(
      estimateCallCostUsd(
        call({
          model: "claude-haiku-4-5",
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          pricing: {
            ...call({}).pricing!,
            model: "claude-haiku-4-5",
            inputPerMillionUsd: 1,
            cacheReadPerMillionUsd: 0.1,
            cacheWritePerMillionUsd: 1.25,
            outputPerMillionUsd: 5,
          },
        }),
      ),
    ).toBeCloseTo(6, 6);
  });

  it("prices cache writes at 1.25x and cache reads at 0.1x input price", () => {
    // Sonnet promotion: 1M cache-write at $2.50 + 1M cache-read at $0.20.
    expect(
      estimateCallCostUsd(
        call({ cacheCreationInputTokens: 1_000_000, cacheReadInputTokens: 1_000_000 }),
      ),
    ).toBeCloseTo(2.5 + 0.2, 6);
  });

  it("returns null for models missing from the pricing table", () => {
    expect(estimateCallCostUsd(call({ model: "claude-future-9", pricing: null }))).toBeNull();
  });
});

describe("analysisCallCostFact", () => {
  it("preserves model and provider provenance in the shared cost contract", () => {
    expect(
      analysisCallCostFact(
        call({ inputTokens: 1_000, cacheReadInputTokens: 500 }),
        "claude_available",
      ),
    ).toMatchObject({
      stage: "analysis_scoring",
      quantity: 1,
      unit: "call",
      provider: "anthropic",
      model: "claude-sonnet-5",
      providerProvenance: "claude_available",
      cacheState: "hit",
      details: {
        inputTokens: 1_000,
        outputTokens: 0,
        imageCount: 0,
        cacheReadInputTokens: 500,
      },
    });
  });
});

describe("buildAnalysisUsage", () => {
  it("sums tokens and cost across calls", () => {
    const usage = buildAnalysisUsage([
      call({
        model: "claude-haiku-4-5",
        inputTokens: 500_000,
        outputTokens: 100_000,
        pricing: {
          ...call({}).pricing!,
          model: "claude-haiku-4-5",
          inputPerMillionUsd: 1,
          cacheReadPerMillionUsd: 0.1,
          cacheWritePerMillionUsd: 1.25,
          outputPerMillionUsd: 5,
        },
      }),
      call({ inputTokens: 200_000, outputTokens: 50_000, cacheReadInputTokens: 300_000 }),
    ]);

    expect(usage.totalInputTokens).toBe(500_000 + 200_000 + 300_000);
    expect(usage.totalOutputTokens).toBe(150_000);
    // haiku: $1.00; Sonnet promotion: 0.2*$2 + 0.05*$10 + 0.3*$0.2 = $0.96.
    expect(usage.estimatedCostUsd).toBeCloseTo(1.0 + 0.96, 6);
    expect(usage.unpricedModels).toEqual([]);
  });

  it("flags unpriced models instead of failing", () => {
    const usage = buildAnalysisUsage([
      call({ inputTokens: 100_000 }),
      call({
        model: "claude-future-9",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        pricing: null,
      }),
    ]);

    expect(usage.unpricedModels).toEqual(["claude-future-9"]);
    // Unknown model contributes 0; the sonnet call still prices.
    expect(usage.estimatedCostUsd).toBeCloseTo(0.2, 6);
    // Tokens still count even when unpriced.
    expect(usage.totalInputTokens).toBe(1_100_000);
  });

  it("handles an empty call list", () => {
    const usage = buildAnalysisUsage([]);
    expect(usage).toMatchObject({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      estimatedCostUsd: 0,
      unpricedModels: [],
    });
  });
});
