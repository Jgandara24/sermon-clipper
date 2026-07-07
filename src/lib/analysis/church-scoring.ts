import { detectScriptureReferences, summarizeScriptureReferences } from "./scripture";
import { scoreToLetter } from "./scoring";
import type { Subscore } from "./types";

const THEOLOGY_TERMS = new Set([
  "god",
  "jesus",
  "christ",
  "spirit",
  "gospel",
  "grace",
  "faith",
  "sin",
  "cross",
  "resurrection",
  "kingdom",
  "scripture",
  "truth",
  "mercy",
  "forgive",
  "forgiveness",
]);

const PASTORAL_TERMS = new Set([
  "hope",
  "peace",
  "comfort",
  "burden",
  "weary",
  "anxious",
  "afraid",
  "healing",
  "grief",
  "suffering",
  "trust",
  "prayer",
  "love",
]);

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z']+/g) ?? [];
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function subscore(score: number, note: string): Subscore {
  const rounded = Math.round(score);
  return { score: rounded, letter: scoreToLetter(rounded), note };
}

export function buildChurchSubscores(text: string): Record<string, Subscore> {
  const words = tokenize(text);
  const scriptureReferences = detectScriptureReferences(text);
  const theologyHits = words.filter((word) => THEOLOGY_TERMS.has(word)).length;
  const pastoralHits = words.filter((word) => PASTORAL_TERMS.has(word)).length;
  const unresolvedWarning = /^(it|this|that|they|he|she|so|but|and)\b/i.test(text.trim());

  return {
    biblical_usefulness: subscore(
      clamp(58 + scriptureReferences.length * 18 + theologyHits * 3),
      scriptureReferences.length > 0
        ? `${summarizeScriptureReferences(scriptureReferences)} The clip connects to biblical language.`
        : "No explicit reference detected; scored from biblical vocabulary and sermon context.",
    ),
    theological_clarity: subscore(
      clamp(62 + theologyHits * 4 - (unresolvedWarning ? 12 : 0)),
      unresolvedWarning
        ? "Opens with context-dependent wording; check that the cut is not misleading."
        : "The clip uses clear theological language without an obvious context warning.",
    ),
    pastoral_tone: subscore(
      clamp(60 + pastoralHits * 5),
      pastoralHits > 0
        ? "Uses pastoral language that can serve a listener, not just grab attention."
        : "Tone appears steady, with limited explicit pastoral-care language.",
    ),
    scripture_relevance: subscore(
      clamp(scriptureReferences.length > 0 ? 88 : 48),
      summarizeScriptureReferences(scriptureReferences),
    ),
  };
}
