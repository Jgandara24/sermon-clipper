import { describe, expect, it } from "vitest";
import { generateAssSubtitles } from "@/lib/export/ass-generator";
import { getCaptionPreset } from "@/lib/editor/caption-presets";
import { POP, popScaleAt } from "@/lib/editor/caption-animation";
import { activeSliceAt, highlightSlices } from "@/lib/editor/active-word";
import type { CaptionLine, CaptionWord } from "@/lib/editor/caption-lines";

/**
 * Nested word intervals are where a per-word clock and a per-event clock come apart.
 *
 * Word A runs 0–1000ms and word B runs 200–400ms inside it, so A is active, then B, then A again.
 * Timed from A's own start, the second activation is already 400ms old; timed from the event that
 * draws it, it has just begun. One of those is what the viewer sees in the browser and the other
 * is what libass draws, and they are not the same picture.
 *
 * The activation is the clock. Both renderers measure from the start of the stretch over which the
 * highlight does not change.
 */

const A_THEN_B: CaptionWord[] = [
  { id: "a", word: "alpha", startMs: 0, endMs: 1000 },
  { id: "b", word: "beta", startMs: 200, endMs: 400 },
];

const LINE: CaptionLine = {
  id: "l",
  startMs: 0,
  endMs: 1000,
  words: A_THEN_B,
  text: "alpha beta",
};

const style = getCaptionPreset("highlighter").style;

function assMsToMs(stamp: string): number {
  const [h, m, rest] = stamp.split(":");
  const [s, cs] = rest.split(".");
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(cs) * 10;
}

type AssEvent = { startMs: number; endMs: number; body: string };

function events(ass: string): AssEvent[] {
  return ass
    .split("\n")
    .filter((line) => line.startsWith("Dialogue: 0"))
    .map((line) => {
      const parts = line.split(",");
      return {
        startMs: assMsToMs(parts[1]),
        endMs: assMsToMs(parts[2]),
        body: parts.slice(9).join(","),
      };
    });
}

/**
 * The scale libass would draw at `ms`, read out of the tags the generator emitted: the event
 * covering the instant, its static starting scale, and its single transform if it has one.
 */
function assScaleAt(ass: string, ms: number): number | null {
  const event = events(ass).find((e) => ms >= e.startMs && ms < e.endMs);
  if (!event) return null;
  if (!event.body.includes("\\c&H")) return null; // nothing highlighted in this stretch

  // The highlighted run begins at the colour tag; take the override block in front of it.
  const runStart = event.body.indexOf("{");
  const block = event.body.slice(runStart, event.body.indexOf("}", runStart) + 1);

  const base = block.match(/\\fscx(\d+(?:\.\d+)?)/);
  if (!base) return null;
  const from = Number(base[1]) / 100;

  const transforms = [...block.matchAll(/\\t\((\d+),(\d+),([\d.]+),\\fscx(\d+(?:\.\d+)?)/g)];
  expect(transforms.length, `more than one transform at ${ms}ms: ${block}`).toBeLessThanOrEqual(1);
  if (transforms.length === 0) return from;

  const [, t1, t2, accel, target] = transforms[0];
  const elapsed = ms - event.startMs;
  const to = Number(target) / 100;
  if (elapsed <= Number(t1)) return from;
  if (elapsed >= Number(t2)) return to;
  return (
    from + (to - from) * Math.pow((elapsed - Number(t1)) / (Number(t2) - Number(t1)), Number(accel))
  );
}

/** What the preview draws: the activation's own clock, from the slice the resolver returns. */
function previewScaleAt(ms: number): number | null {
  const slice = activeSliceAt(LINE, ms);
  if (!slice || slice.activeWordId === null) return null;
  return popScaleAt(ms - slice.startMs, slice.endMs - slice.startMs);
}

describe("nested word intervals", () => {
  it("splits into the three activations the overlap implies", () => {
    const slices = highlightSlices(LINE).filter((s) => s.activeWordId !== null);
    expect(slices.map((s) => [s.startMs, s.endMs, s.activeWordId])).toEqual([
      [0, 200, "a"],
      [200, 400, "b"],
      [400, 1000, "a"],
    ]);
  });

  it("restarts the clock when a word becomes active again", () => {
    // A's second activation begins at 400ms. One millisecond in, it is at the start of the curve,
    // not 401ms deep into it.
    expect(previewScaleAt(401)).toBeCloseTo(popScaleAt(1, 600), 6);
    expect(previewScaleAt(400)).toBeCloseTo(1, 6);
  });

  it("agrees with the burn-in at every sampled millisecond of the overlap", () => {
    const ass = generateAssSubtitles([LINE], style, 1080, 1920);
    for (let ms = 0; ms < 1000; ms += 1) {
      const preview = previewScaleAt(ms);
      const exported = assScaleAt(ass, ms);
      expect(preview === null, `preview and export disagree about activity at ${ms}ms`).toBe(
        exported === null,
      );
      if (preview !== null && exported !== null) {
        expect(preview, `scale disagrees at ${ms}ms`).toBeCloseTo(exported, 5);
      }
    }
  });
});

describe("the pop rises, settles, and returns", () => {
  const D = 600; // A's second activation, long enough for every phase.

  it("passes through every phase", () => {
    const rise = popScaleAt(POP.riseMs, D);
    const settled = popScaleAt(POP.riseMs + POP.settleMs, D);
    const held = popScaleAt(D - POP.returnMs, D);
    const home = popScaleAt(D, D);

    expect(popScaleAt(0, D)).toBeCloseTo(1, 6);
    expect(rise).toBeCloseTo(POP.peakScale, 6);
    expect(settled).toBeCloseTo(POP.heldScale, 6);
    expect(held).toBeCloseTo(POP.heldScale, 6);
    // It comes home rather than being cut off at full size.
    expect(home).toBeCloseTo(1, 6);
    expect(POP.peakScale).toBeGreaterThan(POP.heldScale);
    expect(POP.heldScale).toBeGreaterThan(1);
  });

  it("never exceeds the peak, and never drops below rest", () => {
    for (let ms = 0; ms <= D; ms += 1) {
      const scale = popScaleAt(ms, D);
      expect(scale).toBeLessThanOrEqual(POP.peakScale + 1e-9);
      expect(scale).toBeGreaterThanOrEqual(1 - 1e-9);
    }
  });

  it("still returns home when the activation is too short for every phase", () => {
    const short = 40;
    expect(popScaleAt(short, short)).toBeCloseTo(1, 6);
    for (let ms = 0; ms <= short; ms += 1) {
      expect(popScaleAt(ms, short)).toBeGreaterThanOrEqual(1 - 1e-9);
    }
  });

  it("matches the burn-in through every phase of a long activation", () => {
    const long: CaptionLine = {
      id: "l2",
      startMs: 0,
      endMs: 900,
      words: [{ id: "solo", word: "alone", startMs: 0, endMs: 900 }],
      text: "alone",
    };
    const ass = generateAssSubtitles([long], style, 1080, 1920);
    for (let ms = 0; ms < 900; ms += 1) {
      const slice = activeSliceAt(long, ms)!;
      const preview = popScaleAt(ms - slice.startMs, slice.endMs - slice.startMs);
      expect(preview, `scale disagrees at ${ms}ms`).toBeCloseTo(assScaleAt(ass, ms)!, 5);
    }
  });
});
