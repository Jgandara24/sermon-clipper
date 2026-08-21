import { describe, expect, it } from "vitest";
import { generateAssSubtitles } from "@/lib/export/ass-generator";
import { getCaptionPreset } from "@/lib/editor/caption-presets";
import { captionActivationAt, captionActivations } from "@/lib/editor/caption-timeline";
import { popScaleAt } from "@/lib/editor/caption-animation";
import type { CaptionLine, CaptionWord } from "@/lib/editor/caption-lines";

/**
 * Selecting what is on screen must be one decision, not two.
 *
 * The preview chose its caption line from the line's own boundaries while the burn-in emitted
 * events on the quantised grid. For a line running 3–1007ms the file shows the caption from 0ms to
 * 1010ms and the browser showed it from 3ms to 1007ms — so for the first three milliseconds and the
 * last three, one of them has a caption on screen and the other does not.
 *
 * These comparisons never skip a null: a caption present on one side and absent on the other is
 * exactly the defect, so it has to fail rather than be passed over.
 */

const style = getCaptionPreset("highlighter").style;

const WORDS: CaptionWord[] = [
  { id: "a", word: "alpha", startMs: 3, endMs: 1007 },
  { id: "b", word: "beta", startMs: 203, endMs: 407 },
];
const LINE: CaptionLine = { id: "l", startMs: 3, endMs: 1007, words: WORDS, text: "alpha beta" };

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

const eventAt = (ass: string, ms: number) =>
  events(ass).find((e) => ms >= e.startMs && ms < e.endMs) ?? null;

/** The word the file lights, upper-cased as Highlighter renders it, or null. */
function assActiveWord(event: AssEvent | null): string | null {
  if (!event) return null;
  return /\{\\c&H[0-9A-F]{8}\}([A-Z]+)/.exec(event.body)?.[1] ?? null;
}

