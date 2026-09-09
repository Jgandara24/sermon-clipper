import type { TranscriptWord } from "./types";

export type RawTranscriptToken = { text: string; startMs: number; endMs: number; p: number };

const SPECIAL_TOKEN_PATTERN = /^\[.*\]$/;
const PUNCTUATION_ONLY = /^\p{P}+$/u;
// Preserve token boundaries for scripts that do not use spaces to delimit words.
// This does not attempt language-specific word segmentation.
const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

/**
 * Reconstruct words before discarding whisper.cpp's whitespace boundary signal.
 *
 * Based on the retained P1 prototype's token merge, with separate handling for whitespace-only
 * tokens and spoken suffix timing. A lexical suffix extends the word through its full sound;
 * punctuation contributes text but cannot stretch the highlight into following silence.
 * Confidence is the geometric mean of the component probabilities, as in that prototype.
 *
 * Called only when parsing new provider output. Never merge already-stored words: their indices
 * form editor word IDs, so changing them would invalidate saved edits and caption overrides.
 */
export function mergeTokensIntoWords(tokens: readonly RawTranscriptToken[]): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  let logConfidence = 0;
  let pieces = 0;
  let whitespaceBoundary = false;

  const finishWord = () => {
    if (pieces > 0) words[words.length - 1].confidence = Math.exp(logConfidence / pieces);
    logConfidence = 0;
    pieces = 0;
  };

  for (const token of tokens) {
    const text = token.text.trim();
    if (SPECIAL_TOKEN_PATTERN.test(text)) continue;
    if (!text) {
      if (/\s/.test(token.text)) whitespaceBoundary = true;
      continue;
    }
    const current = words.at(-1);
    const punctuation = PUNCTUATION_ONLY.test(text);
    const startsWord = !current || whitespaceBoundary || /^\s/.test(token.text) ||
      (!punctuation && (NO_SPACE_SCRIPT.test(current.word) || NO_SPACE_SCRIPT.test(text)));
    if (startsWord) {
      finishWord();
      words.push({ word: text, startMs: token.startMs, endMs: token.endMs,
        confidence: 1, isFiller: false, deleted: false });
    } else {
      current.word += text;
      if (!punctuation) current.endMs = Math.max(current.endMs, token.endMs);
    }
    whitespaceBoundary = false;
    const probability = Number.isFinite(token.p) ? Math.min(1, Math.max(token.p, 1e-9)) : 1e-9;
    logConfidence += Math.log(probability);
    pieces += 1;
  }
  finishWord();
  return words;
}
