import { describe, expect, it, vi } from "vitest";
import { CompleteMessageProvider } from "@/lib/analysis/complete-message/provider";
import { transcriptProblem, type Transcript } from "@/lib/analysis/complete-message/contract";
import { StageBResultSchema } from "@/lib/analysis/pipeline";
import { fakeAdapter, mockUsage } from "../p2-complete-message-stage3/fixtures";

let serial = 0;
// Artificial speech at 180 words/minute. No real transcript supplies this text or these times.
function dense(seconds: number): Transcript {
  const prefix = `dense-${++serial}`;
  const vocabulary = "The gardener gives each plant water and checks its growth each morning".split(" ");
  return {
    revision: prefix, sourceDurationMs: seconds * 1000,
    regions: [{ startMs: 0, endMs: seconds * 1000, kind: "allowed" }], gaps: [],
    segments: Array.from({ length: seconds / 10 }, (_, s) => {
      const words = Array.from({ length: 30 }, (_, w) => ({
        id: `${prefix}-s${s}-w${w}`, text: vocabulary[(s * 30 + w) % vocabulary.length],
        startMs: s * 10000 + Math.floor(w * 10000 / 30),
        endMs: s * 10000 + Math.floor((w + 1) * 10000 / 30),
      }));
      return { id: `${prefix}-s${s}`, startMs: s * 10000, endMs: (s + 1) * 10000,
        words, text: words.map((w) => w.text).join(" "), verifiedStart: false, verifiedEnd: false };
    }),
  };
}

// A sensitivity model only. This is neither a tokenizer nor a safe upper bound for real providers.
const proxyUnits = (text: string) => Math.ceil(Buffer.byteLength(text, "utf8") / 4);
const context = { genre: "sermon", fullText: "Invented dense transcript." };

