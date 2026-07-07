import type { Subscore } from "./types";

/** Bands a 0-100 score into a letter grade per guide §11. */
export function scoreToLetter(score: number): string {
  if (score >= 97) return "A+";
  if (score >= 93) return "A";
  if (score >= 90) return "A-";
  if (score >= 87) return "B+";
  if (score >= 83) return "B";
  if (score >= 80) return "B-";
  if (score >= 77) return "C+";
  if (score >= 73) return "C";
  if (score >= 70) return "C-";
  if (score >= 60) return "D";
  return "F";
}

export const DEFAULT_WEIGHTS: Record<string, number> = {
  hook_strength: 0.15,
  clarity: 0.15,
  emotional_impact: 0.15,
  completeness: 0.15,
  shareability: 0.15,
  speaker_energy: 0.1,
  topic_relevance: 0.1,
  platform_fit: 0.05,
};

export const SERMON_WEIGHTS: Record<string, number> = {
  clarity: 0.12,
  emotional_impact: 0.1,
  completeness: 0.12,
  shareability: 0.1,
  speaker_energy: 0.05,
  platform_fit: 0.04,
  biblical_usefulness: 0.18,
  theological_clarity: 0.14,
  pastoral_tone: 0.1,
  scripture_relevance: 0.05,
};

/** total = round(sum(weight_i * score_i)) per guide §11. */
export function computeTotal(
  subscores: Record<string, Subscore>,
  weights: Record<string, number> = DEFAULT_WEIGHTS,
): number {
  return Math.round(
    Object.entries(subscores).reduce((sum, [key, sub]) => sum + sub.score * (weights[key] ?? 0), 0),
  );
}
