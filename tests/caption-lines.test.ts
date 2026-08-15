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

describe("buildCaptionLines", () => {
  it("splits a line once it reaches maxWordsPerLine", () => {
    const words = [
      word("0", "one", 0, 100),
      word("1", "two", 100, 200),
      word("2", "three", 200, 300),
      word("3", "four", 300, 400),
      word("4", "five", 400, 500),
      word("5", "six", 500, 600),
    ];
    const lines = buildCaptionLines(words, { maxWordsPerLine: 5 });
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

  it("writes stable word-anchored line ids, not positional ones (P1.6)", () => {
    const words = [word("seg-1:0", "hello", 0, 200), word("seg-1:1", "world.", 300, 500)];
    const [line] = buildCaptionLines(words);

    expect(line.id).toBe(captionLineId(words));
    expect(line.id).toContain("seg-1:0");
    expect(line.id).not.toMatch(/^line-\d+$/);
    // deterministic across rebuilds
    expect(buildCaptionLines(words)[0].id).toBe(line.id);
  });

  it("gives regrouped lines different ids when their words change", () => {
    const words = [
      word("s:0", "one", 0, 100),
      word("s:1", "two", 100, 200),
      word("s:2", "three", 200, 300),
    ];
    const [wide] = buildCaptionLines(words, { maxWordsPerLine: 5 });
    const [narrow] = buildCaptionLines(words, { maxWordsPerLine: 2 });
    expect(wide.id).not.toBe(narrow.id);
  });
});

describe("applyCaptionTextOverrides", () => {
  it("replaces text for the matching stable line id and leaves others untouched", () => {
    const lines = buildCaptionLines([word("s:0", "hello", 0, 200), word("s:1", "world.", 300, 500)]);
    const overridden = applyCaptionTextOverrides(lines, [{ segmentId: lines[0].id, text: "Hi there." }]);
    expect(overridden[0].text).toBe("Hi there.");
    // line timing must be unchanged by a text override
    expect(overridden[0].startMs).toBe(lines[0].startMs);
    expect(overridden[0].endMs).toBe(lines[0].endMs);
  });

  it("still reads legacy positional line-N override ids (dual-read)", () => {
    const lines = buildCaptionLines([word("s:0", "hello", 0, 200), word("s:1", "world.", 300, 500)]);
    const overridden = applyCaptionTextOverrides(lines, [{ segmentId: "line-0", text: "Hi there." }]);
    expect(overridden[0].text).toBe("Hi there.");
  });

  it("rebuilds the word array to match the override text, contiguous and span-exact", () => {
    const lines = buildCaptionLines([word("s:0", "helo", 0, 200), word("s:1", "world.", 300, 900)]);
    const [line] = applyCaptionTextOverrides(lines, [
      { segmentId: lines[0].id, text: "Hello there world." },
    ]);

    expect(line.words.map((w) => w.word)).toEqual(["Hello", "there", "world."]);
    expect(line.words[0].startMs).toBe(line.startMs);
    expect(line.words[line.words.length - 1].endMs).toBe(line.endMs);
    for (let i = 1; i < line.words.length; i += 1) {
      expect(line.words[i].startMs).toBe(line.words[i - 1].endMs);
    }
    // override word ids are namespaced under the line and cannot collide with source ids
    expect(line.words.every((w) => w.id.startsWith(`${line.id}:ov:`))).toBe(true);
  });

  it("treats an empty override as no correction", () => {
    const lines = buildCaptionLines([word("s:0", "hello", 0, 200)]);
    const [line] = applyCaptionTextOverrides(lines, [{ segmentId: lines[0].id, text: "   " }]);
    expect(line).toEqual(lines[0]);
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
