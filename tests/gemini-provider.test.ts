import { afterEach, describe, expect, it, vi } from "vitest";
import { AnalysisResponseTruncatedError } from "@/lib/analysis/claude-provider";
import { GeminiStageAdapter } from "@/lib/analysis/gemini-provider";
import { RoutedAnalysisProvider } from "@/lib/analysis/routed-provider";
import type { AnalysisModelPrice } from "@/lib/analysis/routing";

const price: AnalysisModelPrice = {
  provider: "google",
  model: "gemini-2.5-flash-lite",
  effectiveFrom: new Date("2026-01-01T00:00:00Z"),
  effectiveUntil: null,
  inputPerMillionUsd: 0.1,
  cacheReadPerMillionUsd: 0.01,
  cacheWritePerMillionUsd: null,
  outputPerMillionUsd: 0.4,
  pricingSourceUrl: "https://ai.google.dev/gemini-api/docs/pricing",
};

function geminiResponse(value: unknown, usage = { promptTokenCount: 100, candidatesTokenCount: 20 }) {
  return new Response(
    JSON.stringify({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(value) }] } }],
      usageMetadata: usage,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

afterEach(() => {
  delete process.env.GEMINI_API_KEY;
});

describe("Gemini analysis adapter", () => {
  it("uses the same two-stage contract and records explicit stage usage", async () => {
    process.env.GEMINI_API_KEY = "gemini-test-key";
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        geminiResponse({ classifications: [{ index: 0, momentType: "hook" }] }),
      )
      .mockResolvedValueOnce(
        geminiResponse({
          scoredClips: [
            {
              index: 0,
              title: "Hope Is Here",
              hookText: "Hope starts here",
              summary: "A complete point about hope.",
              excerpt: "Hope changes how we live.",
              subscores: {
                hookStrength: { score: 90, note: "Strong opening." },
                clarity: { score: 88, note: "Clear." },
                emotionalImpact: { score: 85, note: "Warm." },
                completeness: { score: 87, note: "Complete." },
                shareability: { score: 86, note: "Useful." },
                topicRelevance: { score: 91, note: "Relevant." },
              },
            },
          ],
        }),
      );
    const provider = new RoutedAnalysisProvider(
      new GeminiStageAdapter("gemini-2.5-flash-lite", price, fetchImpl),
      new GeminiStageAdapter("gemini-2.5-flash-lite", price, fetchImpl),
      "google:gemini-2.5-flash-lite",
    );

    const result = await provider.scoreCandidates(
      [{ startMs: 0, endMs: 30_000, text: "Hope changes how we live." }],
      { fullText: "Hope changes how we live.", genre: "podcast" },
    );

    expect(result).toHaveLength(1);
    expect(result[0].modelVersion).toBe("gemini-2.5-flash-lite");
    expect(provider.lastUsage?.calls.map((call) => [call.stage, call.provider])).toEqual([
      ["analysis_classification", "google"],
      ["analysis_scoring", "google"],
    ]);
    const firstBody = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(firstBody.generationConfig.responseMimeType).toBe("application/json");
    expect(firstBody.generationConfig.responseJsonSchema).toBeTypeOf("object");
  });

  it("fails a truncated response instead of parsing partial output", async () => {
    process.env.GEMINI_API_KEY = "gemini-test-key";
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            { finishReason: "MAX_TOKENS", content: { parts: [{ text: '{"classifications":[' }] } },
          ],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 32000 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const adapter = new GeminiStageAdapter("gemini-2.5-flash-lite", price, fetchImpl);

    await expect(
      adapter.classifyCandidates([{ startMs: 0, endMs: 30_000, text: "Hope." }]),
    ).rejects.toThrow(AnalysisResponseTruncatedError);
    // The truncated call's token usage still reaches spend telemetry.
    expect(adapter.lastCall).toMatchObject({
      stage: "analysis_classification",
      provider: "google",
      outcome: "failed",
      outputTokens: 32000,
    });
  });

  it("surfaces the provider error for a failed HTTP request", async () => {
    process.env.GEMINI_API_KEY = "gemini-test-key";
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "API key not valid." } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    const adapter = new GeminiStageAdapter("gemini-2.5-flash-lite", price, fetchImpl);

    await expect(
      adapter.classifyCandidates([{ startMs: 0, endMs: 30_000, text: "Hope." }]),
    ).rejects.toThrow("API key not valid.");
  });
});
