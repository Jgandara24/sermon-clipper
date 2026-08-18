import type { TranscriptWord } from "./types";

/**
 * Merges whisper.cpp sub-word tokens into whole TranscriptWords. whisper's BPE tokenizer
 * splits long words ("un" + "believable") and detaches punctuation; its word-boundary signal
 * is a LEADING SPACE on the token text, so this operates on the raw, untrimmed token text —
 * trimming first destroys the only merge signal (the bug this module replaced).
 *
 * Forward-only by design: merging renumbers word indices, and editor word ids are positional
 * (`segmentId:index`), so already-stored transcripts are never rewritten (see DECISIONS.md).
 */

export type RawToken = { text: string; startMs: number; endMs: number; p: number };

// whisper.cpp emits bracketed pseudo-tokens like [_BEG_], [_TT_160] alongside real words.
const SPECIAL_TOKEN_PATTERN = /^\[.*\]$/;

// whisper habitually stamps sentence-final punctuation at the SEGMENT end, seconds after the
// word it belongs to. Attaching the text is right; extending the word's end time across that
// silence is not — the highlight would stall on the word. Beyond this gap, keep the time.
const ATTACH_MAX_GAP_MS = 200;

// Guard for scripts without space-delimited tokens (CJK, Thai): without a boundary signal
// every token would merge into one giant "word", so force breaks there. Ranges: Han, Hiragana,
// Katakana, Hangul, Thai.
const NO_SPACE_SCRIPT_PATTERN = /[⺀-鿿぀-ヿ가-힯฀-๿]/;
const MAX_MERGED_CHARS = 30;

export function mergeTokensIntoWords(tokens: RawToken[]): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  // Confidence is the geometric mean of the pieces; accumulate in log space.
  let logConfidenceSum = 0;
  let pieceCount = 0;

  function finishCurrent() {
    if (pieceCount === 0) return;
    const current = words[words.length - 1];
    current.word = current.word.trim();
    current.confidence = Math.exp(logConfidenceSum / pieceCount);
    logConfidenceSum = 0;
    pieceCount = 0;
    if (current.word.length === 0) words.pop();
  }

  for (const token of tokens) {
    const trimmed = token.text.trim();
    // Skipping a pseudo-token must not break attachment across it — just continue.
    if (trimmed.length === 0 || SPECIAL_TOKEN_PATTERN.test(trimmed)) continue;

    const current = pieceCount > 0 ? words[words.length - 1] : null;
    const startsWord =
      current === null ||
      /^\s/.test(token.text) ||
      current.word.length >= MAX_MERGED_CHARS ||
      NO_SPACE_SCRIPT_PATTERN.test(current.word);

    if (startsWord || current === null) {
      finishCurrent();
      words.push({
        word: token.text,
        startMs: token.startMs,
        endMs: token.endMs,
        confidence: 1,
        isFiller: false,
        deleted: false,
      });
    } else {
      current.word += token.text;
      if (token.startMs - current.endMs <= ATTACH_MAX_GAP_MS) {
        current.endMs = Math.max(current.endMs, token.endMs);
      }
    }
    logConfidenceSum += Math.log(Math.max(token.p, 1e-9));
    pieceCount += 1;
  }
  finishCurrent();

  return words;
}
