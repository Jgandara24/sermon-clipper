import { describe, expect, it } from "vitest";
import {
  POP,
  POP_SHIFT_TOLERANCE,
  POP_TIME_STEP_MS,
  popPhases,
  popScaleAt,
  popShiftProgressAt,
  popShiftSegments,
  shiftProgressForScale,
} from "@/lib/editor/caption-animation";
import { getCaptionPreset } from "@/lib/editor/caption-presets";
import { resolveCaptionFace } from "@/lib/editor/caption-face";
import { createCaptionMeasurer } from "@/lib/export/font-metrics";
import { layOutCaptionRows } from "@/lib/editor/caption-layout";
import { applyTextCase } from "@/lib/editor/text-case";
import { generateAssSubtitles, type AssCaptionLine } from "@/lib/export/ass-generator";

/**
 * How far a neighbour has moved aside, as a fraction of its full clearance.
 *
 * The word's own scale is animated on an accelerated curve. Its neighbours' positions cannot be:
 * libass animates a position only through `\move`, which is one straight motion per event with no
 * acceleration. So the motion is subdivided until each straight piece tracks its curve within a
 * stated tolerance, and both renderers interpolate over the same pieces.
 *
 * That curve is the neighbour's own, not the scale's. A neighbour has one job — stay clear of the
 * word — and following the scale exactly made it dart out, reverse two thirds of the way back,
 * stop dead for the whole hold, then set off again. It now tracks the scale while the word is
 * growing, which is when the clearance is actually needed, and drifts back across the whole span
 * the word is held rather than finishing early and waiting.
 */
/** The moment the word stops growing, which is the last moment a neighbour has to keep up. */
function riseEndMs(durationMs: number): number {
  const growing = popPhases(durationMs).filter((phase) => phase.toScale > phase.fromScale);
  return growing.length > 0 ? growing[growing.length - 1].endMs : 0;
}

