import { describe, expect, it } from "vitest";
import { distributeDurationByWeight } from "@/lib/transcription/timing";

describe("distributeDurationByWeight", () => {
  it("returns an empty list for no tokens", () => {
    expect(distributeDurationByWeight([], 0, 1000)).toEqual([]);
  });

  it("covers the span exactly and contiguously", () => {
    const timed = distributeDurationByWeight(["one", "two", "three"], 500, 2600);

    expect(timed[0].startMs).toBe(500);
    expect(timed[timed.length - 1].endMs).toBe(2600);
    for (let i = 1; i < timed.length; i += 1) {
      expect(timed[i].startMs).toBe(timed[i - 1].endMs);
    }
  });

  it("weights longer tokens more heavily", () => {
    const [a, extraordinary] = distributeDurationByWeight(["a", "extraordinary"], 0, 2000);
    expect(extraordinary.endMs - extraordinary.startMs).toBeGreaterThan(a.endMs - a.startMs);
  });

  it("adds a pause bonus for sentence-ending punctuation", () => {
    const [plain] = distributeDurationByWeight(["word", "word"], 0, 2000);
    const [punctuated] = distributeDurationByWeight(["word.", "word"], 0, 2000);
    expect(punctuated.endMs - punctuated.startMs).toBeGreaterThan(plain.endMs - plain.startMs);
  });

  it("caps a single dominant word and redistributes the excess", () => {
    const timed = distributeDurationByWeight(
      ["supercalifragilisticexpialidocious", "a", "b", "c"],
      0,
      3000,
    );

    expect(timed[0].endMs - timed[0].startMs).toBeLessThanOrEqual(1200);
    expect(timed[timed.length - 1].endMs).toBe(3000);
    // the freed time went to the short words (uniform share would have been 150ms)
    for (const short of timed.slice(1)) {
      expect(short.endMs - short.startMs).toBeGreaterThan(300);
    }
  });

  it("never inverts weight ordering, even when the span forces every word past the cap", () => {
    const timed = distributeDurationByWeight(["extraordinarily", "a"], 0, 8000);

    expect(timed[timed.length - 1].endMs).toBe(8000);
    expect(timed[0].endMs - timed[0].startMs).toBeGreaterThanOrEqual(
      timed[1].endMs - timed[1].startMs,
    );
  });

  it("keeps a degenerate zero-duration span monotonic", () => {
    const timed = distributeDurationByWeight(["a", "b"], 1000, 1000);
    expect(timed[0].startMs).toBe(1000);
    expect(timed[timed.length - 1].endMs).toBe(1000);
    for (let i = 1; i < timed.length; i += 1) {
      expect(timed[i].startMs).toBeGreaterThanOrEqual(timed[i - 1].startMs);
    }
  });
});
