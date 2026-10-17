import { expect, it } from "vitest";
import { sampleProxyViewFrames } from "@/lib/media/proxy-view-sampling";
const sampling = { sourceInterval: { startMs: 0, endMs: 1001 }, count: 3, maxDistanceMs: 100 };
it("selects observed variable-rate frames and records target offsets", () => {
  expect(sampleProxyViewFrames([0, 120, 480, 760, 1000], sampling)).toMatchObject({
    sourceTimesMs: [0, 480, 1000], selections: [
      { targetMs: 0, sourceTimeMs: 0, distanceMs: 0 }, { targetMs: 500, sourceTimeMs: 480, distanceMs: 20 },
      { targetMs: 1000, sourceTimeMs: 1000, distanceMs: 0 },
    ],
  });
});
it("chooses the earlier observed frame on a tie and uses a midpoint for one cell", () => {
  expect(sampleProxyViewFrames([0, 400, 600, 1000], sampling).sourceTimesMs).toEqual([0, 400, 1000]);
  expect(sampleProxyViewFrames([0, 400, 600, 1000], { ...sampling, count: 1 }).sourceTimesMs).toEqual([400]);
});
it("refuses sparse, distant, duplicate, or unordered samples", () => {
  expect(() => sampleProxyViewFrames([0, 1000], sampling)).toThrow("INSUFFICIENT");
  expect(() => sampleProxyViewFrames([0, 100, 1000], sampling)).toThrow("DISTANCE");
  expect(() => sampleProxyViewFrames([0, 1000, 1001], { ...sampling,
    sourceInterval: { startMs: 0, endMs: 1002 }, maxDistanceMs: 1000 })).toThrow("DUPLICATE");
  expect(() => sampleProxyViewFrames([0, 0, 1000], sampling)).toThrow("UNORDERED");
});
it("never includes observations outside the requested half-open window", () => {
  const result = sampleProxyViewFrames([0, 100, 200, 300, 400], {
    sourceInterval: { startMs: 100, endMs: 400 }, count: 2, maxDistanceMs: 100,
  });
  expect(result.sourceTimesMs).toEqual([100, 300]);
});
