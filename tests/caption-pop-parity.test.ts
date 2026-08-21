import { describe, expect, it } from "vitest";
import { generateAssSubtitles } from "@/lib/export/ass-generator";
import { getCaptionPreset } from "@/lib/editor/caption-presets";
import { POP, popScaleAt } from "@/lib/editor/caption-animation";
import type { CaptionWord } from "@/lib/editor/caption-lines";

/**
 * The preview and the burn-in must not merely both pop — they must draw the same number at the
 * same millisecond. So this reads the tags the generator actually emitted, rebuilds the curve
 * libass would draw from them, and compares it to the function the preview calls.
 *
 * libass interpolates `\t(t1,t2,accel,...)` by `((t - t1) / (t2 - t1)) ^ accel`, clamped outside
 * the interval. That exponent is the whole reason a quadratic ease-out in the preview and an
 * `accel` in the tags are different curves however similar they look.
 */

const WORDS: CaptionWord[] = [
  { id: "w0", word: "peace", startMs: 0, endMs: 900 },
  { id: "w1", word: "stays", startMs: 900, endMs: 1800 },
];

const LINE = [{ id: "l", startMs: 0, endMs: 1800, text: "peace stays", words: WORDS }];

function activeRun(): string {
  const ass = generateAssSubtitles(LINE, getCaptionPreset("highlighter").style, 1080, 1920);
  const event = ass.split("\n").find((l) => l.startsWith("Dialogue: 0") && l.includes("\\t("));
  expect(event, "no event carries a pop").toBeDefined();
  return event!;
}

/** Rebuilds libass's own interpolation from the emitted tags. */
function curveFromTags(event: string): (ms: number) => number {
  const base = event.match(/\\fscx(\d+(?:\.\d+)?)/);
  expect(base, "the run does not set a starting scale").not.toBeNull();

  const transforms = [...event.matchAll(/\\t\((\d+),(\d+),([\d.]+),\\fscx(\d+(?:\.\d+)?)/g)];
  // One transform, because two overlapping `\t` on the same property do not have a single
  // agreed meaning across renderers — and a curve nobody can state exactly is not shared.
  expect(transforms, "the pop must be one transform").toHaveLength(1);

  const [, t1Raw, t2Raw, accelRaw, targetRaw] = transforms[0];
  const t1 = Number(t1Raw);
  const t2 = Number(t2Raw);
  const accel = Number(accelRaw);
  const from = Number(base![1]) / 100;
  const to = Number(targetRaw) / 100;

  return (ms: number) => {
    if (ms <= t1) return from;
    if (ms >= t2) return to;
    return from + (to - from) * Math.pow((ms - t1) / (t2 - t1), accel);
  };
}

describe("the pop curve is one curve", () => {
  it("scales x and y by the same amount, so the word does not distort", () => {
    const event = activeRun();
    const xs = [...event.matchAll(/\\fscx(\d+(?:\.\d+)?)/g)].map((m) => m[1]);
    const ys = [...event.matchAll(/\\fscy(\d+(?:\.\d+)?)/g)].map((m) => m[1]);
    expect(xs).toEqual(ys);
  });

  it("matches the preview at every sampled millisecond of the rise", () => {
    const fromTags = curveFromTags(activeRun());
    for (let ms = 0; ms <= POP.riseMs; ms += 1) {
      expect(popScaleAt(ms), `rise disagrees at ${ms}ms`).toBeCloseTo(fromTags(ms), 6);
    }
  });

  it("matches the preview at the peak and while it holds", () => {
    const fromTags = curveFromTags(activeRun());
    for (const ms of [POP.riseMs, POP.riseMs + 1, POP.riseMs + 250, POP.riseMs + 5_000]) {
      expect(popScaleAt(ms), `hold disagrees at ${ms}ms`).toBeCloseTo(fromTags(ms), 6);
    }
  });

  it("matches the preview before the word is active", () => {
    const fromTags = curveFromTags(activeRun());
    for (const ms of [-500, -1, 0]) {
      expect(popScaleAt(ms)).toBeCloseTo(fromTags(ms), 6);
    }
  });

  it("agrees across the whole span at a fine sample, not only at the landmarks", () => {
    const fromTags = curveFromTags(activeRun());
    for (let ms = -50; ms <= POP.riseMs + 400; ms += 0.5) {
      expect(popScaleAt(ms), `disagrees at ${ms}ms`).toBeCloseTo(fromTags(ms), 6);
    }
  });

  it("starts at rest and reaches the peak", () => {
    expect(popScaleAt(0)).toBe(1);
    expect(popScaleAt(POP.riseMs)).toBeCloseTo(POP.peakScale, 6);
    expect(POP.peakScale).toBeGreaterThan(1);
  });
});
