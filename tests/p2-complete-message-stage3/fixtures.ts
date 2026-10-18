import { vi } from "vitest";
import type { AnalysisProvider } from "../../src/lib/analysis/types";
import type { MessageCall, CompleteMessageAdapter } from "../../src/lib/analysis/complete-message/adapter";
import type { Transcript } from "../../src/lib/analysis/complete-message/contract";
import type { AnalysisModelCall } from "../../src/lib/analysis/usage";

export function mockUsage(stage: MessageCall["stage"]): AnalysisModelCall {
  return { stage, provider: "google", model: "synthetic-model", inputTokens: 10, outputTokens: 10,
    cacheCreationInputTokens: 0, cacheReadInputTokens: 0, pricing: null, outcome: "succeeded" };
}

export function fakeAdapter(t: Transcript) {
  const invoke = vi.fn<CompleteMessageAdapter["invoke"]>(async (call) => {
    const payload = JSON.parse(call.payload);
    if (call.stage === "analysis_classification") {
      return { truncated: false, usage: mockUsage(call.stage), output: {
        version: 1, requestId: payload.request.id, revision: t.revision, proposals: [{
          id: "message-1", state: "complete",
          start: { kind: "segment", id: t.segments[0].id }, end: { kind: "segment", id: t.segments.at(-1)!.id },
          required: t.segments.map((s, i) => ({
            ref: { kind: "segment", id: s.id }, quote: s.text,
            roles: t.segments.length === 1 ? ["claim", "resolution"] : i === 0 ? ["claim"] : i === t.segments.length - 1 ? ["resolution"] : ["development"],
          })), missingContext: [], reason: "The supplied message contains the claim and resolution.",
        }],
      } };
    }
    return { truncated: false, usage: mockUsage(call.stage), output: {
      scoredClips: payload.candidates.map((c: { index: number; text: string }) => ({
        index: c.index, title: "A complete message", hookText: "Care takes time", summary: "Regular care helps growth.", excerpt: c.text,
        subscores: Object.fromEntries(["hookStrength", "clarity", "emotionalImpact", "completeness", "shareability", "topicRelevance"]
          .map((name) => [name, { score: 90, note: "Synthetic score." }])),
      })),
    } };
  });
  const adapter: CompleteMessageAdapter = { measureInputTokens: vi.fn(() => 100), invoke };
  const legacy: AnalysisProvider = {
    name: "synthetic-provider", completeMessageAdapter: adapter,
    isAvailable: vi.fn(async () => true), scoreCandidates: vi.fn(async () => []),
  };
  return { adapter, invoke, legacy };
}
