import type { TranscriptSegmentResult, TranscriptWord } from "./types";

export const DEFAULT_FILLER_LEXICON = ["um", "umm", "uh", "uhh", "erm", "you know", "like"];

function normalize(word: string): string {
  return word.toLowerCase().replace(/[.,!?;:'"]/g, "");
}

/**
 * Tags filler words by lexicon match only. Confidence describes transcription certainty; it is
 * not evidence that the speaker said a filler. Multi-word phrases are matched across windows.
 */
export function detectFillers(
  words: TranscriptWord[],
  options: { lexicon?: string[]; confidenceThreshold?: number } = {},
): TranscriptWord[] {
  const lexicon = options.lexicon ?? DEFAULT_FILLER_LEXICON;
  const singleWordLexicon = new Set(lexicon.filter((entry) => !entry.includes(" ")));
  const phraseLexicon = lexicon.filter((entry) => entry.includes(" "));

  const flagged = words.map((word) => ({ ...word }));

  for (const word of flagged) {
    const normalized = normalize(word.word);
    if (singleWordLexicon.has(normalized)) {
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
