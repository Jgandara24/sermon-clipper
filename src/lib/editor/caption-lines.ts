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

/**
 * Greedy line-fill from surviving (non-deleted) words: breaks at maxWordsPerLine, a >=500ms gap,
 * or sentence-ending punctuation (guide §13 step 1). Karaoke timing is preserved per word.
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
      id: `line-${lines.length}`,
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

/** Applies manual text overrides (keyed by caption line id) without touching word timing. */
export function applyCaptionTextOverrides(
  lines: CaptionLine[],
  textOverrides: Array<{ segmentId: string; text: string }>,
): CaptionLine[] {
  const overrideMap = new Map(textOverrides.map((o) => [o.segmentId, o.text]));
  return lines.map((line) =>
    overrideMap.has(line.id) ? { ...line, text: overrideMap.get(line.id)! } : line,
  );
}
