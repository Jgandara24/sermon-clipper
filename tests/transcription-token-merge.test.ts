import { describe, expect, it } from "vitest";
import { buildCaptionLines } from "@/lib/editor/caption-lines";
import { mergeTokensIntoWords, type RawTranscriptToken } from "@/lib/transcription/token-merge";

const token = (text: string, startMs: number, endMs: number, p = 1): RawTranscriptToken => ({ text, startMs, endMs, p });

describe("new whisper word reconstruction", () => {
  it("keeps lexical suffix timing even across a provider timestamp gap", () => {
    const words = mergeTokensIntoWords([token(" Philipp", 100, 200), token("ians", 500, 700), token(".", 1800, 1800)]);
    expect(words).toEqual([{ word: "Philippians.", startMs: 100, endMs: 700, confidence: 1, isFiller: false, deleted: false }]);
  });
  it("skips pseudo tokens without breaking a word", () => {
    expect(mergeTokensIntoWords([token(" trib", 0, 200), token("[_TT_50]", 200, 200), token("ulations", 200, 500)]))
      .toMatchObject([{ word: "tribulations", startMs: 0, endMs: 500 }]);
  });
  it("keeps real whitespace boundaries, including separate whitespace tokens", () => {
    expect(mergeTokensIntoWords([token("Hello", 0, 200), token(" ", 200, 200), token("world", 200, 500), token("\nagain", 600, 800)])
      .map((word) => word.word)).toEqual(["Hello", "world", "again"]);
  });
  it("preserves fillers, repetitions, apostrophes, and hyphenated words", () => {
    const words = mergeTokensIntoWords([token(" Um", 0, 100), token(",", 100, 100), token(" I", 200, 300),
      token(" I", 400, 450), token("'m", 450, 500), token(" well", 600, 700), token("-", 700, 700), token("known", 700, 900)]);
    expect(words.map((word) => word.word)).toEqual(["Um,", "I", "I'm", "well-known"]);
    expect(words.every((word) => !word.deleted && !word.isFiller)).toBe(true);
  });
  it.each(["中文", "日本語", "ภาษาไทย", "한국어"])("does not collapse unspaced %s into one word", (text) => {
    const characters = Array.from(text);
    const words = mergeTokensIntoWords(characters.map((character, i) => token(character, i * 100, (i + 1) * 100)));
    expect(words.map((word) => word.word)).toEqual(characters);
  });
  it("keeps long alphabetic words whole without a character-count cut", () => {
    const text = "pneumonoultramicroscopicsilicovolcanoconiosis";
    expect(mergeTokensIntoWords([token(` ${text.slice(0, 33)}`, 0, 500), token(text.slice(33), 500, 900)])[0].word).toBe(text);
  });
  it("passes complete words to the existing caption line builder", () => {
    const words = mergeTokensIntoWords([token(" Re", 0, 100), token("joice", 100, 400), token(" in", 500, 700),
      token(" trib", 800, 900), token("ulations", 900, 1200), token(".", 2000, 2000)]);
    const lines = buildCaptionLines(words.map((word, i) => ({ ...word, id: `new-segment:${i}` })));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ text: "Rejoice in tribulations.", startMs: 0, endMs: 1200 });
  });
  it("does not change its raw input", () => {
    const tokens = [token(" Philipp", 0, 100), token("ians", 100, 200)];
    const before = structuredClone(tokens);
    mergeTokensIntoWords(tokens);
    expect(tokens).toEqual(before);
  });
});
