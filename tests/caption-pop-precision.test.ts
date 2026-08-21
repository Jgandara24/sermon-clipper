import { describe, expect, it } from "vitest";
import { generateAssSubtitles } from "@/lib/export/ass-generator";
import { getCaptionPreset } from "@/lib/editor/caption-presets";
import {
  POP,
  POP_SCALE_STEP,
  POP_TIME_STEP_MS,
  popPhases,
  popScaleAt,
  quantisePopScale,
  quantisePopTime,
} from "@/lib/editor/caption-animation";
import { activeSliceAt } from "@/lib/editor/active-word";
import type { CaptionLine, CaptionWord } from "@/lib/editor/caption-lines";

/**
 * ASS states times in centiseconds and scales in whole percent. The preview has neither limit, so
 * "the same curve" is only true if both renderers agree to work at the resolution the file can
 * actually carry — otherwise an activation from 3ms to 503ms is drawn from 0ms to 500ms in the
 * file, and a partial phase that reaches 1.1234 in the browser is written as 112.
 *
 * One rule: pop timings are quantised to the centisecond and pop scales to whole percent, in both
 * renderers, before either draws anything.
 */

const style = getCaptionPreset("highlighter").style;

function assMs(stamp: string): number {
  const [h, m, rest] = stamp.split(":");
  const [s, cs] = rest.split(".");
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(cs) * 10;
}

type AssEvent = { startMs: number; endMs: number; body: string };

const events = (ass: string): AssEvent[] =>
  ass
    .split("\n")
    .filter((line) => line.startsWith("Dialogue: 0"))
    .map((line) => {
      const parts = line.split(",");
      return { startMs: assMs(parts[1]), endMs: assMs(parts[2]), body: parts.slice(9).join(",") };
    });

function assScaleAt(ass: string, ms: number): number | null {
  const event = events(ass).find((e) => ms >= e.startMs && ms < e.endMs);
  if (!event || !event.body.includes("\\c&H")) return null;
  const block = event.body.slice(event.body.indexOf("{"), event.body.indexOf("}") + 1);
  const base = block.match(/\\fscx(\d+(?:\.\d+)?)/);
  if (!base) return null;
  const from = Number(base[1]) / 100;
  const transform = [...block.matchAll(/\\t\((\d+),(\d+),([\d.]+),\\fscx(\d+(?:\.\d+)?)/g)][0];
  if (!transform) return from;
  const [, t1, t2, accel, target] = transform;
  const elapsed = ms - event.startMs;
  const to = Number(target) / 100;
  if (elapsed <= Number(t1)) return from;
  if (elapsed >= Number(t2)) return to;
  return from + (to - from) * Math.pow((elapsed - Number(t1)) / (Number(t2) - Number(t1)), Number(accel));
}

function previewScaleAt(line: CaptionLine, ms: number): number | null {
  const slice = activeSliceAt(line, ms);
  if (!slice || slice.activeWordId === null) return null;
  // The slice is already on the grid, so its own boundaries are the clock.
  return popScaleAt(ms - slice.startMs, slice.endMs - slice.startMs);
}

/** Boundaries deliberately off the centisecond grid. */
const ODD_WORDS: CaptionWord[] = [
  { id: "a", word: "alpha", startMs: 3, endMs: 1007 },
  { id: "b", word: "beta", startMs: 203, endMs: 407 },
];
const ODD_LINE: CaptionLine = { id: "l", startMs: 3, endMs: 1007, words: ODD_WORDS, text: "alpha beta" };

/** Short enough that the rise and settle only partly happen. */
const SHORT_WORDS: CaptionWord[] = [{ id: "s", word: "short", startMs: 0, endMs: 120 }];
const SHORT_LINE: CaptionLine = { id: "s", startMs: 0, endMs: 120, words: SHORT_WORDS, text: "short" };

describe("the shared precision rule", () => {
  it("quantises time to the centisecond and scale to whole percent", () => {
    expect(POP_TIME_STEP_MS).toBe(10);
    expect(POP_SCALE_STEP).toBeCloseTo(0.01, 10);
    expect(quantisePopTime(3)).toBe(0);
    expect(quantisePopTime(507)).toBe(510);
    expect(quantisePopScale(1.1234)).toBeCloseTo(1.12, 10);
  });

  it("gives every phase boundary a whole centisecond and a whole percent", () => {
    for (const duration of [120, 300, 503, 1004, 47]) {
      for (const phase of popPhases(duration)) {
        expect(phase.startMs % POP_TIME_STEP_MS, `start ${phase.startMs}`).toBe(0);
        expect(phase.endMs % POP_TIME_STEP_MS, `end ${phase.endMs}`).toBe(0);
        expect(Math.round(phase.fromScale * 100)).toBeCloseTo(phase.fromScale * 100, 6);
        expect(Math.round(phase.toScale * 100)).toBeCloseTo(phase.toScale * 100, 6);
      }
    }
  });
});

describe("boundaries off the centisecond grid", () => {
  it("agrees with the burn-in at every millisecond", () => {
    const ass = generateAssSubtitles([ODD_LINE], style, 1080, 1920);
    for (let ms = 3; ms < 1007; ms += 1) {
      const preview = previewScaleAt(ODD_LINE, ms);
      const exported = assScaleAt(ass, ms);
      if (preview === null || exported === null) continue;
      expect(preview, `scale disagrees at ${ms}ms`).toBeCloseTo(exported, 6);
    }
  });

  it("starts and ends each activation at the same instant in both", () => {
    const ass = generateAssSubtitles([ODD_LINE], style, 1080, 1920);
    const emitted = events(ass);
    for (const event of emitted) {
      expect(event.startMs % POP_TIME_STEP_MS).toBe(0);
      expect(event.endMs % POP_TIME_STEP_MS).toBe(0);
    }
    // No gap and no overlap once every boundary is on the grid.
    for (let i = 1; i < emitted.length; i += 1) {
      expect(emitted[i].startMs).toBe(emitted[i - 1].endMs);
    }
  });
});

describe("a short activation with partial phases", () => {
  it("writes the partial scales the preview evaluates", () => {
    const ass = generateAssSubtitles([SHORT_LINE], style, 1080, 1920);
    for (let ms = 0; ms < 120; ms += 1) {
      const preview = previewScaleAt(SHORT_LINE, ms);
      const exported = assScaleAt(ass, ms);
      if (preview === null || exported === null) continue;
      expect(preview, `scale disagrees at ${ms}ms`).toBeCloseTo(exported, 6);
    }
  });

  it("still comes home to rest", () => {
    const phases = popPhases(120);
    expect(phases[phases.length - 1].toScale).toBeCloseTo(1, 10);
    expect(popScaleAt(120, 120)).toBeCloseTo(1, 10);
    // And it never overshoots the peak on the way.
    for (let ms = 0; ms <= 120; ms += 1) {
      expect(popScaleAt(ms, 120)).toBeLessThanOrEqual(POP.peakScale + 1e-9);
    }
  });
});

describe("every emitted phase boundary", () => {
  it("matches on both sides of each boundary", () => {
    const ass = generateAssSubtitles([ODD_LINE], style, 1080, 1920);
    for (const event of events(ass)) {
      for (const ms of [event.startMs, event.startMs + 1, event.endMs - 1]) {
        const preview = previewScaleAt(ODD_LINE, ms);
        const exported = assScaleAt(ass, ms);
        if (preview === null || exported === null) continue;
        expect(preview, `boundary disagrees at ${ms}ms`).toBeCloseTo(exported, 6);
      }
    }
  });
});
