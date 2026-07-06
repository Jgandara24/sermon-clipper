import { describe, expect, it } from "vitest";
import {
  computeCompleteness,
  computePlatformFit,
  computeSpeakerEnergy,
} from "@/lib/analysis/computed-subscores";
import { computeTotal, scoreToLetter } from "@/lib/analysis/scoring";

describe("scoreToLetter", () => {
  it("bands scores into letter grades", () => {
    expect(scoreToLetter(98)).toBe("A+");
    expect(scoreToLetter(94)).toBe("A");
    expect(scoreToLetter(85)).toBe("B");
    expect(scoreToLetter(75)).toBe("C");
    expect(scoreToLetter(65)).toBe("D");
    expect(scoreToLetter(10)).toBe("F");
  });
});

describe("computeTotal", () => {
  it("computes a weighted sum rounded to an integer", () => {
    const subscores = {
      hook_strength: { score: 80, letter: "B-", note: "" },
      clarity: { score: 90, letter: "A-", note: "" },
      emotional_impact: { score: 70, letter: "C", note: "" },
      completeness: { score: 88, letter: "B+", note: "" },
      shareability: { score: 75, letter: "C+", note: "" },
      speaker_energy: { score: 95, letter: "A+", note: "" },
      topic_relevance: { score: 60, letter: "D", note: "" },
      platform_fit: { score: 100, letter: "A+", note: "" },
    };
    const total = computeTotal(subscores);
    expect(total).toBeGreaterThan(0);
    expect(Number.isInteger(total)).toBe(true);
  });
});

describe("computePlatformFit", () => {
  it("scores highest at the ideal duration", () => {
    const ideal = computePlatformFit(50);
    const short = computePlatformFit(20);
    const long = computePlatformFit(90);
    expect(ideal.score).toBeGreaterThan(short.score);
    expect(ideal.score).toBeGreaterThan(long.score);
  });
});

describe("computeSpeakerEnergy", () => {
  it("scores highest within the natural pacing range", () => {
    const good = computeSpeakerEnergy(140, 60); // 140 wpm
    const slow = computeSpeakerEnergy(40, 60); // 40 wpm
    const fast = computeSpeakerEnergy(400, 60); // 400 wpm
    expect(good.score).toBeGreaterThan(slow.score);
    expect(good.score).toBeGreaterThan(fast.score);
  });

  it("handles zero duration without dividing by zero", () => {
    const result = computeSpeakerEnergy(10, 0);
    expect(Number.isFinite(result.score)).toBe(true);
  });
});

describe("computeCompleteness", () => {
  it("penalizes very short word counts", () => {
    const short = computeCompleteness(3);
    const normal = computeCompleteness(20);
    expect(normal.score).toBeGreaterThan(short.score);
  });
});
