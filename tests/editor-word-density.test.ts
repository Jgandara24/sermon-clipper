import { describe, expect, it } from "vitest";
import {
  chooseDensityBucketMs,
  DENSITY_BUCKET_MIN_MS,
  DENSITY_MAX_BARS,
  wordDensityBars,
} from "@/lib/editor/word-density";

describe("wordDensityBars", () => {
  const view = { start: 0, end: 1_000 };

  it("cuts the window into fixed-width buckets, the last one partial", () => {
    expect(wordDensityBars([], view, 300)).toHaveLength(4);
  });

  it("scales every bar by the busiest bucket, so the fullest bar is full height", () => {
    // Three words begin in the first bucket, one in the second, none in the rest.
    expect(wordDensityBars([0, 50, 100, 400], view, 300)).toEqual([1, 1 / 3, 0, 0]);
  });

  it("ignores words outside the window, and does not need them sorted", () => {
    expect(wordDensityBars([950, -1, 1_000, 5_000, 20], view, 500)).toEqual([1, 1]);
  });

  it("counts a word at the window's start and not one at its end", () => {
    expect(wordDensityBars([0], view, 500)).toEqual([1, 0]);
    expect(wordDensityBars([1_000], view, 500)).toEqual([0, 0]);
  });

  it("is all zeros for a silent window, never NaN", () => {
    expect(wordDensityBars([], view, 250)).toEqual([0, 0, 0, 0]);
  });

  it("is empty for a window with no width", () => {
    expect(wordDensityBars([10], { start: 5, end: 5 }, 100)).toEqual([]);
    expect(wordDensityBars([10], view, 0)).toEqual([]);
  });

  it("puts a word in the bucket its start falls in, on the source's own timeline", () => {
    const later = { start: 60_000, end: 61_000 };
    expect(wordDensityBars([60_700], later, 250)).toEqual([0, 0, 1, 0]);
  });
});

describe("chooseDensityBucketMs", () => {
  it("never goes below the minimum bucket", () => {
    expect(chooseDensityBucketMs(6_000)).toBe(DENSITY_BUCKET_MIN_MS);
  });

  it("widens the bucket so a long window never draws more bars than the row can show", () => {
    for (const span of [6_000, 60_000, 135_000, 600_000, 3_600_000]) {
      const bucket = chooseDensityBucketMs(span);
      expect(bucket % DENSITY_BUCKET_MIN_MS).toBe(0);
      expect(Math.ceil(span / bucket)).toBeLessThanOrEqual(DENSITY_MAX_BARS);
    }
  });

  it("rounds up to the next whole minimum bucket rather than down", () => {
    // 600s over 160 bars is 3.75s; 3.7s would draw 163 bars.
    expect(chooseDensityBucketMs(600_000)).toBe(3_800);
  });
});