describe("dense request characterization without provider clients", () => {
  it.each([30, 60])("retains a complete %i-second synthetic message", async (seconds) => {
    const t = dense(seconds), before = structuredClone(t);
    expect(transcriptProblem(t)).toBeUndefined();
    const mock = fakeAdapter(t);
    mock.adapter.measureInputTokens = vi.fn(proxyUnits);
    const result = await new CompleteMessageProvider(mock.legacy, t, mock.adapter).scoreCandidates([], context);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ startMs: 0, endMs: seconds * 1000 });
    const payload = JSON.parse(mock.invoke.mock.calls[0][0].payload);
    expect(payload.segments.flatMap((s: Transcript["segments"][number]) => s.words)).toHaveLength(seconds * 3);
    expect(t).toEqual(before);
    expect(mock.legacy.scoreCandidates).not.toHaveBeenCalled();
  });

  it("refuses a dense 390-second request before dispatch under the size model", async () => {
    const t = dense(600), before = structuredClone(t), mock = fakeAdapter(t);
    const measure = vi.fn(proxyUnits);
    mock.adapter.measureInputTokens = measure;
    const provider = new CompleteMessageProvider(mock.legacy, t, mock.adapter);
    await expect(provider.scoreCandidates([], context)).rejects.toThrow("context_budget_exceeded");
    expect(mock.invoke).not.toHaveBeenCalled();
    expect(provider.evidence).toBeNull();
    expect(t).toEqual(before);
    const wire = measure.mock.calls[0][0];
    const packet = JSON.parse(wire);
    expect(packet.segments).toHaveLength(39);
    expect(packet.segments.flatMap((s: Transcript["segments"][number]) => s.words)).toHaveLength(1170);
    expect(proxyUnits(wire)).toBeGreaterThan(12000);
    console.info(JSON.stringify({ case: "dense390", bytes: Buffer.byteLength(wire), proxyUnits: proxyUnits(wire), words: 1170 }));
  });

  it("counts repeated context and keeps whole segments across overlapping blocks", async () => {
    const t = dense(720), mock = fakeAdapter(t);
    // Controlled counts isolate packing from tokenizer behavior.
    mock.adapter.measureInputTokens = () => 100;
    mock.invoke.mockImplementation(async (call) => {
      const packet = JSON.parse(call.payload);
      return { truncated: false, usage: mockUsage(call.stage), output: {
        version: 1, revision: t.revision, requestId: packet.request.id, proposals: [],
      } };
    });
    expect(await new CompleteMessageProvider(mock.legacy, t, mock.adapter).scoreCandidates([], context)).toEqual([]);
    const packets = mock.invoke.mock.calls.map(([call]) => JSON.parse(call.payload));
    expect(packets.map((p) => p.core.startMs)).toEqual([0, 180000, 360000]);
    expect(packets.map((p) => p.segments.length)).toEqual([39, 42, 39]);
    const delivered = packets.flatMap((p) => p.segments) as Transcript["segments"];
    expect(new Set(delivered.map((s) => s.id)).size).toBe(t.segments.length);
    expect(delivered.length).toBeGreaterThan(t.segments.length);
    for (const segment of delivered) expect(segment).toEqual(t.segments.find((s) => s.id === segment.id));
  });

  it.each([12000, 12001])("applies the full envelope reservation of %i units", async (units) => {
    const t = dense(30), mock = fakeAdapter(t);
    mock.adapter.measureInputTokens = () => units;
    const run = new CompleteMessageProvider(mock.legacy, t, mock.adapter).scoreCandidates([], context);
    if (units === 12000) await expect(run).resolves.toHaveLength(1);
    else {
      await expect(run).rejects.toThrow("context_budget_exceeded");
      expect(mock.invoke).not.toHaveBeenCalled();
    }
  });

  it("refuses truncated dense classification without scoring or fallback", async () => {
    const t = dense(180), mock = fakeAdapter(t);
    const invoke = mock.invoke.getMockImplementation()!;
    let completeResponseBytes = 0;
    mock.invoke.mockImplementation(async (call) => {
      const response = await invoke(call);
      const serialized = JSON.stringify(response.output);
      completeResponseBytes = Buffer.byteLength(serialized);
      expect(proxyUnits(serialized)).toBeGreaterThan(call.maxOutputTokens);
      // The mock reports a capped provider response. No real token measurement occurs.
      return { ...response, truncated: true, usage: { ...response.usage, outputTokens: call.maxOutputTokens } };
    });
    await expect(new CompleteMessageProvider(mock.legacy, t, mock.adapter).scoreCandidates([], context))
      .rejects.toThrow("truncated_response");
    expect(mock.invoke).toHaveBeenCalledOnce();
    expect(mock.legacy.scoreCandidates).not.toHaveBeenCalled();
    console.info(JSON.stringify({ case: "dense180-response", bytes: completeResponseBytes, proxyUnits: Math.ceil(completeResponseBytes / 4), cap: 1024 }));
  });

  it("exposes input-only scoring packing and refuses the oversized mock response", async () => {
    const t = dense(300), mock = fakeAdapter(t);
    // Low controlled input counts isolate output packing. They make no capacity claim.
    mock.adapter.measureInputTokens = () => 100;
    let responseBytes = 0;
    mock.invoke.mockImplementation(async (call) => {
      const packet = JSON.parse(call.payload);
      if (call.stage === "analysis_classification") return {
        truncated: false, usage: mockUsage(call.stage), output: {
          version: 1, requestId: packet.request.id, revision: t.revision,
          proposals: Array.from({ length: 10 }, (_, i) => {
            const group = t.segments.slice(i * 3, i * 3 + 3);
            return { id: `message-${i}`, state: "complete", missingContext: [], reason: "Scripted complete message.",
              start: { kind: "segment", id: group[0].id }, end: { kind: "segment", id: group[2].id },
              required: group.map((s, n) => ({ ref: { kind: "segment", id: s.id }, quote: s.text,
                roles: [n === 0 ? "claim" : n === 2 ? "resolution" : "development"] })),
            };
          }),
        },
      };
      expect(packet.candidates).toHaveLength(10);
      const output = { scoredClips: packet.candidates.map((c: { index: number; text: string }) => ({
        index: c.index, title: "Care for the garden", hookText: "Regular care supports growth.",
        summary: "The invented speaker explains regular care.", excerpt: c.text,
        subscores: Object.fromEntries(["hookStrength", "clarity", "emotionalImpact", "completeness", "shareability", "topicRelevance"]
          .map((name) => [name, { score: 80, note: "The invented example contains a claim and an explanation." }])),
      })) };
      expect(StageBResultSchema.safeParse(output).success).toBe(true);
      responseBytes = Buffer.byteLength(JSON.stringify(output));
      expect(proxyUnits(JSON.stringify(output))).toBeGreaterThan(call.maxOutputTokens);
      expect(call.maxOutputTokens).toBe(2048);
      return { output, truncated: true, usage: { ...mockUsage(call.stage), outputTokens: 2048 } };
    });
    const provider = new CompleteMessageProvider(mock.legacy, t, mock.adapter);
    await expect(provider.scoreCandidates([], context)).rejects.toThrow("truncated_response");
    expect(provider.evidence).toBeNull();
    expect(mock.invoke).toHaveBeenCalledTimes(2);
    expect(mock.legacy.scoreCandidates).not.toHaveBeenCalled();
    console.info(JSON.stringify({ case: "ten-scoring-results", bytes: responseBytes, proxyUnits: Math.ceil(responseBytes / 4), cap: 2048 }));
  });
});
