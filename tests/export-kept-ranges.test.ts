import { describe, expect, it } from "vitest";
import { computeKeptRanges, mapToKeptTimeline } from "@/lib/export/kept-ranges";

describe("computeKeptRanges", () => {
  it("returns the full range when nothing is deleted", () => {
    const ranges = computeKeptRanges([{ startMs: 1000, endMs: 1500, effectiveDeleted: false }], 0, 5000);
    expect(ranges).toEqual([{ startMs: 0, endMs: 5000 }]);
  });

  it("splits around a single deleted word", () => {
    const ranges = computeKeptRanges(
      [
        { startMs: 1000, endMs: 1500, effectiveDeleted: false },
        { startMs: 2000, endMs: 2500, effectiveDeleted: true },
        { startMs: 3000, endMs: 3500, effectiveDeleted: false },
      ],
      0,
      5000,
    );
    expect(ranges).toEqual([
      { startMs: 0, endMs: 2000 },
      { startMs: 2500, endMs: 5000 },
    ]);
  });

  it("merges adjacent/overlapping deleted words into one cut", () => {
    const ranges = computeKeptRanges(
      [
        { startMs: 1000, endMs: 1500, effectiveDeleted: true },
        { startMs: 1500, endMs: 2000, effectiveDeleted: true },
        { startMs: 1900, endMs: 2200, effectiveDeleted: true },
      ],
      0,
      5000,
    );
    expect(ranges).toEqual([
      { startMs: 0, endMs: 1000 },
      { startMs: 2200, endMs: 5000 },
    ]);
  });

  it("drops a leading kept range entirely if the cut starts at the source start", () => {
    const ranges = computeKeptRanges([{ startMs: 0, endMs: 1000, effectiveDeleted: true }], 0, 5000);
    expect(ranges).toEqual([{ startMs: 1000, endMs: 5000 }]);
  });

  it("returns an empty array when the whole range is deleted", () => {
    const ranges = computeKeptRanges([{ startMs: 0, endMs: 5000, effectiveDeleted: true }], 0, 5000);
    expect(ranges).toEqual([]);
  });
});

describe("mapToKeptTimeline", () => {
  const ranges = [
    { startMs: 0, endMs: 2000 },
    { startMs: 2500, endMs: 5000 },
  ];

  it("maps a timestamp in the first kept range to itself", () => {
    expect(mapToKeptTimeline(500, ranges)).toBe(500);
  });

  it("maps a timestamp in the second kept range past the compressed gap", () => {
    // 3000 is 500ms into the second range; output timeline continues right after the first
    // range's 2000ms, so it should land at 2000 + 500 = 2500.
    expect(mapToKeptTimeline(3000, ranges)).toBe(2500);
  });

  it("maps the very end of the last range to the total kept duration", () => {
    expect(mapToKeptTimeline(5000, ranges)).toBe(4500);
  });
});
