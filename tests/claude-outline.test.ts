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
            { blockIdx: 0, contentType: "worship", summary: "Songs.", confidence: 0.95, mixed: false },
            { blockIdx: 1, contentType: "preaching", summary: "Intro and first point.", confidence: 0.9, mixed: false },
            { blockIdx: 2, contentType: "preaching", summary: "Second point and close.", confidence: 0.9, mixed: false },
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
            { blockIdx: 0, contentType: "preaching", summary: "Message.", confidence: 0.9, mixed: false },
            { blockIdx: 1, contentType: "preaching", summary: "Close and invitation.", confidence: 0.9, mixed: false },
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

  it("fails closed on missing or low-confidence block classifications", async () => {
    // Block 0 is preaching but uncertain (0.3), block 1 has no classification at all, block 2
    // is confidently preaching. Only block 2 may produce sections; 0 and 1 become exclusions.
    const segments = makeSegments(360);
    const streamMock = vi
      .fn()
      .mockReturnValueOnce(
        streamResult({
          blocks: [
            { blockIdx: 0, contentType: "preaching", summary: "Unsure.", confidence: 0.3, mixed: false },
            { blockIdx: 2, contentType: "preaching", summary: "Clear preaching.", confidence: 0.9, mixed: false },
          ],
        }),
      )
      .mockReturnValueOnce(
        streamResult({
          mainIdea: "Idea.",
          title: "Title",
          confidence: 0.8,
          sections: [
            { type: "introduction", heading: "Open", summary: "s", startSegment: 240, endSegment: 299, confidence: 0.8 },
            { type: "conclusion", heading: "Close", summary: "s", startSegment: 300, endSegment: 359, confidence: 0.8 },
          ],
          refinedExclusions: [],
        }),
      );

    const { draft } = await generateSermonOutline(segments, fakeClient(streamMock));
    expect(draft.status).toBe("generated");
    // Blocks 0 and 1 merged into one fail-closed exclusion covering the first two blocks.
    expect(draft.exclusions).toContainEqual({ startMs: 0, endMs: 240 * 2_000, reason: "not_preaching" });
    expect(draft.sections[0].startMs).toBe(240 * 2_000);
  });

  it("refines mixed preaching blocks at segment level", async () => {
    const segments = makeSegments(240);
    const streamMock = vi
      .fn()
      .mockReturnValueOnce(
        streamResult({
          blocks: [
            { blockIdx: 0, contentType: "preaching", summary: "Mostly preaching.", confidence: 0.9, mixed: true },
            { blockIdx: 1, contentType: "preaching", summary: "Preaching.", confidence: 0.9, mixed: false },
          ],
        }),
      )
      .mockReturnValueOnce(
        streamResult({
          exclusions: [{ startSegment: 100, endSegment: 119, reason: "announcement" }],
        }),
      )
      .mockReturnValueOnce(
        streamResult({
          mainIdea: "Idea.",
          title: "Title",
          confidence: 0.8,
          sections: [
            { type: "introduction", heading: "Open", summary: "s", startSegment: 0, endSegment: 99, confidence: 0.8 },
            { type: "conclusion", heading: "Close", summary: "s", startSegment: 120, endSegment: 239, confidence: 0.8 },
          ],
          refinedExclusions: [],
        }),
      );

    const { draft, calls } = await generateSermonOutline(segments, fakeClient(streamMock));
    expect(calls).toHaveLength(3);
    expect(draft.exclusions).toContainEqual({
      startMs: 100 * 2_000,
      endMs: 120 * 2_000,
      reason: "announcement",
    });
  });

  it("excludes a mixed block wholesale when segment refinement fails", async () => {
    const segments = makeSegments(240);
    const streamMock = vi
      .fn()
      .mockReturnValueOnce(
        streamResult({
          blocks: [
            { blockIdx: 0, contentType: "preaching", summary: "Mixed.", confidence: 0.9, mixed: true },
            { blockIdx: 1, contentType: "preaching", summary: "Preaching.", confidence: 0.9, mixed: false },
          ],
        }),
      )
      .mockReturnValueOnce(streamResult("not-json{"))
      .mockReturnValueOnce(
        streamResult({
          mainIdea: "Idea.",
          title: "Title",
          confidence: 0.8,
          sections: [
            { type: "introduction", heading: "Open", summary: "s", startSegment: 120, endSegment: 179, confidence: 0.8 },
            { type: "conclusion", heading: "Close", summary: "s", startSegment: 180, endSegment: 239, confidence: 0.8 },
          ],
          refinedExclusions: [],
        }),
      );

    const { draft } = await generateSermonOutline(segments, fakeClient(streamMock));
    expect(draft.exclusions).toContainEqual({ startMs: 0, endMs: 120 * 2_000, reason: "not_preaching" });
    expect(draft.sections[0].startMs).toBe(120 * 2_000);
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
