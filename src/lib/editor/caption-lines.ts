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
 * A line's identity, from the words it holds.
 *
 * `line-N` named a line by its position in the list, so anything that changed the list ahead of
 * it — a trim that dropped the first line, a regrouping — renamed every line after it, and a text
 * override written against one line silently moved onto another. The name is now the first
 * word's id (the transcript's segment and index, which no trim or regrouping changes) followed by
 * a hash of every word id in the line: a line means the same words, or it is not the same line.
 * Deterministic and dependency-free, because the preview computes it in the browser and the
 * burn-in in the worker, and an override has to match on both sides.
 */
export function captionLineId(words: ReadonlyArray<Pick<CaptionWord, "id">>): string {
  const ids = words.map((word) => word.id);
  return `line:${ids[0] ?? ""}:${fnv1a32(ids.join("|"))}`;
}

/** FNV-1a, 32-bit, as eight hex digits. Small, stable, and the same in every runtime. */
function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

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

/** The name lines carried before they were named by their words: their position in the list. */
const LEGACY_POSITIONAL_ID = /^line-(\d+)$/;

/**
 * Applies manual text overrides without touching word timing.
 *
 * An override names its line by the stable id above. A document written when lines were named by
 * position — `line-N` — is still read: that override applies to the line at that position, unless
 * a stable-id override already claims the line, so a document carrying both cannot have two
 * answers for one line. Nothing writes a positional id any more.
 */
export function applyCaptionTextOverrides(
  lines: CaptionLine[],
  textOverrides: Array<{ segmentId: string; text: string }>,
): CaptionLine[] {
  const byId = new Map<string, string>();
  const byPosition = new Map<number, string>();
  for (const override of textOverrides) {
    const positional = LEGACY_POSITIONAL_ID.exec(override.segmentId);
    if (positional) byPosition.set(Number(positional[1]), override.text);
    else byId.set(override.segmentId, override.text);
  }
  return lines.map((line, index) => {
    const text = byId.get(line.id) ?? byPosition.get(index);
    return text === undefined ? line : { ...line, text };
  });
}

/**
 * True when the line's text no longer spells out its words — i.e. a member has retyped it.
 *
 * A line that carries no words at all is not retyped: there is nothing for its text to differ
 * from, and it renders whole exactly as it always did.
 */
export function isRetyped(line: Pick<CaptionLine, "text"> & { words?: CaptionWord[] }): boolean {
  const words = line.words ?? [];
  if (words.length === 0) return false;
  return words.map((word) => word.word).join(" ") !== line.text;
}

/**
 * Timings for a retyped line.
 *
 * Two cases, decided by whether the member changed how many words there are.
 *
 * **A correction** — the same number of tokens — keeps each source word's timing and replaces only
 * its text. Fixing one typo must not re-time the whole line: the words underneath still line up
 * one for one with what is now written, and their timings came from the transcript rather than
 * from a guess.
 *
 * **A rewrite** — tokens added or removed — has no such correspondence, and matching edited text
 * back to source words is guesswork that the preview and the burn-in would have to guess
 * identically. So the line's own span is divided evenly among the tokens as typed. That loses the
 * original timing, which is the honest cost of text that no longer corresponds to it, and it is
 * one rule: total, stated here, and applied by both renderers.
 *
 * Giving up instead — highlighting nothing — sounds safe and is worse where it shows: on
 * Highlighter the caption goes dead for the whole line while somebody is speaking.
 *
 * The last token is closed on the line's own end so rounding cannot leave a sliver with nothing
 * active.
 */
export function retypedWords(
  line: Pick<CaptionLine, "id" | "startMs" | "endMs" | "text"> & { words?: CaptionWord[] },
): CaptionWord[] {
  const tokens = line.text.trim().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return [];

  const source = line.words ?? [];
  if (source.length === tokens.length) {
    return tokens.map((token, index) => ({ ...source[index], word: token }));
  }

  const span = line.endMs - line.startMs;
  return tokens.map((token, index) => ({
    id: `${line.id}-retyped-${index}`,
    word: token,
    startMs: line.startMs + Math.round((span * index) / tokens.length),
    endMs:
      index === tokens.length - 1
        ? line.endMs
        : line.startMs + Math.round((span * (index + 1)) / tokens.length),
  }));
}
