import { describe, expect, it } from "vitest";
import {
  applyCaptionTextOverrides,
  buildCaptionLines,
  captionLineId,
  type CaptionWord,
} from "@/lib/editor/caption-lines";
import { CAPTION_PRESETS, getCaptionPreset } from "@/lib/editor/caption-presets";

function word(id: string, text: string, startMs: number, endMs: number): CaptionWord {
  return { id, word: text, startMs, endMs };
}

/** Six words with transcript-shaped ids: five on the first line, one on the second. */
const SIX_WORDS = [
  word("seg-a:0", "one", 0, 100),
  word("seg-a:1", "two", 100, 200),
  word("seg-a:2", "three", 200, 300),
  word("seg-a:3", "four", 300, 400),
  word("seg-a:4", "five", 400, 500),
  word("seg-a:5", "six", 500, 600),
];

describe("buildCaptionLines", () => {
  it("splits a line once it reaches maxWordsPerLine", () => {
    const lines = buildCaptionLines(SIX_WORDS, { maxWordsPerLine: 5 });
    expect(lines).toHaveLength(2);
    expect(lines[0].words).toHaveLength(5);
    expect(lines[1].words).toHaveLength(1);
  });

  it("splits on a gap of 500ms or more", () => {
    const words = [word("0", "hello", 0, 200), word("1", "world", 1000, 1200)];
    const lines = buildCaptionLines(words);
    expect(lines).toHaveLength(2);
  });

  it("splits at sentence-ending punctuation even under the word limit", () => {
    const words = [word("0", "Peace.", 0, 200), word("1", "Hope", 300, 500)];
    const lines = buildCaptionLines(words, { maxWordsPerLine: 5 });
    expect(lines).toHaveLength(2);
    expect(lines[0].text).toBe("Peace.");
  });

  it("assigns each line the correct start/end timing from its words", () => {
    const words = [word("0", "hi", 0, 100), word("1", "there", 100, 400)];
    const lines = buildCaptionLines(words);
    expect(lines[0]).toMatchObject({ startMs: 0, endMs: 400 });
  });

  it("returns no lines for empty input", () => {
    expect(buildCaptionLines([])).toEqual([]);
  });
});

describe("caption line identity", () => {
  it("names a line by its words, and never by its position", () => {
    const lines = buildCaptionLines(SIX_WORDS);
    expect(lines.map((line) => line.id)).toEqual([
      captionLineId(SIX_WORDS.slice(0, 5)),
      captionLineId(SIX_WORDS.slice(5)),
    ]);
    for (const line of lines) {
      expect(line.id).toMatch(/^line:seg-a:\d+:[0-9a-f]{8}$/);
      expect(line.id).not.toMatch(/^line-\d+$/);
    }
  });

  it("is the same on every build, so the preview and the burn-in agree on it", () => {
    const first = buildCaptionLines(SIX_WORDS).map((line) => line.id);
    const second = buildCaptionLines(SIX_WORDS).map((line) => line.id);
    expect(second).toEqual(first);
  });

  it("keeps a line's name when the lines before it are trimmed away", () => {
    const before = buildCaptionLines(SIX_WORDS);
    // The trim's start moved past the whole first line. Positionally this line just became
    // "line-0"; by its words it is still the line it was.
    const after = buildCaptionLines(SIX_WORDS.slice(5));
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before[1].id);
    expect(after[0].id).not.toBe(before[0].id);
  });

  it("gives two lines with the same text but different words different names", () => {
    const a = buildCaptionLines([word("seg-a:0", "peace", 0, 100)]);
    const b = buildCaptionLines([word("seg-b:0", "peace", 0, 100)]);
    expect(a[0].id).not.toBe(b[0].id);
  });

  it("changes a line's name when its members change, even with the same first word", () => {
    expect(captionLineId(SIX_WORDS.slice(0, 5))).not.toBe(captionLineId(SIX_WORDS.slice(0, 4)));
  });
});

describe("applyCaptionTextOverrides", () => {
  it("replaces text for the matching line and leaves its timing and the other lines untouched", () => {
    const lines = buildCaptionLines(SIX_WORDS);
    const overridden = applyCaptionTextOverrides(lines, [{ segmentId: lines[0].id, text: "One to five." }]);
    expect(overridden[0].text).toBe("One to five.");
    expect(overridden[0].startMs).toBe(lines[0].startMs);
    expect(overridden[0].endMs).toBe(lines[0].endMs);
    expect(overridden[1].text).toBe(lines[1].text);
  });

  it("follows its line across a boundary shift, so a correction stays on the words it was written for", () => {
    const before = buildCaptionLines(SIX_WORDS);
    const override = { segmentId: before[1].id, text: "SIX" };
    // The trim's start moves past the first line. The corrected line is now first in the list.
    const after = applyCaptionTextOverrides(buildCaptionLines(SIX_WORDS.slice(5)), [override]);
    expect(after[0].text).toBe("SIX");
  });

  it("never lands on different words when the lines regroup", () => {
    const before = buildCaptionLines(SIX_WORDS, { maxWordsPerLine: 5 });
    const override = { segmentId: before[0].id, text: "ONE TO FIVE" };
    // A narrower limit regroups the same words. No new line holds exactly the old first line's
    // words, so the override applies nowhere rather than to whichever line sits first.
    const regrouped = applyCaptionTextOverrides(
      buildCaptionLines(SIX_WORDS, { maxWordsPerLine: 3 }),
      [override],
    );
    expect(regrouped.map((line) => line.text)).toEqual(["one two three", "four five six"]);
  });

  it("reads a legacy positional override by position", () => {
    // Documents written before lines were named by their words carry `line-N`. They still render
    // what they rendered; the id is read, not rewritten.
    const lines = buildCaptionLines(SIX_WORDS);
    const overridden = applyCaptionTextOverrides(lines, [
      { segmentId: "line-0", text: "Hi there." },
      { segmentId: "line-1", text: "SIX" },
    ]);
    expect(overridden[0].text).toBe("Hi there.");
    expect(overridden[1].text).toBe("SIX");
  });

  it("lets a stable override win over a legacy one that names the same line", () => {
    const lines = buildCaptionLines(SIX_WORDS);
    const overridden = applyCaptionTextOverrides(lines, [
      { segmentId: "line-0", text: "LEGACY" },
      { segmentId: lines[0].id, text: "STABLE" },
    ]);
    expect(overridden[0].text).toBe("STABLE");
  });

  it("keeps a whitespace-only override, which is a retype to nothing rather than no override", () => {
    const lines = buildCaptionLines(SIX_WORDS);
    const overridden = applyCaptionTextOverrides(lines, [{ segmentId: lines[0].id, text: " \t " }]);
    expect(overridden[0].text).toBe(" \t ");
  });
});

describe("caption presets", () => {
  it("ships at least 3 original, distinctly-named presets", () => {
    expect(CAPTION_PRESETS.length).toBeGreaterThanOrEqual(3);
    const names = CAPTION_PRESETS.map((p) => p.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it("falls back to the first preset for an unknown id", () => {
    expect(getCaptionPreset("does-not-exist")).toEqual(CAPTION_PRESETS[0]);
  });

  it("finds a preset by id", () => {
    expect(getCaptionPreset("karaoke").name).toBe("Karaoke");
  });
});
