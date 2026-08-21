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

/**
 * Makes the lines mutually exclusive in time. Highlighter's path only.
 *
 * A line ends at its last word's end, and source word intervals overlap — so the last word of one
 * line can still be running when the first word of the next has started. Left alone that puts two
 * lines on screen at once, and the burn-in then highlights a word in each while the preview, which
 * takes the first line matching the instant, shows one. Ending each line where the next begins
 * removes the overlap for both readers at once, from one definition.
 *
 * The words are left exactly as they are. Only the line's own on-screen span moves, and only ever
 * earlier — a line is never extended over its neighbour.
 */
export function exclusiveLineSpans(lines: CaptionLine[]): CaptionLine[] {
  return lines.map((line, index) => {
    const next = lines[index + 1];
    if (!next || next.startMs >= line.endMs) return line;
    return { ...line, endMs: Math.max(line.startMs, next.startMs) };
  });
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
