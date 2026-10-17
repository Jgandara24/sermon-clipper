import { describe, expect, it } from "vitest";
import { containedRangeMapping } from "@/lib/media/range-batch";
import { sourceTimeToArtifact } from "@/lib/media-artifacts/types";
describe("registered range coverage", () => {
  it("claims only integer boundaries contained within fractional extracted media", () => {
    const mapping = containedRangeMapping({ startMs: { numerator: "1001", denominator: "3" },
      endMs: { numerator: "2002", denominator: "3" } }, 5000);
    expect(mapping).toEqual({ sourceInterval: { startMs: 334, endMs: 667 }, artifactOriginMs: 5334, timeScale: "1:1" });
    expect(sourceTimeToArtifact(mapping, 500)).toBe(5500);
    expect(() => sourceTimeToArtifact(mapping, 333)).toThrow();
  });
  it("rejects empty contained intervals and unsafe clocks", () => {
    expect(() => containedRangeMapping({ startMs: { numerator: "1", denominator: "3" }, endMs: 1 }, 0)).toThrow();
    expect(() => containedRangeMapping({ startMs: 1, endMs: 2 }, Number.MAX_SAFE_INTEGER)).toThrow();
  });
});
