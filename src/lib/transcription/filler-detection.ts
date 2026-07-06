import type { TranscriptSegmentResult, TranscriptWord } from "./types";

export const DEFAULT_FILLER_LEXICON = ["um", "umm", "uh", "uhh", "erm", "you know", "like"];

function normalize(word: string): string {
  return word.toLowerCase().replace(/[.,!?;:'"]/g, "");
}

/**
 * Flags filler words by lexicon match and low confidence (guide §9 step 4). Multi-word phrases
 * in the lexicon (e.g. "you know") are matched against consecutive word windows.
 */
export function detectFillers(
  words: TranscriptWord[],
  options: { lexicon?: string[]; confidenceThreshold?: number } = {},
): TranscriptWord[] {
  const lexicon = options.lexicon ?? DEFAULT_FILLER_LEXICON;
  const confidenceThreshold = options.confidenceThreshold ?? 0.5;
  const singleWordLexicon = new Set(lexicon.filter((entry) => !entry.includes(" ")));
  const phraseLexicon = lexicon.filter((entry) => entry.includes(" "));

  const flagged = words.map((word) => ({ ...word }));

  for (const word of flagged) {
    const normalized = normalize(word.word);
    if (singleWordLexicon.has(normalized) || word.confidence < confidenceThreshold) {
      word.isFiller = true;
    }
  }

  for (const phrase of phraseLexicon) {
    const phraseWords = phrase.split(" ");
    for (let i = 0; i <= flagged.length - phraseWords.length; i += 1) {
      const window = flagged.slice(i, i + phraseWords.length).map((w) => normalize(w.word));
      if (window.join(" ") === phrase) {
        for (let j = i; j < i + phraseWords.length; j += 1) {
          flagged[j].isFiller = true;
        }
      }
    }
  }

  return flagged;
}

export function applyFillerDetection(
  segments: TranscriptSegmentResult[],
  options?: { lexicon?: string[]; confidenceThreshold?: number },
): TranscriptSegmentResult[] {
  return segments.map((segment) => ({
    ...segment,
    words: detectFillers(segment.words, options),
  }));
}
