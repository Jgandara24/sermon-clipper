/**
 * Where each word of a caption line sits, at rest and while one of them is popped.
 *
 * Both renderers call this. The browser preview and the burned-in file position words from the
 * same numbers rather than approximating each other: before this module, the preview let CSS lay
 * out inline blocks and the burn-in handed libass one event carrying the whole run, and neither
 * side knew a word's width. A neighbour cannot move aside by an amount nobody has computed.
 *
 * It is pure, and it holds no fonts and no DOM. The caller injects a measurer bound to the face
 * and size it is drawing, so the same rule serves fontkit on the worker and the canvas in the
 * browser.
 *
 * The rule, in one sentence: words sit at rest spacing, and when one pops, everything on its left
 * moves left by the clearance it needs and everything on its right moves right by the same amount.
 *
 * Moving whole sides rather than only the two immediate neighbours is the part worth stating.
 * Shifting just the neighbours would close the gap between them and the words beyond them, so
 * clearing one collision would create another. Moving a side together preserves every gap on that
 * side, and only the outer edges of the line move outward.
 */

/** One word to lay out. The text is what will be drawn, already cased. */
export type CaptionLayoutWord = {
  id: string;
  text: string;
};

/** Advance width of a string, in the same pixel space the caller positions in. */
export type CaptionWordMeasurer = (text: string) => number;

export type LaidOutCaptionWord = {
  id: string;
  text: string;
  /** Advance width at rest, from the measurer. */
  width: number;
  /** Centre of the word, relative to the centre of the line, at rest. */
  restX: number;
  /** Centre of the word at the peak of the active word's pop. */
  shiftedX: number;
};

export type CaptionLineLayout = {
  words: LaidOutCaptionWord[];
  /** Width of the line at rest: every word plus one space between each pair. */
  restWidth: number;
  /** Centre of one word at rest, or 0 for a word this line does not carry. */
  restX(wordId: string): number;
  /** Centre of one word at the peak of the pop, or 0 for a word this line does not carry. */
  shiftedX(wordId: string): number;
};

export type CaptionLineLayoutParams = {
  words: CaptionLayoutWord[];
  measure: CaptionWordMeasurer;
  /** Advance width of one space in the same face and size. */
  spaceWidth: number;
  /** The word being lit, or null when nothing on this line is active. */
  activeWordId: string | null;
  /** The largest scale the active word reaches. 1 means the pop has no size to it. */
  peakScale: number;
};

export function layOutCaptionLine(params: CaptionLineLayoutParams): CaptionLineLayout {
  const measured = params.words.map((word) => ({
    id: word.id,
    text: word.text,
    width: params.measure(word.text),
  }));

  const restWidth =
    measured.reduce((total, word) => total + word.width, 0) +
    params.spaceWidth * Math.max(0, measured.length - 1);

  // Laid out left to right from the line's left edge, then expressed relative to its centre, so a
  // caller only has to add the point the line is anchored at.
  const halfWidth = restWidth / 2;
  let cursor = 0;
  const rested = measured.map((word) => {
    const restX = cursor + word.width / 2 - halfWidth;
    cursor += word.width + params.spaceWidth;
    return { ...word, restX };
  });

  const activeIndex = params.activeWordId
    ? rested.findIndex((word) => word.id === params.activeWordId)
    : -1;

  // The clearance the active word needs on each side to grow about its own centre without
  // touching what is beside it. A line of one word has nothing to clear.
  const clearance =
    activeIndex === -1 || rested.length < 2
      ? 0
      : ((params.peakScale - 1) * rested[activeIndex].width) / 2;

  const words: LaidOutCaptionWord[] = rested.map((word, index) => ({
    ...word,
    shiftedX:
      clearance === 0 || index === activeIndex
        ? word.restX
        : index < activeIndex
          ? word.restX - clearance
          : word.restX + clearance,
  }));

  const byId = new Map(words.map((word) => [word.id, word]));
  return {
    words,
    restWidth,
    restX: (wordId) => byId.get(wordId)?.restX ?? 0,
    shiftedX: (wordId) => byId.get(wordId)?.shiftedX ?? 0,
  };
}