describe("the neighbour shift tracks the pop curve, one straight line per segment", () => {
  const DURATION = 600;

  it("is at rest before the pop and after the return", () => {
    expect(popShiftProgressAt(0, DURATION)).toBe(0);
    expect(popShiftProgressAt(DURATION, DURATION)).toBe(0);
    expect(popShiftProgressAt(DURATION + 50, DURATION)).toBe(0);
  });

  it("is fully aside exactly when the word is at its largest", () => {
    const rise = popPhases(DURATION)[0];
    expect(rise.toScale).toBe(POP.peakScale);
    expect(popShiftProgressAt(rise.endMs, DURATION)).toBeCloseTo(1, 10);
  });

  it("never leaves the range between rest and fully aside", () => {
    for (let ms = -50; ms <= DURATION + 50; ms += 5) {
      const progress = popShiftProgressAt(ms, DURATION);
      expect(progress).toBeGreaterThanOrEqual(0);
      expect(progress).toBeLessThanOrEqual(1);
    }
  });

  it("moves in a straight line inside a segment, which is all libass can do", () => {
    for (const segment of popShiftSegments(DURATION)) {
      const middle = (segment.startMs + segment.endMs) / 2;
      expect(popShiftProgressAt(middle, DURATION)).toBeCloseTo(
        (segment.from + segment.to) / 2,
        10,
      );
    }
  });

  it("tracks the scale curve within the stated tolerance while the word grows", () => {
    // This is the whole point of subdividing. One line per phase put the neighbour a quarter of
    // its clearance from where the curve says it is; the product owner saw that as stepping.
    let worst = 0;
    for (let ms = 0; ms <= riseEndMs(DURATION); ms += 0.5) {
      const straight = popShiftProgressAt(ms, DURATION);
      const curve = shiftProgressForScale(popScaleAt(ms, DURATION));
      worst = Math.max(worst, Math.abs(straight - curve));
    }
    expect(worst).toBeLessThanOrEqual(POP_SHIFT_TOLERANCE);
  });

  it("never falls short of the clearance the word needs", () => {
    // The safety property the whole shift exists for, and the one that lets the neighbour leave
    // the scale curve at all: being further aside than the word needs is always safe, being
    // nearer is a collision. The only shortfall allowed is the straight line's own tolerance,
    // which lives in the first time step of the rise and nowhere else.
    for (let ms = 0; ms <= DURATION; ms += 1) {
      const needed = shiftProgressForScale(popScaleAt(ms, DURATION));
      const actual = popShiftProgressAt(ms, DURATION);
      expect(actual, `at ${ms}ms`).toBeGreaterThanOrEqual(needed - POP_SHIFT_TOLERANCE);
      if (ms >= riseEndMs(DURATION)) {
        expect(actual, `at ${ms}ms, past the rise`).toBeGreaterThanOrEqual(needed - 1e-9);
      }
    }
  });

  it("never stops and starts again in the middle of a pop", () => {
    // Following the scale exactly gave a neighbour a dead stop for the whole hold, between two
    // separate journeys back to rest. A viewer reads that as two movements, which is the opposite
    // of what was asked for. It goes out once and comes back once.
    const segments = popShiftSegments(DURATION);
    const moving = segments.filter((segment) => segment.from !== segment.to);
    expect(moving.length).toBe(segments.length);

    const directions = moving.map((segment) => Math.sign(segment.to - segment.from));
    const turns = directions.filter((way, index) => index > 0 && way !== directions[index - 1]);
    expect(turns).toHaveLength(1);
  });

  it("puts what is left of that gap in the one step the format cannot subdivide", () => {
    // An accelerated rise leaves rest at unbounded speed, so the first time step is the one place
    // a straight line cannot follow it — the file has no shorter time to state. Past that step the
    // motion tracks the curve an order of magnitude more closely, and saying so here stops the
    // tolerance above from being read as the accuracy everywhere.
    let worst = 0;
    for (let ms = POP_TIME_STEP_MS; ms <= riseEndMs(DURATION); ms += 0.5) {
      const straight = popShiftProgressAt(ms, DURATION);
      const curve = shiftProgressForScale(popScaleAt(ms, DURATION));
      worst = Math.max(worst, Math.abs(straight - curve));
    }
    expect(worst).toBeLessThanOrEqual(POP_SHIFT_TOLERANCE / 5);
  });

  it("spends its events on the rise, and one each on the drift and the return", () => {
    // A leg that is already straight is exact. Splitting it would multiply the file and move
    // nothing, which is the difference between smoother and merely larger.
    const home = popPhases(DURATION).at(-1)!;
    const segments = popShiftSegments(DURATION);
    const rise = segments.filter((segment) => segment.endMs <= riseEndMs(DURATION));
    const rest = segments.filter((segment) => segment.startMs >= riseEndMs(DURATION));

    expect(rise.length).toBeGreaterThan(1);
    expect(rest).toHaveLength(2);
    expect(rest[0].startMs).toBe(riseEndMs(DURATION));
    expect(rest[1].startMs).toBe(home.startMs);
    expect(rest[1].endMs).toBe(home.endMs);
  });

  it("gives the curved rise more pieces than the one it had", () => {
    const rise = popPhases(DURATION)[0];
    expect(rise.accel).not.toBe(1);
    const within = popShiftSegments(DURATION).filter((segment) => segment.endMs <= rise.endMs);
    expect(within.length).toBeGreaterThan(1);
  });

  it("covers the activation end to end, in order, on the file's own time grid", () => {
    // A gap between segments is a moment neither renderer has an answer for, and a boundary off
    // the grid is a time the file cannot state.
    const segments = popShiftSegments(DURATION);
    const phases = popPhases(DURATION);
    expect(segments.length).toBeGreaterThan(0);
    expect(segments[0].startMs).toBe(phases[0].startMs);
    expect(segments[segments.length - 1].endMs).toBe(phases[phases.length - 1].endMs);

    for (const [index, segment] of segments.entries()) {
      expect(segment.endMs).toBeGreaterThan(segment.startMs);
      expect(segment.startMs % POP_TIME_STEP_MS).toBe(0);
      expect(segment.endMs % POP_TIME_STEP_MS).toBe(0);
      if (index > 0) expect(segment.startMs).toBe(segments[index - 1].endMs);
    }
  });

  it("turns where its own motion turns, not wherever the scale changes phase", () => {
    // The end of the rise and the start of the return are the neighbour's own corners. The end of
    // the settle is not: the word stops shrinking there, but the neighbour is still drifting back
    // and has no reason to stop with it.
    const phases = popPhases(DURATION);
    const bounds = new Set(popShiftSegments(DURATION).flatMap((s) => [s.startMs, s.endMs]));

    expect(bounds.has(riseEndMs(DURATION))).toBe(true);
    expect(bounds.has(phases[phases.length - 1].startMs)).toBe(true);

    const settle = phases[1];
    expect(settle.toScale).toBeLessThan(settle.fromScale);
    expect(bounds.has(settle.endMs), "the neighbour stopped where the settle ended").toBe(false);
  });

  it("gives an activation too short for any phase nothing to do", () => {
    expect(popShiftProgressAt(0, 0)).toBe(0);
    expect(popShiftProgressAt(5, 0)).toBe(0);
    expect(popShiftSegments(0)).toEqual([]);
  });

  it("agrees with the file at every segment boundary, which is where both are exact", () => {
    for (const segment of popShiftSegments(DURATION)) {
      expect(popShiftProgressAt(segment.startMs, DURATION)).toBeCloseTo(segment.from, 10);
      expect(popShiftProgressAt(segment.endMs, DURATION)).toBeCloseTo(segment.to, 10);
    }
  });

  it("treats rest as no offset and the peak as all of it", () => {
    expect(shiftProgressForScale(1)).toBe(0);
    expect(shiftProgressForScale(POP.peakScale)).toBe(1);
  });

  it("covers a short activation the same way, segment by segment", () => {
    // A short activation drops phases rather than shortening the return, so the shift still ends
    // at rest and still agrees at every boundary that survived.
    const short = 120;
    const segments = popShiftSegments(short);
    expect(segments.length).toBeGreaterThan(0);
    expect(popShiftProgressAt(short, short)).toBe(0);
    for (const segment of segments) {
      expect(popShiftProgressAt(segment.endMs, short)).toBeCloseTo(segment.to, 10);
    }
  });
});

