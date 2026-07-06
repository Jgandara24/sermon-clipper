import { describe, expect, it } from "vitest";
import { parseWhisperCppOutput } from "@/lib/transcription/whisper-cpp-provider";

// Trimmed down real output captured from `whisper-cli -ojf` against a TTS-generated fixture.
const REAL_FIXTURE = JSON.stringify({
  result: { language: "en" },
  transcription: [
    {
      offsets: { from: 0, to: 3200 },
      text: " This is a test sermon about peace.",
      tokens: [
        { text: "[_BEG_]", offsets: { from: 0, to: 0 }, p: 0.998424 },
        { text: " This", offsets: { from: 20, to: 250 }, p: 0.817444 },
        { text: " is", offsets: { from: 250, to: 370 }, p: 0.998731 },
        { text: " a", offsets: { from: 370, to: 420 }, p: 0.991548 },
        { text: " test", offsets: { from: 420, to: 650 }, p: 0.911857 },
        { text: " sermon", offsets: { from: 820, to: 1060 }, p: 0.977193 },
        { text: " about", offsets: { from: 1060, to: 1370 }, p: 0.997815 },
        { text: " peace", offsets: { from: 1370, to: 1640 }, p: 0.96626 },
        { text: ".", offsets: { from: 3200, to: 3200 }, p: 0.812514 },
        { text: "[_TT_160]", offsets: { from: 3200, to: 3200 }, p: 0.167179 },
      ],
    },
  ],
});

describe("parseWhisperCppOutput", () => {
  it("extracts language, segment text, and per-word timing", () => {
    const result = parseWhisperCppOutput(REAL_FIXTURE);

    expect(result.language).toBe("en");
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].text).toBe("This is a test sermon about peace.");
    expect(result.segments[0].startMs).toBe(0);
    expect(result.segments[0].endMs).toBe(3200);
  });

  it("filters out bracketed special tokens", () => {
    const result = parseWhisperCppOutput(REAL_FIXTURE);
    const words = result.segments[0].words.map((w) => w.word);

    expect(words).not.toContain("[_BEG_]");
    expect(words).not.toContain("[_TT_160]");
    expect(words).toEqual(["This", "is", "a", "test", "sermon", "about", "peace", "."]);
  });

  it("preserves per-word timing and confidence", () => {
    const result = parseWhisperCppOutput(REAL_FIXTURE);
    const first = result.segments[0].words[0];

    expect(first).toMatchObject({ word: "This", startMs: 20, endMs: 250 });
    expect(first.confidence).toBeCloseTo(0.817444, 5);
  });

  it("defaults new words to not filler and not deleted", () => {
    const result = parseWhisperCppOutput(REAL_FIXTURE);
    expect(result.segments[0].words.every((w) => w.isFiller === false && w.deleted === false)).toBe(
      true,
    );
  });
});
