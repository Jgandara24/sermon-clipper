import type { AnalysisCandidate } from "./types";

const NON_SERMON_TERMS = [
  "worship team",
  "worship",
  "stand and sing",
  "sing with",
  "let's sing",
  "lets sing",
  "offering",
  "giving",
  "giving kiosk",
  "announcements",
  "connect card",
  "first time guest",
  "welcome desk",
  "children's ministry",
  "kids ministry",
  "small groups sign up",
];

const SERMON_TERMS = [
  "scripture",
  "bible",
  "turn with me",
  "the text says",
  "jesus",
  "christ",
  "gospel",
  "grace",
  "faith",
  "sin",
  "prayer",
  "lord",
  "romans",
  "john",
  "psalm",
  "matthew",
];

function includesAny(text: string, terms: string[]): boolean {
  return terms.some((term) => {
    if (term.includes(" ")) return text.includes(term);
    return new RegExp(`\\b${term}\\b`).test(text);
  });
}

export function isLikelyNonSermonText(text: string): boolean {
  const normalized = text.toLowerCase();
  return includesAny(normalized, NON_SERMON_TERMS) && !includesAny(normalized, SERMON_TERMS);
}

export function filterSermonCandidates(candidates: AnalysisCandidate[]): AnalysisCandidate[] {
  const filtered = candidates.filter((candidate) => !isLikelyNonSermonText(candidate.text));
  return filtered.length > 0 ? filtered : candidates;
}
