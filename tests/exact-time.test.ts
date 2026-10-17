import { describe, expect, it } from "vitest";
import { addTimeMs, compareTimeMs, exactTimeMs, exactTimeMsSchema, normalizeTimeMs, subtractTimeMs } from "@/lib/media/exact-time";
import { planCandidateRanges } from "@/lib/media/candidate-ranges";
const fraction = (numerator: string, denominator: string) => ({ numerator, denominator });
describe("exact millisecond clocks", () => {
  it("reduces fractions and emits integers without floating-point conversion", () => {
    expect(normalizeTimeMs(fraction("2002", "6"))).toEqual(fraction("1001", "3"));
    expect(normalizeTimeMs(fraction("6", "3"))).toBe(2);
    expect(exactTimeMs(BigInt(0), BigInt(3))).toBe(0);
  });
  it("compares and subtracts nearly equal times near the safe integer bound", () => {
    const numerator = BigInt(Number.MAX_SAFE_INTEGER) * BigInt(3) - BigInt(1);
    const nearEnd = fraction(String(numerator), "3");
    expect(compareTimeMs(nearEnd, Number.MAX_SAFE_INTEGER)).toBe(-1);
    expect(subtractTimeMs(Number.MAX_SAFE_INTEGER, nearEnd)).toEqual(fraction("1", "3"));
    expect(addTimeMs(nearEnd, fraction("1", "3"))).toBe(Number.MAX_SAFE_INTEGER);
  });
  it("rejects invalid fractions, negative results, and out-of-bounds sums", () => {
    for (const value of [fraction("1", "0"), fraction("-1", "3"), fraction("01", "3"), 0.5,
      fraction("1".repeat(129), "3"), fraction("9007199254740992", "1")]) {
      expect(exactTimeMsSchema.safeParse(value).success).toBe(false);
    }
    expect(() => subtractTimeMs(0, fraction("1", "3"))).toThrow();
    expect(() => addTimeMs(Number.MAX_SAFE_INTEGER, fraction("1", "3"))).toThrow();
  });
  it("keeps exact fractional boundaries, durations, and stable plan identity", () => {
    const request = { sourceSha256: "a".repeat(64), sourceDurationMs: 10,
      handles: { beforeMs: 0, afterMs: 0 },
      candidates: [{ candidateId: "one", sourceInterval: { startMs: 1, endMs: 2 } }],
      keyframeTimesMs: [0, fraction("2", "3"), fraction("7", "3"), 4] };
    const result = planCandidateRanges(request);
    expect(result.ranges[0].sourceInterval).toEqual({ startMs: fraction("2", "3"), endMs: fraction("7", "3") });
    expect(result.totalRangeDurationMs).toEqual(fraction("5", "3"));
    expect(planCandidateRanges({ ...request, keyframeTimesMs: [fraction("0", "3"), fraction("4", "6"), fraction("14", "6"), 4] }))
      .toEqual(result);
    expect(() => planCandidateRanges({ ...request, keyframeTimesMs: [fraction("2", "3"), fraction("4", "6")] }))
      .toThrow("INVALID_KEYFRAME_CLOCK");
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});
