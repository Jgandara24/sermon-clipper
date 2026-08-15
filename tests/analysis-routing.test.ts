import { describe, expect, it } from "vitest";
import {
  activeModelPrice,
  assertRoutingPolicyActivatable,
  assertRoutingPolicyPriced,
  resolveProjectAnalysisRouting,
  type AnalysisModelPrice,
  type AnalysisRoutingPolicy,
} from "@/lib/analysis/routing";

const masterPolicy: AnalysisRoutingPolicy = {
  id: "policy-2",
  version: 2,
  classification: { provider: "google", model: "gemini-2.5-flash-lite" },
  scoring: { provider: "anthropic", model: "claude-sonnet-5" },
  promptVersion: 1,
  schemaVersion: 1,
};

const prices: AnalysisModelPrice[] = [
  {
    provider: "google",
    model: "gemini-2.5-flash-lite",
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    effectiveUntil: null,
    inputPerMillionUsd: 0.1,
    cacheReadPerMillionUsd: 0.01,
    cacheWritePerMillionUsd: null,
    outputPerMillionUsd: 0.4,
    pricingSourceUrl: "https://ai.google.dev/gemini-api/docs/pricing",
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-5",
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    effectiveUntil: null,
    inputPerMillionUsd: 2,
    cacheReadPerMillionUsd: 0.2,
    cacheWritePerMillionUsd: 2.5,
    outputPerMillionUsd: 10,
    pricingSourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
  },
];

describe("analysis routing", () => {
  it("keeps the snapshotted routing when the master policy changes", () => {
    const processingConfig = {
      analysisRouting: {
        policyId: "policy-1",
        policyVersion: 1,
        classification: { provider: "anthropic", model: "claude-haiku-4-5" },
        scoring: { provider: "anthropic", model: "claude-sonnet-5" },
        promptVersion: 1,
        schemaVersion: 1,
      },
    };

    const result = resolveProjectAnalysisRouting(processingConfig, masterPolicy);

    expect(result.source).toBe("project_snapshot");
    expect(result.routing).toEqual(processingConfig.analysisRouting);
  });

  it("accepts a policy only when each paid route has a current price", () => {
    expect(() =>
      assertRoutingPolicyPriced(masterPolicy, prices, new Date("2026-08-13T00:00:00Z")),
    ).not.toThrow();
    expect(() =>
      assertRoutingPolicyPriced(masterPolicy, prices.slice(0, 1), new Date("2026-08-13T00:00:00Z")),
    ).toThrow("scoring model anthropic/claude-sonnet-5 has no active price");
  });

  it("refuses to activate a policy with a heuristic or not-installed stage", () => {
    // Production heuristic analysis stays behind the visible ANALYSIS_ALLOW_HEURISTIC incident
    // override (2026-08-12 fail-closed decision); an ACTIVE heuristic policy would be a
    // standing silent degradation. OpenAI has no installed adapter.
    expect(() =>
      assertRoutingPolicyActivatable({
        ...masterPolicy,
        classification: { provider: "heuristic", model: "heuristic-v1" },
      }),
    ).toThrow(/heuristic/);
    expect(() =>
      assertRoutingPolicyActivatable({
        ...masterPolicy,
        scoring: { provider: "openai", model: "gpt-5" },
      }),
    ).toThrow(/openai/);
    expect(() => assertRoutingPolicyActivatable(masterPolicy)).not.toThrow();
  });

  it("selects the latest-starting active price when windows overlap", () => {
    const standard: AnalysisModelPrice = {
      ...prices[1],
      effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      effectiveUntil: null,
      inputPerMillionUsd: 3,
    };
    const promotion: AnalysisModelPrice = {
      ...prices[1],
      effectiveFrom: new Date("2026-06-01T00:00:00Z"),
      effectiveUntil: null,
      inputPerMillionUsd: 2,
    };
    const at = new Date("2026-08-13T00:00:00Z");
    const route = masterPolicy.scoring;

    // Deterministic in both storage orders: the row does not depend on database return order.
    expect(activeModelPrice([standard, promotion], route, at)?.inputPerMillionUsd).toBe(2);
    expect(activeModelPrice([promotion, standard], route, at)?.inputPerMillionUsd).toBe(2);
    // Before the promotion window opens, the standard row still applies.
    expect(
      activeModelPrice([promotion, standard], route, new Date("2026-03-01T00:00:00Z"))
        ?.inputPerMillionUsd,
    ).toBe(3);
    expect(activeModelPrice([], route, at)).toBeNull();
  });
});
