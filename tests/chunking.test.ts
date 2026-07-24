import { describe, expect, it } from "vitest";
import {
  buildCandidateWindows,
  computeIoU,
  dedupByOverlap,
  refineBoundaries,
  type TranscriptSegmentInput,
} from "@/lib/analysis/chunking";

const SEGMENTS: TranscriptSegmentInput[] = [
  { idx: 0, startMs: 0, endMs: 8_000, text: "Peace is not the absence of trouble." },
  { idx: 1, startMs: 8_000, endMs: 20_000, text: "It is the presence of a steady God in the middle of it." },
  { idx: 2, startMs: 20_000, endMs: 45_000, text: "Turn with me to the book of John, chapter fourteen." },
  { idx: 3, startMs: 45_000, endMs: 46_000, text: "um" },
  { idx: 4, startMs: 46_000, endMs: 70_000, text: "Jesus tells his disciples not to let their hearts be troubled." },
];

describe("buildCandidateWindows", () => {
  it("builds windows within the requested duration range", () => {
    const candidates = buildCandidateWindows(SEGMENTS, { minMs: 15_000, maxMs: 50_000 });

    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      const duration = candidate.endMs - candidate.startMs;
      expect(duration).toBeGreaterThanOrEqual(15_000);
      expect(duration).toBeLessThanOrEqual(50_000);
    }
  });

  it("includes a window spanning the first two segments", () => {
    const candidates = buildCandidateWindows(SEGMENTS, { minMs: 15_000, maxMs: 25_000 });
    expect(candidates.some((c) => c.startMs === 0 && c.endMs === 20_000)).toBe(true);
  });

  it("still produces candidates when ASR output has no punctuation or capitalization", () => {
    // Regression test: real whisper.cpp output on some inputs comes back fully lowercase with
    // no punctuation at all, which a stricter capitalization/punctuation-based boundary check
    // rejected outright (confirmed against a real 130s fixture during Phase 4 testing).
    const unpunctuated: TranscriptSegmentInput[] = [
      { idx: 0, startMs: 0, endMs: 20_000, text: "good morning church family turn with me" },
      { idx: 1, startMs: 20_000, endMs: 40_000, text: "peace is not the absence of trouble" },
      { idx: 2, startMs: 40_000, endMs: 60_000, text: "it is the presence of a steady god" },
    ];
    const candidates = buildCandidateWindows(unpunctuated, { minMs: 15_000, maxMs: 50_000 });
    expect(candidates.length).toBeGreaterThan(0);
  });

  it("skips starting a candidate on an obvious mid-clause continuation word", () => {
    const withContinuation: TranscriptSegmentInput[] = [
      { idx: 0, startMs: 0, endMs: 20_000, text: "Peace is not the absence of trouble." },
      { idx: 1, startMs: 20_000, endMs: 40_000, text: "and it is the presence of a steady God." },
    ];
    const candidates = buildCandidateWindows(withContinuation, { minMs: 15_000, maxMs: 25_000 });
    expect(candidates.some((c) => c.startMs === 20_000)).toBe(false);
  });

  it("never exceeds maxCandidates", () => {
    const manySegments: TranscriptSegmentInput[] = Array.from({ length: 100 }, (_, i) => ({
      idx: i,
      startMs: i * 1000,
      endMs: (i + 1) * 1000,
      text: `Sentence number ${i}.`,
    }));
    const candidates = buildCandidateWindows(manySegments, { minMs: 1000, maxMs: 90_000, maxCandidates: 10 });
    expect(candidates.length).toBeLessThanOrEqual(10);
  });

  it("spreads a capped candidate pool across the whole recording, not just the opening", () => {
    // Regression test: the old builder emitted a window at every segment end and truncated at
    // maxCandidates, so a long recording's pool covered only its first ~40 seconds and every
    // suggested clip came from the sermon's opening.
    const durationMs = 50 * 60 * 1000;
    const segmentMs = 2_000;
    const manySegments: TranscriptSegmentInput[] = Array.from(
      { length: durationMs / segmentMs },
      (_, i) => ({
        idx: i,
        startMs: i * segmentMs,
        endMs: (i + 1) * segmentMs,
        text: `Sentence number ${i}.`,
      }),
    );

    const candidates = buildCandidateWindows(manySegments, {
      minMs: 20_000,
      maxMs: 90_000,
      maxCandidates: 500,
    });

    expect(candidates.length).toBeLessThanOrEqual(500);
    const lastStart = Math.max(...candidates.map((c) => c.startMs));
    expect(lastStart).toBeGreaterThan(durationMs * 0.9);
  });

  it("emits a bounded number of windows per start position", () => {
    const manySegments: TranscriptSegmentInput[] = Array.from({ length: 60 }, (_, i) => ({
      idx: i,
      startMs: i * 2_000,
      endMs: (i + 1) * 2_000,
      text: `Sentence number ${i}.`,
    }));
    const candidates = buildCandidateWindows(manySegments, {
      minMs: 20_000,
      maxMs: 90_000,
      maxCandidates: 10_000,
    });
    const fromFirstStart = candidates.filter((c) => c.startMs === 0);
    expect(fromFirstStart.length).toBeLessThanOrEqual(3);
  });

  it("returns no candidates when nothing fits the duration bucket", () => {
    const candidates = buildCandidateWindows(SEGMENTS, { minMs: 500_000, maxMs: 600_000 });
    expect(candidates).toHaveLength(0);
  });
});

