import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { TranscriptSegmentInput } from "@/lib/analysis/chunking";
import { generateSermonOutline, renderMarkedText } from "@/lib/analysis/outline/claude-outline";

const USAGE = {
  input_tokens: 1000,
  output_tokens: 200,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

function streamResult(payload: unknown, stopReason = "end_turn") {
  return {
    finalMessage: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }],
      usage: USAGE,
      stop_reason: stopReason,
    }),
  };
}

function fakeClient(streamMock: ReturnType<typeof vi.fn>): Anthropic {
  return { messages: { stream: streamMock } } as unknown as Anthropic;
}

function makeSegments(count: number): TranscriptSegmentInput[] {
  return Array.from({ length: count }, (_, i) => ({
    idx: i,
    startMs: i * 2_000,
    endMs: (i + 1) * 2_000,
    text: `Sentence number ${i} about the passage.`,
  }));
}

describe("renderMarkedText", () => {
  it("injects segment anchor markers periodically", () => {
    const marked = renderMarkedText(makeSegments(60));
    expect(marked).toContain("[S0]");
    expect(marked).toContain("[S10]");
    // Not every ~2s segment gets a marker.
    expect(marked).not.toContain("[S1]");
  });
});

describe("generateSermonOutline", () => {
  it("produces a generated outline with exclusions from block triage", async () => {
    // 3 blocks of 4 minutes: worship, preaching, preaching.
    const segments = makeSegments(360);
    const streamMock = vi
      .fn()
      .mockReturnValueOnce(
        streamResult({
          blocks: [
            { blockIdx: 0, contentType: "worship", summary: "Songs." },
            { blockIdx: 1, contentType: "preaching", summary: "Intro and first point." },
            { blockIdx: 2, contentType: "preaching", summary: "Second point and close." },
          ],
        }),
      )
      .mockReturnValueOnce(
        streamResult({
          mainIdea: "God keeps his promises.",
          title: "Promises Kept",
          confidence: 0.9,
          sections: [
            { type: "introduction", heading: "Waiting on God", summary: "Setup.", startSegment: 120, endSegment: 199, confidence: 0.9 },
            { type: "point", heading: "Trust the promise", summary: "The point.", startSegment: 200, endSegment: 299, confidence: 0.85 },
            { type: "conclusion", heading: "Hold on", summary: "Landing.", startSegment: 300, endSegment: 359, confidence: 0.8 },
          ],
          refinedExclusions: [],
        }),
      );

    const { draft, calls } = await generateSermonOutline(segments, fakeClient(streamMock));

    expect(draft.status).toBe("generated");
    expect(draft.mainIdea).toBe("God keeps his promises.");
    expect(draft.generatedTitle).toBe("Promises Kept");
    expect(draft.sections.map((s) => s.type)).toEqual(["introduction", "point", "conclusion"]);
    expect(draft.sections[0].startMs).toBe(120 * 2_000);
    // The worship block became an exclusion range, not a section.
    expect(draft.exclusions.some((e) => e.reason === "worship" && e.startMs === 0)).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("captures refined intra-block exclusions (conclusion drifting into invitation)", async () => {
    const segments = makeSegments(240);
    const streamMock = vi
      .fn()
      .mockReturnValueOnce(
        streamResult({
          blocks: [
            { blockIdx: 0, contentType: "preaching", summary: "Message." },
            { blockIdx: 1, contentType: "preaching", summary: "Close and invitation." },
          ],
        }),
      )
      .mockReturnValueOnce(
        streamResult({
          mainIdea: "Grace is enough.",
          title: "Enough",
          confidence: 0.8,
          sections: [
            { type: "introduction", heading: "Opening", summary: "Setup.", startSegment: 0, endSegment: 99, confidence: 0.8 },
            { type: "conclusion", heading: "Closing", summary: "Landing.", startSegment: 100, endSegment: 199, confidence: 0.8 },
          ],
          refinedExclusions: [
            { startSegment: 200, endSegment: 239, reason: "invitation" },
          ],
        }),
      );

    const { draft } = await generateSermonOutline(segments, fakeClient(streamMock));
    expect(draft.exclusions).toContainEqual({
      startMs: 200 * 2_000,
      endMs: 240 * 2_000,
      reason: "invitation",
    });
  });

  it("falls down the reliability ladder to a single Main Message section when the AI fails", async () => {
    const streamMock = vi.fn().mockReturnValue(streamResult("not-json{"));
    const { draft } = await generateSermonOutline(makeSegments(100), fakeClient(streamMock));
    expect(draft.status).toBe("fallback_single");
    expect(draft.sections).toHaveLength(1);
    expect(draft.sections[0].heading).toBe("Main Message");
    // Two ladder attempts (full, then simple) each burned a classify call before failing.
    expect(streamMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("runs only deterministic tiers without a client", async () => {
    const { draft, calls } = await generateSermonOutline(makeSegments(100), null);
    expect(draft.status).toBe("fallback_single");
    expect(calls).toHaveLength(0);
  });
});
