import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptSegmentInput } from "@/lib/analysis/chunking";
import { roundRobinBySection, runSemanticPipeline, semanticPipelineEnabled } from "@/lib/analysis/semantic/pipeline";
import type { ResolvedCandidate } from "@/lib/analysis/semantic/resolve";

const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { stream: streamMock };
  },
}));

const USAGE = {
  input_tokens: 1000,
  output_tokens: 200,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

function streamResult(payload: unknown) {
  return {
    finalMessage: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify(payload) }],
      usage: USAGE,
      stop_reason: "end_turn",
    }),
  };
}

function makeSegments(count: number): TranscriptSegmentInput[] {
  return Array.from({ length: count }, (_, i) => ({
    idx: i,
    startMs: i * 2_000,
    endMs: (i + 1) * 2_000,
    text: `Sentence number ${i} about hope and grace.`,
  }));
}

const subscore = { score: 80, note: "solid" };
function stageBClip(index: number) {
  return {
    index,
    title: `Clip ${index}`,
    hookText: "A strong hook",
    summary: "A clear standalone moment.",
    excerpt: "quoted text",
    subscores: {
      hookStrength: subscore,
      clarity: subscore,
      emotionalImpact: subscore,
      completeness: subscore,
      shareability: subscore,
      topicRelevance: subscore,
    },
  };
}

const BLOCK_CLASSIFY = streamResult({
  blocks: [
    { blockIdx: 0, contentType: "preaching", summary: "Intro.", confidence: 0.9, mixed: false },
    { blockIdx: 1, contentType: "preaching", summary: "Point and close.", confidence: 0.9, mixed: false },
  ],
});

const COMPOSE = streamResult({
  mainIdea: "God keeps his promises.",
  title: "Promises Kept",
  confidence: 0.9,
  sections: [
    { type: "introduction", heading: "Waiting", summary: "Setup.", startSegment: 0, endSegment: 119, confidence: 0.9 },
    { type: "point", heading: "Trusting", summary: "The point.", startSegment: 120, endSegment: 239, confidence: 0.85 },
  ],
  refinedExclusions: [],
});

const PIPELINE_INPUT = {
  segments: makeSegments(240),
  fullText: "full transcript",
  genre: "sermon",
  sourceDurationMs: 480_000,
  maxClips: 18,
  minMs: 20_000,
  maxMs: 90_000,
  video: null,
};

beforeEach(() => {
  streamMock.mockReset();
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  // The gate's ffmpeg/vision path is exercised in visual-gate tests; keep the pipeline
  // deterministic here.
  process.env.ANALYSIS_VISUAL_GATE = "off";
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANALYSIS_VISUAL_GATE;
  delete process.env.ANALYSIS_SEMANTIC_OUTLINE;
});

describe("semanticPipelineEnabled", () => {
  it("defaults on and honors the off switch", () => {
    expect(semanticPipelineEnabled()).toBe(true);
    process.env.ANALYSIS_SEMANTIC_OUTLINE = "off";
    expect(semanticPipelineEnabled()).toBe(false);
  });
});