describe("refineBoundaries", () => {
  it("pads both edges", () => {
    const result = refineBoundaries({ startMs: 1000, endMs: 5000 }, 100_000, 150);
    expect(result).toMatchObject({ startMs: 850, endMs: 5150 });
  });

  it("clamps to the source duration and zero", () => {
    const start = refineBoundaries({ startMs: 50, endMs: 5000 }, 100_000, 150);
    expect(start.startMs).toBe(0);

    const end = refineBoundaries({ startMs: 1000, endMs: 99_950 }, 100_000, 150);
    expect(end.endMs).toBe(100_000);
  });
});

describe("computeIoU", () => {
  it("is 1 for identical ranges", () => {
    expect(computeIoU({ startMs: 0, endMs: 10_000 }, { startMs: 0, endMs: 10_000 })).toBe(1);
  });

  it("is 0 for non-overlapping ranges", () => {
    expect(computeIoU({ startMs: 0, endMs: 10_000 }, { startMs: 20_000, endMs: 30_000 })).toBe(0);
  });

  it("computes partial overlap correctly", () => {
    // [0,10000] and [5000,15000]: overlap=5000, union=15000
    expect(computeIoU({ startMs: 0, endMs: 10_000 }, { startMs: 5_000, endMs: 15_000 })).toBeCloseTo(
      5_000 / 15_000,
      5,
    );
  });
});

describe("dedupByOverlap", () => {
  it("keeps the higher-scored candidate when two overlap heavily", () => {
    const candidates = [
      { startMs: 0, endMs: 10_000, score: 50, id: "low" },
      { startMs: 1_000, endMs: 11_000, score: 90, id: "high" },
    ];
    const kept = dedupByOverlap(candidates);
    expect(kept.map((c) => c.id)).toEqual(["high"]);
  });

  it("keeps both when overlap is below the threshold", () => {
    const candidates = [
      { startMs: 0, endMs: 10_000, score: 50, id: "a" },
      { startMs: 9_500, endMs: 20_000, score: 90, id: "b" },
    ];
    const kept = dedupByOverlap(candidates, 0.5);
    expect(kept.map((c) => c.id).sort()).toEqual(["a", "b"]);
  });

  it("keeps non-overlapping candidates independent of score order", () => {
    const candidates = [
      { startMs: 0, endMs: 10_000, score: 10, id: "a" },
      { startMs: 100_000, endMs: 110_000, score: 90, id: "b" },
    ];
    const kept = dedupByOverlap(candidates);
    expect(kept.map((c) => c.id).sort()).toEqual(["a", "b"]);
  });
});
