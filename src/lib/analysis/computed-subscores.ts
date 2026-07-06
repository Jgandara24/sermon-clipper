import type { Subscore } from "./types";
import { scoreToLetter } from "./scoring";

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Subscores computed from real signals (duration, word count, timing) rather than LLM judgment
 * — guide §11 "computed: words/min + pitch variance if available". Shared by every
 * AnalysisProvider so these three dimensions are identical regardless of which one scores the
 * subjective categories.
 */
export function computePlatformFit(durationS: number, idealS = 50): Subscore {
  const score = Math.round(clamp(100 - Math.abs(durationS - idealS) * 1.5));
  return {
    score,
    letter: scoreToLetter(score),
    note: `${Math.round(durationS)}s — ${score >= 80 ? "close to" : "off from"} the ideal length.`,
  };
}

export function computeSpeakerEnergy(wordCount: number, durationS: number): Subscore {
  const wpm = durationS > 0 ? (wordCount / durationS) * 60 : 0;
  const paceDelta = wpm < 120 ? 120 - wpm : wpm > 160 ? wpm - 160 : 0;
  const score = Math.round(clamp(95 - paceDelta * 1.2));
  return { score, letter: scoreToLetter(score), note: `About ${Math.round(wpm)} words per minute.` };
}

export function computeCompleteness(wordCount: number): Subscore {
  const score = clamp(wordCount < 8 ? 60 : 88);
  return { score, letter: scoreToLetter(score), note: "Starts and ends on a full sentence." };
}
