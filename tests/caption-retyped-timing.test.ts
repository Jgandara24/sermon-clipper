import { describe, expect, it } from "vitest";
import { retypedWords, type CaptionLine, type CaptionWord } from "@/lib/editor/caption-lines";
import { highlightSlices, resolveActiveWord } from "@/lib/editor/active-word";
import { generateAssSubtitles } from "@/lib/export/ass-generator";
import { getCaptionPreset } from "@/lib/editor/caption-presets";

/**
 * A member retypes a caption. The words underneath no longer correspond to the text, so there is
 * nothing to align a highlight to by matching — and both renderers used to give up and highlight
 * nothing, which on Highlighter means the caption goes dead for the whole line while someone is
 * speaking.
 *
 * The rule has two cases, decided by whether the member changed how many words there are.
 *
 * A **correction** — the same number of tokens — keeps each source word's timing and replaces only
 * its text, so fixing one typo does not re-time the line. A **rewrite** — tokens added or removed —
 * has no correspondence left to preserve, and divides the line's own span evenly among the tokens
 * as typed. Both renderers apply the same rule, so the token lit on screen is the token lit in the
 * file.
 */

function sourceWords(spec: Array<[string, number, number]>): CaptionWord[] {
  return spec.map(([word, startMs, endMs], index) => ({ id: `w${index}`, word, startMs, endMs }));
}

const SOURCE = sourceWords([
  ["peace", 0, 300],
  ["stays", 300, 700],
  ["with", 700, 1500],
]);

function lineWith(text: string): CaptionLine {
  return { id: "l", startMs: 0, endMs: 1500, words: SOURCE, text };
}

const SAME = lineWith("grace abides here");
const FEWER = lineWith("grace abides");
const MORE = lineWith("grace abides here with all of us");

const CASES = [
  { label: "the same number of tokens", line: SAME, tokens: 3 },
  { label: "fewer tokens", line: FEWER, tokens: 2 },
  { label: "more tokens", line: MORE, tokens: 7 },
];

const HIGHLIGHT = /\{\\c&H[0-9A-F]{8}\}([a-zA-Z]+)/;

describe("retyped caption timing", () => {
  for (const { label, line, tokens } of CASES) {
    it(`covers the line end to end with ${label}`, () => {
      const timed = retypedWords(line);
      expect(timed).toHaveLength(tokens);
      expect(timed[0].startMs).toBe(line.startMs);
      expect(timed[timed.length - 1].endMs).toBe(line.endMs);
      // Contiguous: no gap and no overlap between neighbours.
      for (let i = 1; i < timed.length; i += 1) {
        expect(timed[i].startMs).toBe(timed[i - 1].endMs);
      }
      expect(timed.map((w) => w.word)).toEqual(line.text.split(" "));
    });

    it(`lights exactly one token at every instant with ${label}`, () => {
      const timed = retypedWords(line);
      for (let ms = line.startMs; ms < line.endMs; ms += 7) {
        expect(resolveActiveWord(timed, ms), `nothing active at ${ms}ms`).not.toBeNull();
      }
    });

    it(`agrees between preview and export with ${label}`, () => {
      const timed = retypedWords(line);
      const slices = highlightSlices({ ...line, words: timed });
      for (let ms = line.startMs; ms < line.endMs; ms += 7) {
        const preview = resolveActiveWord(timed, ms)?.id ?? null;
        const exported = slices.find((s) => ms >= s.startMs && ms < s.endMs)?.activeWordId ?? null;
        expect(preview, `preview and export disagree at ${ms}ms`).toBe(exported);
      }
    });

    it(`burns in the retyped text, highlighted, with ${label}`, () => {
      const ass = generateAssSubtitles([line], getCaptionPreset("highlighter").style, 1080, 1920);
      const events = ass.split("\n").filter((l) => l.startsWith("Dialogue: 0"));
      // Each token gets its turn — the line is not left dead. Events outnumber tokens because an
      // activation is drawn as one event per phase of the pop.
      const highlighted = new Set(events.map((event) => HIGHLIGHT.exec(event)?.[1]));
      // Highlighter renders uppercase, so compare on the same footing.
      expect(highlighted).toEqual(new Set(line.text.split(" ").map((t) => t.toUpperCase())));
      expect(events.length).toBeGreaterThanOrEqual(tokens);
      for (const event of events) {
        expect(event.split("\\c&H").length - 1, "an event lights no token").toBeGreaterThan(0);
      }
    });
  }

  it("keeps every source timing when only the words themselves changed", () => {
    // A one-token typo fix must not re-time the line: the words still line up one for one, and
    // their timings came from the transcript rather than from a guess.
    const timed = retypedWords(SAME);
    expect(timed.map((w) => [w.startMs, w.endMs])).toEqual(
      SOURCE.map((w) => [w.startMs, w.endMs]),
    );
    expect(timed.map((w) => w.word)).toEqual(["grace", "abides", "here"]);
    // A single corrected word behaves the same way.
    const oneWordFixed = retypedWords(lineWith("peace stays with"));
    expect(oneWordFixed.map((w) => [w.startMs, w.endMs])).toEqual(
      SOURCE.map((w) => [w.startMs, w.endMs]),
    );
  });

  it("divides the line evenly once the token count changes", () => {
    // No correspondence left to preserve, so one stated rule rather than a guess.
    const fewer = retypedWords(FEWER);
    expect(fewer.map((w) => [w.startMs, w.endMs])).toEqual([
      [0, 750],
      [750, 1500],
    ]);
    const more = retypedWords(MORE);
    expect(more).toHaveLength(7);
    expect(more[0].startMs).toBe(0);
    expect(more[6].endMs).toBe(1500);
  });

  it("leaves a legacy preset's retyped line whole and unhighlighted", () => {
    const ass = generateAssSubtitles([SAME], getCaptionPreset("clean").style, 1080, 1920);
    const events = ass.split("\n").filter((l) => l.startsWith("Dialogue: 0"));
    expect(events).toHaveLength(1);
    expect(ass).not.toContain("\\c&H");
  });

  it("renders an emptied line whole rather than inventing a token", () => {
    const blank = lineWith("   ");
    expect(retypedWords(blank)).toHaveLength(0);
    const ass = generateAssSubtitles([blank], getCaptionPreset("highlighter").style, 1080, 1920);
    expect(ass.split("\n").filter((l) => l.startsWith("Dialogue: 0"))).toHaveLength(1);
  });
});
