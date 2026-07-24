import { describe, expect, it } from "vitest";
import type { TranscriptSegmentInput } from "@/lib/analysis/chunking";
import type { DiscoveredMoment } from "@/lib/analysis/semantic/discovery";
import { resolveMomentAnchors } from "@/lib/analysis/semantic/resolve";

function makeSegments(count: number, texts: Record<number, string> = {}): TranscriptSegmentInput[] {
  return Array.from({ length: count }, (_, i) => ({
    idx: i,
    startMs: i * 2_000,
    endMs: (i + 1) * 2_000,
    text: texts[i] ?? `Sentence number ${i} carries the thought forward.`,
  }));
}

function moment(overrides: Partial<DiscoveredMoment>): DiscoveredMoment {
  return {
    sectionPosition: 0,
    momentType: "teaching",
    startSegmentIdx: 10,
    endSegmentIdx: 25,
    note: "A complete teaching moment.",
    ...overrides,
  };
}

const OPTIONS = { minMs: 20_000, maxMs: 90_000, exclusions: [] };

describe("resolveMomentAnchors", () => {
  it("resolves anchors to real segment timestamps and joined text", () => {
    const segments = makeSegments(100);
    const [resolved] = resolveMomentAnchors([moment({})], segments, OPTIONS);
    expect(resolved.startMs).toBe(10 * 2_000);
    expect(resolved.endMs).toBe(26 * 2_000);
    expect(resolved.segmentIndexes).toEqual(Array.from({ length: 16 }, (_, i) => i + 10));
    expect(resolved.sectionPosition).toBe(0);
  });

  it("extends a too-short moment forward to reach the minimum duration", () => {
    const segments = makeSegments(100);
    const [resolved] = resolveMomentAnchors(
      [moment({ startSegmentIdx: 10, endSegmentIdx: 12 })],
      segments,
      OPTIONS,
    );
    expect(resolved.endMs - resolved.startMs).toBeGreaterThanOrEqual(20_000);
  });

  it("trims a too-long moment, preferring an end followed by a pause", () => {
    const segments = makeSegments(200);
    // 3s silence after segment 30 (60s into the nominated span).
    for (let i = 31; i < segments.length; i += 1) {
      segments[i] = { ...segments[i], startMs: segments[i].startMs + 3_000, endMs: segments[i].endMs + 3_000 };
    }
    const [resolved] = resolveMomentAnchors(
      [moment({ startSegmentIdx: 0, endSegmentIdx: 199 })],
      segments,
      OPTIONS,
    );
    expect(resolved.endMs - resolved.startMs).toBeLessThanOrEqual(90_000);
    expect(resolved.endMs).toBe(segments[30].endMs);
  });

  it("snaps a mid-clause start back to a sentence start", () => {
    const segments = makeSegments(100, { 10: "and that is why this matters so much." });
    const [resolved] = resolveMomentAnchors([moment({})], segments, OPTIONS);
    expect(resolved.startMs).toBe(9 * 2_000);
  });

  it("cuts a moment's tail before an exclusion range (conclusion drifting into invitation)", () => {
    const segments = makeSegments(100);
    const exclusions = [{ startMs: 40_000, endMs: 60_000, reason: "invitation" as const }];
    const [resolved] = resolveMomentAnchors(
      [moment({ startSegmentIdx: 5, endSegmentIdx: 25 })],
      segments,
      { ...OPTIONS, exclusions },
    );
    expect(resolved.endMs).toBeLessThanOrEqual(40_000);
    expect(resolved.endMs - resolved.startMs).toBeGreaterThanOrEqual(20_000);
  });

  it("rejects a moment with no clean cut clear of exclusions", () => {
    const segments = makeSegments(100);
    const exclusions = [{ startMs: 0, endMs: 200_000, reason: "worship" as const }];
    expect(resolveMomentAnchors([moment({})], segments, { ...OPTIONS, exclusions })).toHaveLength(0);
  });

  it("collapses near-duplicate moments, keeping the earlier nomination", () => {
    const segments = makeSegments(100);
    const resolved = resolveMomentAnchors(
      [
        moment({ startSegmentIdx: 10, endSegmentIdx: 25, sectionPosition: 0 }),
        moment({ startSegmentIdx: 11, endSegmentIdx: 26, sectionPosition: 1 }),
      ],
      segments,
      OPTIONS,
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0].sectionPosition).toBe(0);
  });
});
