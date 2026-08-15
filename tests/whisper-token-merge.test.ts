import { describe, expect, it } from "vitest";
import { mergeTokensIntoWords, type RawToken } from "@/lib/transcription/token-merge";

function token(text: string, startMs: number, endMs: number, p = 0.9): RawToken {
  return { text, startMs, endMs, p };
}

describe("mergeTokensIntoWords", () => {
  it("merges sub-word pieces into one word spanning both tokens", () => {
    const words = mergeTokensIntoWords([token(" un", 0, 150), token("believable", 150, 700)]);

    expect(words).toHaveLength(1);
    expect(words[0]).toMatchObject({ word: "unbelievable", startMs: 0, endMs: 700 });
  });

  it("merges contractions split across tokens", () => {
    const words = mergeTokensIntoWords([token(" don", 0, 200), token("'t", 200, 300)]);
    expect(words.map((w) => w.word)).toEqual(["don't"]);
  });

  it("attaches punctuation with no leading space to the previous word", () => {
    const words = mergeTokensIntoWords([token(" peace", 0, 400), token(",", 400, 420)]);
    expect(words.map((w) => w.word)).toEqual(["peace,"]);
    expect(words[0].endMs).toBe(420);
  });

  it("starts a new word on a leading space", () => {
    const words = mergeTokensIntoWords([token(" hello", 0, 300), token(" world", 300, 600)]);
    expect(words.map((w) => w.word)).toEqual(["hello", "world"]);
  });

  it("does not split a word across an interleaved pseudo-token", () => {
    const words = mergeTokensIntoWords([
      token(" every", 0, 200),
      token("[_TT_42]", 200, 200),
      token("one", 200, 400),
    ]);
    expect(words.map((w) => w.word)).toEqual(["everyone"]);
  });

  it("attaches late-stamped punctuation text without extending the word's end time", () => {
    const words = mergeTokensIntoWords([token(" peace", 1370, 1640), token(".", 3200, 3200)]);

    expect(words).toHaveLength(1);
    expect(words[0].word).toBe("peace.");
    expect(words[0].endMs).toBe(1640);
  });

  it("computes confidence as the geometric mean of the pieces", () => {
    const words = mergeTokensIntoWords([token(" un", 0, 100, 0.64), token("real", 100, 300, 0.25)]);
    expect(words[0].confidence).toBeCloseTo(Math.sqrt(0.64 * 0.25), 6);
  });

  it("forces word breaks in scripts without space-delimited tokens", () => {
    const words = mergeTokensIntoWords([
      token("神", 0, 200),
      token("は", 200, 300),
      token("愛", 300, 500),
    ]);
    expect(words.length).toBeGreaterThan(1);
  });

  it("breaks a runaway merge at the max length guard", () => {
    const pieces = Array.from({ length: 10 }, (_, i) => token("abcdefgh", i * 100, (i + 1) * 100));
    const words = mergeTokensIntoWords([token(" start", 0, 50), ...pieces]);
    expect(words.length).toBeGreaterThan(1);
    expect(Math.max(...words.map((w) => w.word.length))).toBeLessThanOrEqual(38);
  });

  it("returns nothing for only special tokens", () => {
    expect(mergeTokensIntoWords([token("[_BEG_]", 0, 0), token("[_TT_1]", 0, 0)])).toEqual([]);
  });
});
