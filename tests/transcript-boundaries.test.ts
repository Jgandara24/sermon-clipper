import { describe, expect, it } from "vitest";
import { deriveTranscriptBoundaries, type TranscriptBoundaryInput } from "@/lib/transcription/boundaries";

const input: TranscriptBoundaryInput = {
  submittedAudioSha256: "a".repeat(64), sourceInterval: { startMs: 60000, endMs: 70000 },
  words: [{ text: "Hello.", startMs: 100, endMs: 500, speakerId: "one" },
    { text: "Next", startMs: 3000, endMs: 3500, speakerId: "one" },
    { text: "sentence!", startMs: 3600, endMs: 4100, speakerId: "one" }],
  acousticSilence: { status: "available", evidenceSha256: "b".repeat(64), intervals: [{ startMs: 60500, endMs: 63000 }] },
  settings: { paragraphSilenceMinimumMs: 1000, splitOnSpeakerChange: true, nonTerminalTokens: ["Dr."] },
};

describe("deterministic transcript boundaries", () => {
  it("maps every word and structural interval onto the exact source clock", () => {
    const result = deriveTranscriptBoundaries(input);
    expect(result.words[0]).toMatchObject({ startMs: 60100, endMs: 60500 });
    expect(result.paragraphs).toEqual([
      { startWord: 0, endWord: 1, startMs: 60100, endMs: 60500, endReason: "acoustic-silence" },
      { startWord: 1, endWord: 3, startMs: 63000, endMs: 64100, endReason: "transcript-end" },
    ]);
    expect(result.sentences).toEqual(result.paragraphs);
    expect(result.capabilities.sentences.status).toBe("derived");
    expect(result.acousticEvidenceSha256).toBe("b".repeat(64));
  });
  it("does not call missing transcript speech acoustic silence", () => {
    const result = deriveTranscriptBoundaries({ ...input, acousticSilence: { status: "unavailable", reason: "No audio facts." } });
    expect(result.silences).toEqual([]);
    expect(result.paragraphs).toHaveLength(1);
    expect(result.sentences).toHaveLength(2);
    expect(result.capabilities.silences.status).toBe("unavailable");
  });
  it("finds a qualifying silence after a shorter silence in the same word gap", () => {
    const result = deriveTranscriptBoundaries({ ...input, acousticSilence: { status: "available", evidenceSha256: "b".repeat(64),
      intervals: [{ startMs: 60500, endMs: 60600 }, { startMs: 61000, endMs: 63000 }] } });
    expect(result.paragraphs[0].endReason).toBe("acoustic-silence");
  });
  it("keeps abbreviations and trailing closing punctuation deterministic", () => {
    const result = deriveTranscriptBoundaries({ ...input, words: [
      { text: "Dr.", startMs: 0, endMs: 100, speakerId: null },
      { text: "Smith!\u201d", startMs: 100, endMs: 200, speakerId: null },
      { text: "Yes", startMs: 200, endMs: 300, speakerId: null },
    ] });
    expect(result.sentences.map(span => [span.startWord, span.endWord])).toEqual([[0, 2], [2, 3]]);
  });
  it("preserves overlapping speaker words and does not invent unknown speaker changes", () => {
    const result = deriveTranscriptBoundaries({ ...input, words: [
      { text: "Long", startMs: 0, endMs: 4000, speakerId: "one" },
      { text: "yes", startMs: 500, endMs: 1000, speakerId: "two" },
      { text: "again", startMs: 3000, endMs: 3200, speakerId: null },
    ] });
    expect(result.words).toHaveLength(3);
    expect(result.paragraphs.map(span => span.endReason)).toEqual(["speaker-change", "transcript-end"]);
    expect(result.paragraphs[0].endMs).toBe(64000);
  });
  it("binds settings and acoustic evidence to stable input provenance", () => {
    const first = deriveTranscriptBoundaries(input);
    expect(deriveTranscriptBoundaries(JSON.parse(JSON.stringify(input)))).toEqual(first);
    expect(deriveTranscriptBoundaries({ ...input, settings: { ...input.settings, paragraphSilenceMinimumMs: 3000 } }).inputSha256)
      .not.toBe(first.inputSha256);
  });
  it("returns no fabricated spans for an empty transcript", () => {
    const result = deriveTranscriptBoundaries({ ...input, words: [] });
    expect(result.sentences).toEqual([]);
    expect(result.paragraphs).toEqual([]);
  });
  it("rejects out-of-order and out-of-corridor clocks", () => {
    expect(() => deriveTranscriptBoundaries({ ...input, words: [...input.words].reverse() })).toThrow("WORD_CLOCK_INVALID");
    expect(() => deriveTranscriptBoundaries({ ...input, words: [{ ...input.words[0], endMs: 10001 }] })).toThrow("WORD_CLOCK_INVALID");
    expect(() => deriveTranscriptBoundaries({ ...input, acousticSilence: { status: "available", evidenceSha256: "b".repeat(64),
      intervals: [{ startMs: 59000, endMs: 61000 }] } })).toThrow("SILENCE_CLOCK_INVALID");
  });
});
