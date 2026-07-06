import { describe, expect, it } from "vitest";
import { detectFillers } from "@/lib/transcription/filler-detection";
import type { TranscriptWord } from "@/lib/transcription/types";

function word(word: string, confidence = 0.95): TranscriptWord {
  return { word, startMs: 0, endMs: 100, confidence, isFiller: false, deleted: false };
}

describe("detectFillers", () => {
  it("flags single-word lexicon matches", () => {
    const result = detectFillers([word("So"), word("um"), word("today")]);
    expect(result.map((w) => w.isFiller)).toEqual([false, true, false]);
  });

  it("is case-insensitive and ignores trailing punctuation", () => {
    const result = detectFillers([word("Um,"), word("Uh.")]);
    expect(result.every((w) => w.isFiller)).toBe(true);
  });

  it("flags multi-word phrases across consecutive words", () => {
    const result = detectFillers([word("it's"), word("you"), word("know"), word("true")]);
    expect(result.map((w) => w.isFiller)).toEqual([false, true, true, false]);
  });

  it("flags low-confidence words even without a lexicon match", () => {
    const result = detectFillers([word("truth", 0.2)], { confidenceThreshold: 0.5 });
    expect(result[0].isFiller).toBe(true);
  });

  it("does not mutate the input words", () => {
    const input = [word("um")];
    detectFillers(input);
    expect(input[0].isFiller).toBe(false);
  });

  it("respects a custom lexicon", () => {
    const result = detectFillers([word("amen"), word("um")], { lexicon: ["amen"] });
    expect(result.map((w) => w.isFiller)).toEqual([true, false]);
  });
});
