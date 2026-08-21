import { describe, expect, it } from "vitest";
import { generateAssSubtitles } from "@/lib/export/ass-generator";
import { getCaptionPreset } from "@/lib/editor/caption-presets";
import type { CaptionWord } from "@/lib/editor/caption-lines";

/**
 * Structural guarantees about the tags the generator emits. The curve itself, and its agreement
 * with the preview, are covered in tests/caption-pop-nested-parity.test.ts, which reads these tags
 * back and evaluates them the way libass would.
 */

const WORDS: CaptionWord[] = [
  { id: "w0", word: "peace", startMs: 0, endMs: 900 },
  { id: "w1", word: "stays", startMs: 900, endMs: 1800 },
];

const LINE = [{ id: "l", startMs: 0, endMs: 1800, text: "peace stays", words: WORDS }];

const dialogue = (ass: string) => ass.split("\n").filter((l) => l.startsWith("Dialogue: 0"));

describe("the pop's tags", () => {
  const ass = () => generateAssSubtitles(LINE, getCaptionPreset("highlighter").style, 1080, 1920);

  it("carries at most one transform per event", () => {
    // Two `\t` over one property have no agreed meaning across renderers, so a phase that needs
    // its own transform gets its own event instead.
    for (const event of dialogue(ass())) {
      expect(event.split("\\t(").length - 1, `two transforms in one event: ${event}`).toBeLessThanOrEqual(1);
    }
  });

  it("scales x and y by the same amount, so the word does not distort", () => {
    for (const event of dialogue(ass())) {
      const xs = [...event.matchAll(/\\fscx(\d+(?:\.\d+)?)/g)].map((m) => m[1]);
      const ys = [...event.matchAll(/\\fscy(\d+(?:\.\d+)?)/g)].map((m) => m[1]);
      expect(xs).toEqual(ys);
    }
  });

  it("states the starting scale rather than inheriting one", () => {
    // Each event is drawn independently by libass; a transform with no stated start is a guess.
    for (const event of dialogue(ass())) {
      if (!event.includes("\\t(")) continue;
      const block = event.slice(event.indexOf("{"), event.indexOf("}") + 1);
      expect(block, `a transform with no starting scale: ${block}`).toMatch(/\\fscx\d+.*\\t\(/);
    }
  });

  it("covers the line end to end with no gap between events", () => {
    const spans = dialogue(ass()).map((e) => {
      const parts = e.split(",");
      return { start: parts[1], end: parts[2] };
    });
    for (let i = 1; i < spans.length; i += 1) {
      expect(spans[i].start, `a gap before event ${i}`).toBe(spans[i - 1].end);
    }
  });

  it("puts a pop on the active word only", () => {
    for (const event of dialogue(ass())) {
      expect(event.split("\\t(").length - 1).toBeLessThanOrEqual(1);
      const highlights = event.split("\\c&H").length - 1;
      // Two colour tags per highlighted word: the highlight and the restore after it.
      expect(highlights).toBeLessThanOrEqual(2);
    }
  });
});
