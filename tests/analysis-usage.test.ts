import { describe, expect, it } from "vitest";
import {
  buildAnalysisUsage,
  estimateCallCostUsd,
  type AnalysisModelCall,
} from "@/lib/analysis/usage";

function call(overrides: Partial<AnalysisModelCall>): AnalysisModelCall {
  return {
    model: "claude-sonnet-5",
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    ...overrides,
  };
}

describe("estimateCallCostUsd", () => {
  it("prices sonnet input and output at list price", () => {
    // 1M input at $3 + 1M output at $15
    expect(
      estimateCallCostUsd(call({ inputTokens: 1_000_000, outputTokens: 1_000_000 })),
    ).toBeCloseTo(18, 6);
  });

  it("prices haiku separately from sonnet", () => {
    // 1M input at $1 + 1M output at $5
    expect(
      estimateCallCostUsd(
        call({ model: "claude-haiku-4-5", inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      ),
    ).toBeCloseTo(6, 6);
  });

  it("prices cache writes at 1.25x and cache reads at 0.1x input price", () => {
    // Sonnet: 1M cache-write at $3 * 1.25 + 1M cache-read at $3 * 0.1
    expect(
      estimateCallCostUsd(
        call({ cacheCreationInputTokens: 1_000_000, cacheReadInputTokens: 1_000_000 }),
      ),
    ).toBeCloseTo(3.75 + 0.3, 6);
  });

  it("returns null for models missing from the pricing table", () => {
    expect(estimateCallCostUsd(call({ model: "claude-future-9" }))).toBeNull();
  });
});

describe("buildAnalysisUsage", () => {
  it("sums tokens and cost across calls", () => {
    const usage = buildAnalysisUsage([
      call({ model: "claude-haiku-4-5", inputTokens: 500_000, outputTokens: 100_000 }),
      call({ inputTokens: 200_000, outputTokens: 50_000, cacheReadInputTokens: 300_000 }),
    ]);

    expect(usage.totalInputTokens).toBe(500_000 + 200_000 + 300_000);
    expect(usage.totalOutputTokens).toBe(150_000);
    // haiku: 0.5*$1 + 0.1*$5 = $1.00; sonnet: 0.2*$3 + 0.05*$15 + 0.3*$0.3 = $1.44
    expect(usage.estimatedCostUsd).toBeCloseTo(1.0 + 1.44, 6);
    expect(usage.unpricedModels).toEqual([]);
  });

  it("flags unpriced models instead of failing", () => {
    const usage = buildAnalysisUsage([
      call({ inputTokens: 100_000 }),
      call({ model: "claude-future-9", inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ]);

    expect(usage.unpricedModels).toEqual(["claude-future-9"]);
    // Unknown model contributes 0; the sonnet call still prices.
    expect(usage.estimatedCostUsd).toBeCloseTo(0.3, 6);
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