function assScale(event: AssEvent | null, ms: number): number | null {
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

describe("what is on screen is one decision", () => {
  const ass = () => generateAssSubtitles([LINE], style, 1080, 1920);

  it("agrees about caption presence at every millisecond, including the edges", () => {
    const rendered = ass();
    for (let ms = 0; ms <= 1020; ms += 1) {
      const preview = captionActivationAt([LINE], ms, true);
      const exported = eventAt(rendered, ms);
      expect(preview !== null, `caption presence disagrees at ${ms}ms`).toBe(exported !== null);
    }
  });

  it("covers exactly the quantised interval on both sides", () => {
    const rendered = ass();
    // 3ms rounds to 0 and 1007ms rounds to 1010: both must use those, not the raw numbers.
    expect(captionActivationAt([LINE], 0, true), "no caption at 0ms").not.toBeNull();
    expect(captionActivationAt([LINE], 2, true), "no caption at 2ms").not.toBeNull();
    expect(captionActivationAt([LINE], 1009, true), "no caption at 1009ms").not.toBeNull();
    expect(eventAt(rendered, 0), "no event at 0ms").not.toBeNull();
    expect(eventAt(rendered, 1009), "no event at 1009ms").not.toBeNull();
  });

  it("is absent on both sides after the quantised end", () => {
    const rendered = ass();
    for (const ms of [1010, 1011, 1500]) {
      expect(captionActivationAt([LINE], ms, true), `preview still has a caption at ${ms}ms`).toBeNull();
      expect(eventAt(rendered, ms), `export still has an event at ${ms}ms`).toBeNull();
    }
  });

  it("agrees about which word is active at every millisecond", () => {
    const rendered = ass();
    for (let ms = 0; ms <= 1020; ms += 1) {
      const preview = captionActivationAt([LINE], ms, true);
      const previewWord = preview?.activeWordId
        ? preview.words.find((w) => w.id === preview.activeWordId)!.word.toUpperCase()
        : null;
      expect(previewWord, `active word disagrees at ${ms}ms`).toBe(
        assActiveWord(eventAt(rendered, ms)),
      );
    }
  });

  it("agrees about the scale wherever a word is active", () => {
    const rendered = ass();
    for (let ms = 0; ms <= 1020; ms += 1) {
      const preview = captionActivationAt([LINE], ms, true);
      const event = eventAt(rendered, ms);
      const exported = assScale(event, ms);
      if (preview === null || preview.activeWordId === null) {
        expect(exported, `export scales nothing the preview does not at ${ms}ms`).toBeNull();
        continue;
      }
      const scale = popScaleAt(ms - preview.startMs, preview.endMs - preview.startMs);
      expect(exported, `export has no scale at ${ms}ms`).not.toBeNull();
      expect(scale, `scale disagrees at ${ms}ms`).toBeCloseTo(exported!, 6);
    }
  });

  it("leaves a legacy preset on its own line boundaries", () => {
    // Not quantised into activations: a preset that does not highlight keeps the timing it had.
    const activations = captionActivations([LINE], false);
    expect(activations).toHaveLength(1);
    expect(activations[0].startMs).toBe(3);
    expect(activations[0].endMs).toBe(1007);
    expect(activations[0].activeWordId).toBeNull();
  });
});

/**
 * A Highlighter caption with nothing to highlight is still a Highlighter caption.
 *
 * The no-word path handed back the line's raw boundaries while every other Highlighter activation
 * was quantised, so the preview showed a wordless line from 3ms to 1007ms and the file from 0ms to
 * 1010ms — the very drift the module exists to remove, surviving in the one branch that had no
 * words to quantise around. Two lines reach that branch: one that never had timed words, and one a
 * member retyped to nothing but whitespace.
 */
describe("a Highlighter caption with no timed words is on the same grid", () => {
  const NO_WORDS: CaptionLine = { id: "n", startMs: 3, endMs: 1007, words: [], text: "alpha beta" };
  const BLANK_RETYPE: CaptionLine = { id: "r", startMs: 3, endMs: 1007, words: WORDS, text: " \t " };

  const cases: Array<[string, CaptionLine]> = [
    ["a line that never had timed words", NO_WORDS],
    ["a line retyped to whitespace only", BLANK_RETYPE],
  ];

  for (const [label, line] of cases) {
    describe(label, () => {
      const ass = () => generateAssSubtitles([line], style, 1080, 1920);

      it("agrees about caption presence at every millisecond from 0 through 1020", () => {
        const rendered = ass();
        for (let ms = 0; ms <= 1020; ms += 1) {
          const preview = captionActivationAt([line], ms, true);
          const exported = eventAt(rendered, ms);
          // Never skipped: one side present and the other absent is the defect itself.
          expect(preview !== null, `caption presence disagrees at ${ms}ms`).toBe(exported !== null);
        }
      });

      it("selects exactly the quantised interval, 0ms to 1010ms, for the preview", () => {
        const activations = captionActivations([line], true);
        expect(activations).toHaveLength(1);
        expect(activations[0].startMs).toBe(0);
        expect(activations[0].endMs).toBe(1010);
        expect(activations[0].activeWordId).toBeNull();
        expect(activations[0].words).toEqual([]);
        for (const ms of [0, 1, 2, 3, 500, 1006, 1007, 1008, 1009]) {
          expect(captionActivationAt([line], ms, true), `no caption at ${ms}ms`).not.toBeNull();
        }
      });

      it("writes exactly the quantised interval, 0ms to 1010ms, to the file", () => {
        const written = events(ass());
        expect(written).toHaveLength(1);
        expect(written[0].startMs).toBe(0);
        expect(written[0].endMs).toBe(1010);
        for (const ms of [0, 1, 2, 3, 500, 1006, 1007, 1008, 1009]) {
          expect(eventAt(ass(), ms), `no event at ${ms}ms`).not.toBeNull();
        }
      });

      it("is absent on both sides at and after 1010ms", () => {
        const rendered = ass();
        for (const ms of [1010, 1011, 1012, 1020, 1500]) {
          expect(captionActivationAt([line], ms, true), `preview still has a caption at ${ms}ms`).toBeNull();
          expect(eventAt(rendered, ms), `export still has an event at ${ms}ms`).toBeNull();
        }
      });

      it("lights no word on either side", () => {
        const rendered = ass();
        for (let ms = 0; ms <= 1020; ms += 1) {
          expect(captionActivationAt([line], ms, true)?.activeWordId ?? null).toBeNull();
          expect(assActiveWord(eventAt(rendered, ms)), `export lights a word at ${ms}ms`).toBeNull();
        }
      });

      it("keeps a legacy preset on the line's own raw boundaries", () => {
        const activations = captionActivations([line], false);
        expect(activations).toHaveLength(1);
        expect(activations[0].startMs).toBe(3);
        expect(activations[0].endMs).toBe(1007);
        expect(activations[0].activeWordId).toBeNull();
        expect(captionActivationAt([line], 0, false), "legacy caption appeared before 3ms").toBeNull();
        expect(captionActivationAt([line], 2, false), "legacy caption appeared before 3ms").toBeNull();
        expect(captionActivationAt([line], 3, false), "legacy caption missing at 3ms").not.toBeNull();
        expect(captionActivationAt([line], 1006, false), "legacy caption missing at 1006ms").not.toBeNull();
        expect(captionActivationAt([line], 1007, false), "legacy caption lingered at 1007ms").toBeNull();
        expect(captionActivationAt([line], 1009, false), "legacy caption lingered at 1009ms").toBeNull();
      });
    });
  }

  it("quantises a wordless line exactly as it quantises a line with words", () => {
    // Same boundaries, with and without words: the on-screen stretch must be the same interval.
    const withWords = captionActivations([LINE], true);
    const without = captionActivations([NO_WORDS], true);
    expect(without[0].startMs).toBe(withWords[0].startMs);
    expect(without[without.length - 1].endMs).toBe(withWords[withWords.length - 1].endMs);
  });
});
