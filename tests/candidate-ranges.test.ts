import { describe, expect, it } from "vitest";
import { compareTimeMs } from "@/lib/media/exact-time";
import { planCandidateRanges, type CandidateRangeRequest } from "@/lib/media/candidate-ranges";

const candidate = (candidateId: string, startMs: number, endMs: number) =>
  ({ candidateId, sourceInterval: { startMs, endMs } });
const base: CandidateRangeRequest = {
  sourceSha256: "a".repeat(64), sourceDurationMs: 20000,
  handles: { beforeMs: 500, afterMs: 500 },
  keyframeTimesMs: [0, 2000, 4000, 6000, 8000, 10000, 12000, 14000, 16000, 18000],
  candidates: [candidate("a", 3100, 4500), candidate("b", 6500, 7100), candidate("c", 15100, 16500)],
};
describe("candidate range planning", () => {
  it("merges ranges after handles and keyframe padding while keeping candidate coverage", () => {
    const plan = planCandidateRanges(base);
    expect(plan.ranges).toEqual([
      { sourceInterval: { startMs: 2000, endMs: 8000 }, candidateIds: ["a", "b"] },
      { sourceInterval: { startMs: 14000, endMs: 18000 }, candidateIds: ["c"] },
    ]);
    expect(plan.totalRangeDurationMs).toBe(10000);
    expect(plan.coverage[1]).toMatchObject({ candidateId: "b", rangeIndex: 0,
      plannedRelativeInterval: { startMs: 4500, endMs: 5100 } });
  });
  it("clamps handles at source edges without unsafe arithmetic", () => {
    const plan = planCandidateRanges({ ...base, handles: { beforeMs: Number.MAX_SAFE_INTEGER, afterMs: Number.MAX_SAFE_INTEGER } });
    expect(plan.ranges).toEqual([{ sourceInterval: { startMs: 0, endMs: 20000 }, candidateIds: ["a", "b", "c"] }]);
  });
  it("does not extend exact keyframe boundaries unnecessarily", () => {
    const plan = planCandidateRanges({ ...base, handles: { beforeMs: 0, afterMs: 0 }, candidates: [candidate("a", 4000, 6000)] });
    expect(plan.ranges[0].sourceInterval).toEqual({ startMs: 4000, endMs: 6000 });
  });
  it("uses source end when no later keyframe exists", () => {
    const plan = planCandidateRanges({ ...base, candidates: [candidate("tail", 19500, 20000)] });
    expect(plan.ranges[0].sourceInterval).toEqual({ startMs: 18000, endMs: 20000 });
  });
  it("keeps disjoint duration sums exact near the safe integer limit", () => {
    const end = Number.MAX_SAFE_INTEGER;
    const plan = planCandidateRanges({ ...base, sourceDurationMs: end,
      handles: { beforeMs: 0, afterMs: 0 }, keyframeTimesMs: [0, 3, end - 3],
      candidates: [candidate("first", 0, 3), candidate("last", end - 3, end)] });
    expect(plan.totalRangeDurationMs).toBe(6);
  });
  it("keeps identity independent of input candidate order", () => {
    expect(planCandidateRanges(base)).toEqual(planCandidateRanges({ ...base, candidates: [...base.candidates].reverse() }));
    expect(planCandidateRanges({ ...base, sourceSha256: "b".repeat(64) }).planSha256).not.toBe(planCandidateRanges(base).planSha256);
  });
  it("refuses missing preceding keyframes instead of dropping requested coverage", () => {
    expect(() => planCandidateRanges({ ...base, keyframeTimesMs: [4000] })).toThrow("NO_PRECEDING_KEYFRAME");
  });
  it("refuses invalid clocks, candidates, and source bounds", () => {
    for (const keyframeTimesMs of [[0, 0], [2000, 0], [0, 20000], [0, 1.5]]) {
      expect(() => planCandidateRanges({ ...base, keyframeTimesMs })).toThrow();
    }
    for (const candidates of [[], [candidate("a", 0, 20001)], [candidate("a", 2, 2)],
      [candidate("a", 1, 2), candidate("a", 3, 4)]]) {
      expect(() => planCandidateRanges({ ...base, candidates })).toThrow();
    }
  });
  it("covers every candidate and its handles across many deterministic interval layouts", () => {
    for (let seed = 0; seed < 40; seed++) {
      const candidates = Array.from({ length: 30 }, (_, i) => {
        const start = (seed * 977 + i * 419) % 19000;
        return candidate(String(i), start, start + 1 + (i * 73) % 999);
      });
      const plan = planCandidateRanges({ ...base, candidates });
      expect(plan.coverage).toHaveLength(candidates.length);
      for (const entry of plan.coverage) {
        const range = plan.ranges[entry.rangeIndex].sourceInterval;
        expect(compareTimeMs(range.startMs, entry.handledInterval.startMs)).toBeLessThanOrEqual(0);
        expect(compareTimeMs(range.endMs, entry.handledInterval.endMs)).toBeGreaterThanOrEqual(0);
      }
      for (let i = 1; i < plan.ranges.length; i++) {
        expect(compareTimeMs(plan.ranges[i].sourceInterval.startMs, plan.ranges[i - 1].sourceInterval.endMs)).toBeGreaterThan(0);
      }
      expect(compareTimeMs(plan.totalRangeDurationMs, base.sourceDurationMs)).toBeLessThanOrEqual(0);
    }
  });
});