describe("runSemanticPipeline", () => {
  it("produces section-associated, rank-ordered clips end to end", async () => {
    streamMock
      .mockReturnValueOnce(BLOCK_CLASSIFY)
      .mockReturnValueOnce(COMPOSE)
      .mockReturnValueOnce(
        streamResult({
          moments: [{ momentType: "teaching", startSegment: 10, endSegment: 30, note: "n" }],
        }),
      )
      .mockReturnValueOnce(
        streamResult({
          moments: [{ momentType: "quotable", startSegment: 150, endSegment: 170, note: "n" }],
        }),
      )
      .mockReturnValueOnce(streamResult({ scoredClips: [stageBClip(0), stageBClip(1)] }));

    const result = await runSemanticPipeline(PIPELINE_INPUT);

    expect(result.fallbackReason).toBeNull();
    expect(result.outline.status).toBe("generated");
    expect(result.clips).toHaveLength(2);
    expect(result.clips!.map((c) => c.sectionPosition)).toEqual([0, 1]);
    // Equal totals fall back to sermon order; scores descend down the list.
    expect(result.clips![0].total).toBeGreaterThanOrEqual(result.clips![1].total);
    expect(result.visualGateStatus).toBe("skipped_disabled");
    // Every model call is accounted for in usage: classify, compose, 2 discoveries, scoring.
    expect(result.calls).toHaveLength(5);
    expect(result.diagnostics.sections).toBe(2);
    expect(result.diagnostics.momentsDiscovered).toBe(2);
  });

  it("signals window-pipeline fallback when no API key is configured", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await runSemanticPipeline(PIPELINE_INPUT);
    expect(result.clips).toBeNull();
    expect(result.fallbackReason).toBe("provider_unavailable");
    // Outline still exists via the deterministic tiers.
    expect(result.outline.sections.length).toBeGreaterThanOrEqual(1);
    expect(streamMock).not.toHaveBeenCalled();
  });

  it("signals fallback when the AI outline degrades to a lower tier", async () => {
    streamMock.mockReturnValue(streamResult("not-json"));
    const result = await runSemanticPipeline(PIPELINE_INPUT);
    expect(result.clips).toBeNull();
    expect(result.fallbackReason).toBe("outline_fallback_single");
  });

  it("signals fallback when moment discovery finds nothing", async () => {
    streamMock
      .mockReturnValueOnce(BLOCK_CLASSIFY)
      .mockReturnValueOnce(COMPOSE)
      .mockReturnValueOnce(streamResult({ moments: [] }))
      .mockReturnValueOnce(streamResult({ moments: [] }));

    const result = await runSemanticPipeline(PIPELINE_INPUT);
    expect(result.clips).toBeNull();
    expect(result.fallbackReason).toBe("discovery_empty");
    // The outline itself survived — only clip discovery fell back.
    expect(result.outline.status).toBe("generated");
  });

  it("keeps a failed single-section discovery from starving other sections", async () => {
    streamMock
      .mockReturnValueOnce(BLOCK_CLASSIFY)
      .mockReturnValueOnce(COMPOSE)
      .mockReturnValueOnce({
        finalMessage: vi.fn().mockRejectedValue(new Error("boom")),
      })
      .mockReturnValueOnce(
        streamResult({
          moments: [{ momentType: "story", startSegment: 150, endSegment: 175, note: "n" }],
        }),
      )
      .mockReturnValueOnce(streamResult({ scoredClips: [stageBClip(0)] }));

    const result = await runSemanticPipeline(PIPELINE_INPUT);
    expect(result.clips).toHaveLength(1);
    expect(result.clips![0].sectionPosition).toBe(1);
  });
});

describe("roundRobinBySection", () => {
  function resolved(sectionPosition: number, startMs: number): ResolvedCandidate {
    return {
      startMs,
      endMs: startMs + 30_000,
      text: "t",
      segmentIndexes: [],
      sectionPosition,
      momentType: "teaching",
      note: "",
    };
  }

  it("keeps every section represented when capping", () => {
    const candidates = [
      ...Array.from({ length: 10 }, (_, i) => resolved(0, i * 1_000)),
      ...Array.from({ length: 10 }, (_, i) => resolved(1, 100_000 + i * 1_000)),
    ];
    const capped = roundRobinBySection(candidates, 6);
    expect(capped).toHaveLength(6);
    expect(capped.filter((c) => c.sectionPosition === 0)).toHaveLength(3);
    expect(capped.filter((c) => c.sectionPosition === 1)).toHaveLength(3);
  });

  it("passes small pools through unchanged", () => {
    const candidates = [resolved(0, 0), resolved(1, 50_000)];
    expect(roundRobinBySection(candidates, 25)).toEqual(candidates);
  });
});
