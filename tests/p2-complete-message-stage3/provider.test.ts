import { afterEach, describe, expect, it, vi } from "vitest";
import { CompleteMessageProvider } from "../../src/lib/analysis/complete-message/provider";
import { readCompleteMessagePolicy } from "../../src/lib/analysis/complete-message/integration";
import { POLICY } from "../../src/lib/analysis/complete-message/contract";
import { makeCase } from "../p2-complete-message-stage2/fixtures";
import { earlierContext, sentenceNotMessage, transcript } from "../p2-complete-message/fixtures";
import { fakeAdapter, mockUsage } from "./fixtures";

afterEach(() => vi.useRealTimers());
const context = { fullText: "Unused full text must not replace bounded context.", genre: "sermon" };

describe("Stage 3 policy and complete-message provider", () => {
  it.each([undefined, null, {}, { completeMessagePolicy: { enabled: false } }])("keeps missing or disabled policy on the legacy path", (config) => {
    expect(readCompleteMessagePolicy(config)).toBeNull();
  });

  it.each([true, "true", {}, { enabled: true }, { enabled: true, version: "other" }])("refuses malformed opt-in %j", (setting) => {
    expect(() => readCompleteMessagePolicy({ completeMessagePolicy: setting })).toThrow("invalid_policy_snapshot");
  });

  it.each([sentenceNotMessage, earlierContext])("classifies adjacent context and validates an extended range", async (fixture) => {
    const f = makeCase(fixture());
    const { adapter, legacy, invoke } = fakeAdapter(f.source);
    const provider = new CompleteMessageProvider(legacy, f.source, adapter);
    const clips = await provider.scoreCandidates([], context);
    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({ startMs: f.range.startMs - 150, endMs: f.range.endMs + 150 });
    expect(clips[0].subscores.platform_fit.score).toBe(100);
    expect(clips[0].modelVersion).toContain(POLICY.version);
    const first = JSON.parse(invoke.mock.calls[0][0].payload);
    expect(first.segments).toEqual(f.source.segments);
    expect(first.instructions).toContain("A sentence ending does not prove a complete message");
    const last = JSON.parse(invoke.mock.calls[1][0].payload);
    expect(last.candidates[0].context).toEqual(f.source.segments);
    expect(legacy.scoreCandidates).not.toHaveBeenCalled();
    expect(provider.evidence?.policyVersion).toBe(POLICY.version);
    expect(provider.lastUsage?.calls).toHaveLength(2);
  });

  it.each([30_000, 56_620, 103_000, 152_000])("gives %i milliseconds the same neutral duration score", async (duration) => {
    const f = makeCase(transcript([duration]));
    const { adapter, legacy } = fakeAdapter(f.source);
    const [clip] = await new CompleteMessageProvider(legacy, f.source, adapter).scoreCandidates([], context);
    expect(clip.subscores.platform_fit).toEqual({ score: 100, letter: "A+", note: "The complete message meets the duration policy." });
    expect(JSON.parse(clip.subscores.complete_message.note).required[0].ref.id).toBe(f.source.segments[0].id);
  });

  it("does not score an incomplete message even when a mock offers high scores", async () => {
    const f = makeCase(sentenceNotMessage());
    const { adapter, legacy, invoke } = fakeAdapter(f.source);
    invoke.mockImplementationOnce(async (call) => ({ truncated: false, usage: mockUsage(call.stage), output: {
      ...f.response, requestId: "block-1", proposals: [{ ...f.proposal, end: { kind: "segment", id: f.source.segments[1].id } }],
    } }));
    const provider = new CompleteMessageProvider(legacy, f.source, adapter);
    expect(await provider.scoreCandidates([], context)).toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(provider.evidence?.reasons.required_context_outside_range).toBe(1);
  });

  it("refuses malformed classification without scoring or fallback", async () => {
    const f = makeCase();
    const { adapter, legacy, invoke } = fakeAdapter(f.source);
    invoke.mockResolvedValueOnce({ truncated: false, usage: mockUsage("analysis_classification"), output: {} } as never);
    await expect(new CompleteMessageProvider(legacy, f.source, adapter).scoreCandidates([], context)).rejects.toThrow("malformed_response");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(legacy.scoreCandidates).not.toHaveBeenCalled();
  });

  it("refuses scoring that omits a selected message", async () => {
    const f = makeCase();
    const { adapter, legacy, invoke } = fakeAdapter(f.source);
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (call) => call.stage === "analysis_classification" ? original(call)
      : { truncated: false, usage: mockUsage(call.stage), output: { scoredClips: [] } } as never);
    await expect(new CompleteMessageProvider(legacy, f.source, adapter).scoreCandidates([], context)).rejects.toThrow("incomplete_scores");
  });

  it("refuses input above the token limit before dispatch", async () => {
    const f = makeCase();
    const { adapter, legacy, invoke } = fakeAdapter(f.source);
    adapter.measureInputTokens = () => 12_001;
    await expect(new CompleteMessageProvider(legacy, f.source, adapter).scoreCandidates([], context)).rejects.toThrow("context_budget_exceeded");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("aborts a stalled request with fake time and never invokes fallback", async () => {
    vi.useFakeTimers();
    const f = makeCase();
    const { adapter, legacy, invoke } = fakeAdapter(f.source);
    invoke.mockImplementation(() => new Promise(() => {}));
    const pending = new CompleteMessageProvider(legacy, f.source, adapter).scoreCandidates([], context);
    const assertion = expect(pending).rejects.toThrow("request_deadline");
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(invoke.mock.calls[0][0].signal.aborted).toBe(true);
    expect(legacy.scoreCandidates).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts repeated context toward the total input budget", async () => {
    const f = makeCase(transcript(Array.from({ length: 24 }, () => 180_000)));
    const { adapter, legacy, invoke } = fakeAdapter(f.source);
    adapter.measureInputTokens = () => 12_000;
    invoke.mockImplementation(async (call) => {
      const payload = JSON.parse(call.payload);
      return { truncated: false, usage: mockUsage(call.stage), output: { version: 1, requestId: payload.request.id, revision: f.source.revision, proposals: [] } } as never;
    });
    await expect(new CompleteMessageProvider(legacy, f.source, adapter).scoreCandidates([], context)).rejects.toThrow("input_token_limit");
    expect(invoke).toHaveBeenCalledTimes(10);
  });

  it("stops output reservations before the 24,000-token analysis limit", async () => {
    const f = makeCase(transcript(Array.from({ length: 27 }, () => 180_000)));
    const { adapter, legacy, invoke } = fakeAdapter(f.source);
    invoke.mockImplementation(async (call) => {
      const payload = JSON.parse(call.payload);
      return { truncated: false, usage: mockUsage(call.stage), output: { version: 1, requestId: payload.request.id, revision: f.source.revision, proposals: [] } };
    });
    await expect(new CompleteMessageProvider(legacy, f.source, adapter).scoreCandidates([], context)).rejects.toThrow("output_token_limit");
    expect(invoke).toHaveBeenCalledTimes(23);
  });

  it("stops after 300 seconds of total work with a supplied clock", async () => {
    const f = makeCase(transcript(Array.from({ length: 10 }, () => 180_000)));
    const { adapter, legacy, invoke } = fakeAdapter(f.source);
    let now = 0;
    invoke.mockImplementation(async (call) => {
      now += 60_000;
      const payload = JSON.parse(call.payload);
      return { truncated: false, usage: mockUsage(call.stage), output: { version: 1, requestId: payload.request.id, revision: f.source.revision, proposals: [] } };
    });
    await expect(new CompleteMessageProvider(legacy, f.source, adapter, () => now).scoreCandidates([], context)).rejects.toThrow("analysis_time_limit");
    expect(invoke).toHaveBeenCalledTimes(5);
  });

  it("retains failed-call usage and refuses its output", async () => {
    const f = makeCase();
    const { adapter, legacy, invoke } = fakeAdapter(f.source);
    invoke.mockResolvedValueOnce({ output: {}, truncated: false, usage: { ...mockUsage("analysis_classification"), outcome: "failed" } });
    const provider = new CompleteMessageProvider(legacy, f.source, adapter);
    await expect(provider.scoreCandidates([], context)).rejects.toThrow("adapter_failed");
    expect(provider.lastUsage?.calls[0].outcome).toBe("failed");
  });

  it("rejects truncated output and usage above its reservation", async () => {
    for (const kind of ["truncated", "usage"]) {
      const f = makeCase();
      const { adapter, legacy, invoke } = fakeAdapter(f.source);
      const original = invoke.getMockImplementation()!;
      invoke.mockImplementation(async (call) => {
        const response = await original(call);
        if (kind === "truncated") response.truncated = true;
        else response.usage.outputTokens = 1_025;
        return response;
      });
      await expect(new CompleteMessageProvider(legacy, f.source, adapter).scoreCandidates([], context)).rejects.toThrow(
        kind === "truncated" ? "truncated_response" : "reservation_exceeded",
      );
      expect(invoke).toHaveBeenCalledTimes(1);
    }
  });
});