describe("the preview and the file agree on where a neighbour is", () => {
  const style = getCaptionPreset("highlighter").style;
  const LINE: AssCaptionLine[] = [
    {
      id: "line",
      startMs: 0,
      endMs: 2500,
      text: "peace is not the absence",
      words: ["peace", "is", "not", "the", "absence"].map((word, index) => ({
        id: `line:${index}`,
        word,
        startMs: index * 500,
        endMs: (index + 1) * 500,
      })),
    },
  ];

  function measurer() {
    const face = resolveCaptionFace(style);
    const m = createCaptionMeasurer({ family: face.family, bold: face.bold, sizePx: style.sizePx });
    return { measure: m.measure, spaceWidth: m.spaceWidth };
  }

  it("moves a neighbour between the two positions the layout states, and no others", () => {
    // The file says where a word starts and ends each segment. The preview computes the same two
    // numbers from the same layout and the same progress curve. If these drift apart, the caption
    // the church watches is not the caption it publishes.
    const m = measurer();
    const ass = generateAssSubtitles(LINE, style, 1080, 1920, null, m);

    const layout = layOutCaptionRows({
      words: LINE[0].words!.map((word) => ({
        id: word.id,
        text: applyTextCase(word.word, style.textCase),
      })),
      measure: m.measure,
      spaceWidth: m.spaceWidth,
      // The second word is the one being lit in the activation this checks.
      activeWordId: "line:1",
      peakScale: POP.peakScale,
      maxWidth: 1080 - 80,
    });

    const centreX = 1080 / 2;
    const expected = new Set<number>();
    for (const word of layout.rows[0].words) {
      for (const segment of popShiftSegments(500)) {
        const span = word.shiftedX - word.restX;
        expected.add(Math.round(centreX + word.restX + span * segment.from));
        expected.add(Math.round(centreX + word.restX + span * segment.to));
      }
    }

    // Only the events of the activation this layout describes. Every word gets an activation of
    // its own, each with its own active word and so its own offsets, and mixing them would be
    // comparing one moment's numbers against another's.
    const duringActivation = ass
      .split("\n")
      .filter((line) => line.startsWith("Dialogue:"))
      .filter((line) => {
        const start = /^Dialogue: 0,0:00:0(\d)\.(\d\d),/.exec(line);
        if (!start) return false;
        const ms = Number(start[1]) * 1000 + Number(start[2]) * 10;
        return ms >= 500 && ms < 1000;
      });

    const moves = duringActivation.flatMap((line) => [
      ...line.matchAll(/\\move\((\d+),\d+,(\d+),\d+,/g),
    ]);
    expect(moves.length).toBeGreaterThan(0);
    for (const match of moves) {
      expect(
        expected.has(Number(match[1])),
        `move starts at ${match[1]}, which the layout never states`,
      ).toBe(true);
      expect(
        expected.has(Number(match[2])),
        `move ends at ${match[2]}, which the layout never states`,
      ).toBe(true);
    }
  });

  it("gives the preview the same offset the file moves to, at every segment boundary", () => {
    // The preview reads a time; the file reads a segment. At a boundary the two must produce the
    // same number, because that is the only place both are exact.
    for (const segment of popShiftSegments(500)) {
      expect(popShiftProgressAt(segment.startMs, 500)).toBeCloseTo(segment.from, 10);
      expect(popShiftProgressAt(segment.endMs, 500)).toBeCloseTo(segment.to, 10);
    }
  });
});
