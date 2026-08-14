import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clipsWithinLeadingFraction,
  computeFunnelMetrics,
  isFrontLoaded,
  type FunnelRun,
} from "@/lib/evaluation/funnel-metrics";

const BASELINE_PATH = join(process.cwd(), "evaluation", "funnel-baseline-2026-08-12.json");

function loadBaseline(): FunnelRun & { keptCount: number; analysisCostUsd: number } {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

function run(overrides: Partial<FunnelRun> = {}): FunnelRun {
  return {
    candidateCount: 100,
    scoredCount: 10,
    keptCount: 5,
    sourceDurationMs: 1_000_000,
    clips: [{ startMs: 0, endMs: 50_000 }],
    ...overrides,
  };
}

describe("funnel metrics", () => {
  it("computes the Stage A pass ratio", () => {
    expect(computeFunnelMetrics(run({ candidateCount: 500, scoredCount: 25 })).stageAPassRatio).toBe(0.05);
  });

  it("computes the kept ratio against scored, not against offered", () => {
    expect(computeFunnelMetrics(run({ scoredCount: 10, keptCount: 4 })).keptRatio).toBe(0.4);
  });

  it("reports coverage span across the service", () => {
    const metrics = computeFunnelMetrics(
      run({
        sourceDurationMs: 1_000_000,
        clips: [
          { startMs: 100_000, endMs: 150_000 },
          { startMs: 800_000, endMs: 850_000 },
        ],
      }),
    );
    expect(metrics.earliestStartFraction).toBeCloseTo(0.1);
    expect(metrics.latestStartFraction).toBeCloseTo(0.8);
    expect(metrics.coverageSpanFraction).toBeCloseTo(0.7);
  });

  it("survives a run with no clips without dividing by zero", () => {
    const metrics = computeFunnelMetrics(run({ clips: [], keptCount: 0, scoredCount: 0 }));
    expect(metrics.keptRatio).toBe(0);
    expect(metrics.coverageSpanFraction).toBe(0);
    expect(isFrontLoaded(run({ clips: [] }), 0.2)).toBe(false);
  });

  it("counts clips inside a leading fraction", () => {
    const r = run({
      sourceDurationMs: 1_000_000,
      clips: [
        { startMs: 50_000, endMs: 90_000 },
        { startMs: 150_000, endMs: 190_000 },
        { startMs: 900_000, endMs: 940_000 },
      ],
    });
    expect(clipsWithinLeadingFraction(r, 0.2)).toBe(2);
    expect(clipsWithinLeadingFraction(r, 1)).toBe(3);
  });

  it("rejects a nonsensical fraction", () => {
    expect(() => clipsWithinLeadingFraction(run(), 0)).toThrow(RangeError);
    expect(() => clipsWithinLeadingFraction(run(), 1.5)).toThrow(RangeError);
  });
});

/**
 * These assertions describe a known limitation, not a desired property.
 *
 * When P5 lands they must be INVERTED rather than deleted — that inversion is the proof the
 * Selector improved coverage. A test that still passes unchanged after P5 means P5 did nothing.
 */
describe("funnel metrics — recorded production baseline (pre-P5)", () => {
  it("Stage A is the binding constraint: well under 5% of candidates reach scoring", () => {
    const baseline = loadBaseline();
    const { stageAPassRatio } = computeFunnelMetrics(baseline);
    expect(stageAPassRatio).toBeLessThan(0.05);
    expect(baseline.candidateCount).toBe(500);
    expect(baseline.scoredCount).toBeLessThan(10);
  });

  it("everything Stage B scores is kept, so ranking is not the bottleneck", () => {
    expect(computeFunnelMetrics(loadBaseline()).keptRatio).toBe(1);
  });

  it("every kept clip starts inside the opening quarter of the service", () => {
    const baseline = loadBaseline();
    expect(isFrontLoaded(baseline, 0.25)).toBe(true);
    expect(clipsWithinLeadingFraction(baseline, 0.25)).toBe(baseline.clips.length);
  });

  it("leaves most of the service uncovered", () => {
    const { latestStartFraction } = computeFunnelMetrics(loadBaseline());
    expect(latestStartFraction).toBeLessThan(0.25);
  });

  it("met the configured clip target despite the narrow coverage", () => {
    const baseline = loadBaseline();
    expect(baseline.keptCount).toBe(6);
    expect(baseline.analysisCostUsd).toBeLessThan(0.2);
  });
});
