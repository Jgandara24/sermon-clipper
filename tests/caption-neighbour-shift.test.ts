import { describe, expect, it } from "vitest";
import {
  POP,
  popPhaseShiftProgress,
  popPhases,
  popScaleAt,
  popShiftProgressAt,
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
 * acceleration. So the offset is straight inside each phase and exact at every boundary, and both
 * renderers have to do it that way or they disagree about where a word is between boundaries.
 */
describe("the neighbour shift follows the pop, one straight line per phase", () => {
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

  it("moves in a straight line inside a phase, which is all libass can do", () => {
    const rise = popPhases(DURATION)[0];
    const middle = (rise.startMs + rise.endMs) / 2;
    const from = shiftProgressForScale(rise.fromScale);
    const to = shiftProgressForScale(rise.toScale);

    expect(popShiftProgressAt(middle, DURATION)).toBeCloseTo((from + to) / 2, 10);
  });

  it("is deliberately not the scale curve mid-rise", () => {
    // If these agreed, the rise would have lost its acceleration and the pop its shape. The gap
    // between them is the cost of libass having no accelerated move, and it is bounded by a phase.
    const rise = popPhases(DURATION)[0];
    expect(rise.accel).not.toBe(1);
    const middle = (rise.startMs + rise.endMs) / 2;

    const straight = popShiftProgressAt(middle, DURATION);
    const curved = shiftProgressForScale(popScaleAt(middle, DURATION));
    expect(Math.abs(straight - curved)).toBeGreaterThan(0.05);
  });

  it("gives an activation too short for any phase nothing to do", () => {
    expect(popShiftProgressAt(0, 0)).toBe(0);
    expect(popShiftProgressAt(5, 0)).toBe(0);
  });

  it("maps a phase's own scales to the offsets the file moves between", () => {
    for (const phase of popPhases(DURATION)) {
      const span = popPhaseShiftProgress(phase);
      expect(span.from).toBeCloseTo(shiftProgressForScale(phase.fromScale), 10);
      expect(span.to).toBeCloseTo(shiftProgressForScale(phase.toScale), 10);
    }
  });

  it("agrees with the file at every phase boundary, which is where both are exact", () => {
    for (const phase of popPhases(DURATION)) {
      const span = popPhaseShiftProgress(phase);
      expect(popShiftProgressAt(phase.startMs, DURATION)).toBeCloseTo(span.from, 10);
      expect(popShiftProgressAt(phase.endMs, DURATION)).toBeCloseTo(span.to, 10);
    }
  });

  it("treats rest as no offset and the peak as all of it", () => {
    expect(shiftProgressForScale(1)).toBe(0);
    expect(shiftProgressForScale(POP.peakScale)).toBe(1);
  });

  it("covers a short activation the same way, phase by phase", () => {
    // A short activation drops phases rather than shortening the return, so the shift still ends
    // at rest and still agrees at every boundary that survived.
    const short = 120;
    const phases = popPhases(short);
    expect(phases.length).toBeGreaterThan(0);
    expect(popShiftProgressAt(short, short)).toBe(0);
    for (const phase of phases) {
      expect(popShiftProgressAt(phase.endMs, short)).toBeCloseTo(
        popPhaseShiftProgress(phase).to,
        10,
      );
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
    // The file says where a word starts and ends each phase. The preview computes the same two
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
      for (const phase of popPhases(500)) {
        const shift = popPhaseShiftProgress(phase);
        const span = word.shiftedX - word.restX;
        expected.add(Math.round(centreX + word.restX + span * shift.from));
        expected.add(Math.round(centreX + word.restX + span * shift.to));
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

  it("gives the preview the same offset the file moves to, at every phase boundary", () => {
    // The preview reads a time; the file reads a phase. At a boundary the two must produce the
    // same number, because that is the only place both are exact.
    for (const phase of popPhases(500)) {
      const fromPreview = popShiftProgressAt(phase.startMs, 500);
      const toPreview = popShiftProgressAt(phase.endMs, 500);
      const inFile = popPhaseShiftProgress(phase);

      expect(fromPreview).toBeCloseTo(inFile.from, 10);
      expect(toPreview).toBeCloseTo(inFile.to, 10);
    }
  });
});
