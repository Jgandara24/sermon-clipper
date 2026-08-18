import { describe, expect, it } from "vitest";
import { selectTranscriptWord } from "@/lib/editor/transcript-workspace";

describe("selectTranscriptWord", () => {
  it("selects a word and creates one exact navigation request for video and timeline", () => {
    const words = [
      { id: "one", word: "I", startMs: 1000, endMs: 1200 },
      { id: "not", word: "not", startMs: 1400, endMs: 1650 },
    ];

    expect(selectTranscriptWord(words, "not", 7)).toEqual({
      selectedWordId: "not",
      navigation: { wordId: "not", ms: 1400, token: 7 },
    });
  });
});
