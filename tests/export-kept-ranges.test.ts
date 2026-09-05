import { describe, expect, it } from "vitest";
import { computeKeptRanges } from "@/lib/export/kept-ranges";

// The continuity gate's arithmetic. The renderer no longer reads these ranges — a deliverable is
// one span rendered in one pass — but the gate still has to say what a document's cuts would have
// left, so that it can refuse the two shapes that are not one full span.
describe("computeKeptRanges", () => {
  it("returns the full range when nothing is deleted", () => {
    const ranges = computeKeptRanges([{ startMs: 1000, endMs: 1500, effectiveDeleted: false }], 0, 5000);
    expect(ranges).toEqual([{ startMs: 0, endMs: 5000 }]);
  });

  it("splits around a single deleted word — the shape the gate refuses", () => {
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

  it("narrows the span when the cut starts at the source start — the other shape the gate refuses", () => {
    const ranges = computeKeptRanges([{ startMs: 0, endMs: 1000, effectiveDeleted: true }], 0, 5000);
    expect(ranges).toEqual([{ startMs: 1000, endMs: 5000 }]);
  });

  it("returns an empty array when the whole range is deleted", () => {
    const ranges = computeKeptRanges([{ startMs: 0, endMs: 5000, effectiveDeleted: true }], 0, 5000);
    expect(ranges).toEqual([]);
  });
});
