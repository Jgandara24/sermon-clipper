import { describe, expect, it } from "vitest";
import { wordLevelsDb } from "@/lib/export/word-levels";

describe("wordLevelsDb", () => {
  // 16 kHz mono: a loud first second, then a quiet one.
  const rate = 16_000;
  const pcm = new Int16Array(2 * rate).map((_, i) => (i < rate ? 1 : 0.01) * 16_384 * Math.sin(i / 3));

  it("measures each word's loudness over its own time, on the clip's clock", () => {
    const levels = wordLevelsDb(pcm, rate, 10_000, [
      { id: "loud", word: "God", startMs: 10_200, endMs: 10_600 },
      { id: "quiet", word: "Amen.", startMs: 11_200, endMs: 11_600 },
    ]);
    expect(levels.get("loud")!).toBeGreaterThan(-12);
    expect(levels.get("loud")!).toBeLessThan(-6);
    expect(levels.get("loud")! - levels.get("quiet")!).toBeCloseTo(40, 0);
  });

  it("gives a word outside the audio no level, and a very short word at least 10 ms", () => {
    const levels = wordLevelsDb(pcm, rate, 10_000, [
      { id: "after", word: "late", startMs: 13_000, endMs: 13_200 },
      { id: "short", word: "a", startMs: 10_500, endMs: 10_500 },
    ]);
    expect(levels.has("after")).toBe(false);
    expect(levels.get("short")!).toBeGreaterThan(-12);
  });
});
