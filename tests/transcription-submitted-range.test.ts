import { describe, expect, it } from "vitest";
import {
  offsetTranscriptionResult,
  resolveSubmittedSermonRange,
} from "@/lib/transcription/submitted-range";

// Instruction: send the narrowest sermon range already available. Until the coarse
// sermon-boundary stage exists, that is usually the complete service — which is temporarily
// allowed, but must be measured rather than assumed.
describe("resolveSubmittedSermonRange", () => {
  it("submits the whole service when no sermon range is known", () => {
    const range = resolveSubmittedSermonRange({}, 2_820_458);

    expect(range).toEqual({ startMs: 0, endMs: 2_820_458, scope: "full_service" });
  });

  it("submits a configured sermon range when one exists", () => {
    const range = resolveSubmittedSermonRange(
      { sermonRange: { startMs: 900_000, endMs: 3_600_000 } },
      5_400_000,
    );

    expect(range).toEqual({ startMs: 900_000, endMs: 3_600_000, scope: "sermon_range" });
  });

  it("clamps a configured range to the real media bounds", () => {
    const range = resolveSubmittedSermonRange(
      { sermonRange: { startMs: -5_000, endMs: 9_999_999 } },
      1_000_000,
    );

    expect(range).toEqual({ startMs: 0, endMs: 1_000_000, scope: "full_service" });
  });

  // A malformed or inverted range must not silently truncate a sermon. Falling back to the whole
  // service costs money; submitting the wrong window loses the sermon.
  it("ignores a malformed or inverted range and submits the whole service", () => {
    for (const bad of [
      { sermonRange: { startMs: 5_000, endMs: 5_000 } },
      { sermonRange: { startMs: 9_000, endMs: 1_000 } },
      { sermonRange: { startMs: "9000", endMs: 100_000 } },
      { sermonRange: null },
      { sermonRange: [] },
    ]) {
      expect(resolveSubmittedSermonRange(bad, 600_000).scope).toBe("full_service");
    }
  });

  it("reads nothing from a non-object processing config", () => {
    expect(resolveSubmittedSermonRange(null, 1_000).scope).toBe("full_service");
    expect(resolveSubmittedSermonRange("nope", 1_000).scope).toBe("full_service");
  });
});

// Whatever window is submitted, stored timestamps must stay on the source timeline: clip ranges,
// caption timing, and every later feature are all expressed in source time.
describe("offsetTranscriptionResult", () => {
  it("returns the result untouched at a zero offset", () => {
    const result = {
      language: "en",
      segments: [
        {
          startMs: 0,
          endMs: 500,
          text: "peace",
          words: [{ word: "peace", startMs: 0, endMs: 500, confidence: 1, isFiller: false, deleted: false }],
        },
      ],
    };

    expect(offsetTranscriptionResult(result, 0)).toBe(result);
  });

  it("shifts every segment and word back into source time", () => {
    const shifted = offsetTranscriptionResult(
      {
        language: "en",
        segments: [
          {
            startMs: 0,
            endMs: 500,
            text: "peace",
            words: [
              { word: "peace", startMs: 0, endMs: 300, confidence: 1, isFiller: false, deleted: false },
              { word: "stays", startMs: 300, endMs: 500, confidence: 1, isFiller: false, deleted: false },
            ],
          },
        ],
      },
      900_000,
    );

    expect(shifted.segments[0].startMs).toBe(900_000);
    expect(shifted.segments[0].endMs).toBe(900_500);
    expect(shifted.segments[0].words.map((word) => word.startMs)).toEqual([900_000, 900_300]);
    expect(shifted.segments[0].words.map((word) => word.endMs)).toEqual([900_300, 900_500]);
  });
})
