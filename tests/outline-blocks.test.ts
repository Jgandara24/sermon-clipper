import { describe, expect, it } from "vitest";
import { buildAnalysisBlocks } from "@/lib/analysis/outline/blocks";
import type { TranscriptSegmentInput } from "@/lib/analysis/chunking";

function makeSegments(count: number, segmentMs = 2_000): TranscriptSegmentInput[] {
  return Array.from({ length: count }, (_, i) => ({
    idx: i,
    startMs: i * segmentMs,
    endMs: (i + 1) * segmentMs,
    text: `Sentence number ${i}.`,
  }));
}

describe("buildAnalysisBlocks", () => {
  it("returns no blocks for an empty transcript", () => {
    expect(buildAnalysisBlocks([])).toHaveLength(0);
  });

  it("covers every segment exactly once, in order", () => {
    const segments = makeSegments(600); // 20 minutes
    const blocks = buildAnalysisBlocks(segments);
    const coveredIdx = blocks.flatMap((b) => b.segments.map((s) => s.idx));
    expect(coveredIdx).toEqual(segments.map((s) => s.idx));
  });

  it("produces blocks near the duration target", () => {
    const segments = makeSegments(600);
    const blocks = buildAnalysisBlocks(segments, { targetBlockMs: 240_000 });
    expect(blocks.length).toBe(5);
    for (const block of blocks) {
      const duration = block.endMs - block.startMs;
      expect(duration).toBeGreaterThanOrEqual(200_000);
      expect(duration).toBeLessThanOrEqual(250_000);
    }
  });

  it("closes a block early at a long pause once past half the target", () => {
    const segments = makeSegments(300);
    // Insert a 5s silence after segment 75 (150s in — past half of the 240s target).
    for (let i = 76; i < segments.length; i += 1) {
      segments[i] = { ...segments[i], startMs: segments[i].startMs + 5_000, endMs: segments[i].endMs + 5_000 };
    }
    const blocks = buildAnalysisBlocks(segments, { targetBlockMs: 240_000 });
    expect(blocks[0].endSegmentIdx).toBe(75);
  });

  it("merges an undersized trailing block into its predecessor", () => {
    // 4 minutes + 20 seconds: the 20s remainder must not become its own block.
    const segments = makeSegments(130);
    const blocks = buildAnalysisBlocks(segments, { targetBlockMs: 240_000 });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].endSegmentIdx).toBe(129);
  });
});
