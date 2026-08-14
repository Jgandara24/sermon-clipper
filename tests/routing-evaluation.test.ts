import { describe, expect, it } from "vitest";
import { buildRoutingEvaluationReport } from "@/lib/evaluation/routing-evaluation";

describe("routing evaluation report", () => {
  it("contains comparison metrics but no transcript text", () => {
    const report = buildRoutingEvaluationReport({
      projectId: "project-1",
      sourceDurationMs: 100_000,
      candidateCount: 10,
      routing: {
        policyId: "policy-2",
        policyVersion: 2,
        classification: { provider: "google", model: "gemini-2.5-flash-lite" },
        scoring: { provider: "anthropic", model: "claude-sonnet-5" },
        promptVersion: 1,
        schemaVersion: 1,
      },
      usage: null,
      wallTimeMs: 50,
      startedAt: new Date("2026-08-13T00:00:00Z"),
      scored: [
        {
          startMs: 20_000,
          endMs: 50_000,
          text: "private transcript text",
          title: "Title",
          hookText: "Hook",
          summary: "Summary",
          excerpt: "Excerpt",
          total: 90,
          subscores: {},
          modelVersion: "claude-sonnet-5",
        },
      ],
    });

    expect(report.mode).toBe("shadow_no_customer_mutation");
    expect(report.funnelMetrics.stageAPassRatio).toBe(0.1);
    expect(JSON.stringify(report)).not.toContain("private transcript text");
    expect(report.humanReview.requiredBeforePromotion).toBe(true);
  });
});
