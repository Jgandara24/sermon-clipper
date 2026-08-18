import { distributeDurationByWeight } from "@/lib/transcription/timing";

export type CaptionWord = {
  id: string;
  word: string;
  startMs: number;
  endMs: number;
};

export type CaptionLine = {
  id: string;
  startMs: number;
  endMs: number;
  words: CaptionWord[];
  text: string;
};

const GAP_SPLIT_MS = 500;
const SENTENCE_END_PATTERN = /[.!?]["')\]]?$/;

/** Deterministic short hash (djb2 xor, base36) — no crypto needed, just stability. */
function hashString(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = (Math.imul(hash, 33) ^ value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Stable line identity (P1.6): anchored to the line's first source word plus a hash of every
 * word id in the line, so an override written against a line survives sessions and regrouping
 * only while it still refers to the same words. The legacy positional `line-N` form is still
 * READ (see applyCaptionTextOverrides) but never written.
 */
export function captionLineId(words: CaptionWord[]): string {
  return `line@${words[0].id}#${hashString(words.map((w) => w.id).join("|"))}`;
}

/**
 * Greedy line-fill from the clip's words: breaks at maxWordsPerLine, a >=500ms gap, or
 * sentence-ending punctuation (guide §13 step 1). Karaoke timing is preserved per word.
 */
export function buildCaptionLines(
  words: CaptionWord[],
  options: { maxWordsPerLine?: number } = {},
): CaptionLine[] {
  const maxWordsPerLine = options.maxWordsPerLine ?? 5;
  const lines: CaptionLine[] = [];
  let current: CaptionWord[] = [];

  function flush() {
    if (current.length === 0) return;
    lines.push({
      id: captionLineId(current),
      startMs: current[0].startMs,
      endMs: current[current.length - 1].endMs,
      words: current,
      text: current.map((w) => w.word).join(" "),
    });
    current = [];
  }

  for (const word of words) {
    const prev = current[current.length - 1];
    const gap = prev ? word.startMs - prev.endMs : 0;

    if (prev && gap >= GAP_SPLIT_MS) {
      flush();
    }

    current.push(word);

    const endsSentence = SENTENCE_END_PATTERN.test(word.word.trim());
    if (current.length >= maxWordsPerLine || endsSentence) {
      flush();
    }
  }
  flush();

  return lines;
}

/**
 * Applies manual text overrides to caption lines. Matches the stable line id first and falls
 * back to the legacy positional `line-N` id (dual-read, P1.6) so hand-crafted documents keep
 * working; only stable ids are ever written by the UI.
 *
 * An override REBUILDS the line's word array, not just its display text: per-word rendering
 * (kinetic captions) draws `words`, so leaving stale words in place would silently ignore the
 * user's correction. The override text is re-tokenized and the line's time span redistributed
 * across the new tokens by natural pacing weight.
 */
export function applyCaptionTextOverrides(
  lines: CaptionLine[],
  textOverrides: Array<{ segmentId: string; text: string }>,
): CaptionLine[] {
  const overrideMap = new Map(textOverrides.map((o) => [o.segmentId, o.text]));
  return lines.map((line, index) => {
    const text = overrideMap.get(line.id) ?? overrideMap.get(`line-${index}`);
    if (text === undefined) return line;
    return applyOverrideToLine(line, text);
  });
}

function applyOverrideToLine(line: CaptionLine, text: string): CaptionLine {
  const tokens = text.split(/\s+/).filter(Boolean);
  // An empty override cannot produce a zero-word line; treat it as "no correction".
  if (tokens.length === 0) return line;

  const words: CaptionWord[] = distributeDurationByWeight(tokens, line.startMs, line.endMs).map(
    (timed, i) => ({
      // Namespaced under the line id — can never collide with source word ids (segmentId:index).
      id: `${line.id}:ov:${i}`,
      word: timed.token,
      startMs: timed.startMs,
      endMs: timed.endMs,
    }),
  );

  return { ...line, words, text: words.map((w) => w.word).join(" ") };
}
