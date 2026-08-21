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
