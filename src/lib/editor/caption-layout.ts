import type { CaptionLine, CaptionWord } from "./caption-lines";
import { overshootScale } from "./caption-animation";
import type { CaptionStyle } from "./caption-presets";
import { safeAreaBounds } from "./social-safe-area";

/**
 * Shared caption layout — THE parity contract between the browser preview and the ASS
 * burn-in. Both consumers position every word from this module's output (the preview as
 * absolutely-positioned spans on a 1080x1920 stage, the generator as \an5\pos events), so a
 * layout decision made here is automatically made identically in both.
 *
 * Per-word absolute positioning exists to defeat libass reflow: libass centers a Dialogue
 * event by its rendered width, so scaling one word in a shared event shifts every other word.
 * Words that own their center points scale about themselves and nothing else moves.
 *
 * Pure and isomorphic: text measurement is injected (fontkit on the worker, canvas 2D in the
 * browser), everything else is arithmetic.
 */

export type TextMeasurer = (
  text: string,
  fontPx: number,
  fontFamily: string,
  fontWeight: number,
) => number;

export type PositionedWord = {
  id: string;
  /** Display text: uppercased here when the style says so — measure what you draw. */
  text: string;
  startMs: number;
  endMs: number;
  xCenter: number;
  yCenter: number;
  widthPx: number;
  row: number;
};

export type CaptionRow = {
  index: number;
  widthPx: number;
  xCenter: number;
  yTop: number;
  heightPx: number;
};

export type CaptionLineLayout = {
  words: PositionedWord[];
  rows: CaptionRow[];
  blockTopY: number;
  blockHeightPx: number;
  blockCenterX: number;
  blockCenterY: number;
};

// The common safe area leaves room for right-side social controls.
const MAX_ROW_WIDTH_RATIO = 0.76;
const LINE_HEIGHT_RATIO = 1.25;
// The block never touches the frame edge, whatever positionY says.
const MIN_BLOCK_MARGIN_RATIO = 0.04;

export function layoutCaptionLine(
  line: Pick<CaptionLine, "words">,
  style: CaptionStyle,
  frame: { width: number; height: number },
  measure: TextMeasurer,
): CaptionLineLayout {
  const display = (word: CaptionWord) => (style.uppercase ? word.word.toUpperCase() : word.word);
  const spaceWidth = measure(" ", style.sizePx, style.fontFamily, style.fontWeight);
  const maxRowWidth = frame.width * MAX_ROW_WIDTH_RATIO;
  const lineHeight = Math.round(style.sizePx * LINE_HEIGHT_RATIO);
  const maximumPopScale = overshootScale(style.highlightScale);

  // Greedy wrap into rows. buildCaptionLines' word cap usually keeps this to one row; this is
  // the overflow guard for long words or large sizes.
  type MeasuredWord = { word: CaptionWord; text: string; widthPx: number };
  const motionClearance = (left: MeasuredWord, right: MeasuredWord) =>
    spaceWidth +
    ((maximumPopScale - 1) * Math.max(left.widthPx, right.widthPx)) / 2;
  const rowWidth = (rowWords: MeasuredWord[]) =>
    rowWords.reduce((sum, item) => sum + item.widthPx, 0) +
    rowWords.slice(1).reduce(
      (sum, item, index) => sum + motionClearance(rowWords[index], item),
      0,
    );
  const rows: MeasuredWord[][] = [];
  let current: MeasuredWord[] = [];
  for (const word of line.words) {
    const text = display(word);
    const widthPx = measure(text, style.sizePx, style.fontFamily, style.fontWeight);
    const measured = { word, text, widthPx };
    if (current.length > 0 && rowWidth([...current, measured]) > maxRowWidth) {
      rows.push(current);
      current = [];
    }
    current.push(measured);
  }
  if (current.length > 0) rows.push(current);

  const blockHeightPx = rows.length * lineHeight;

  // Safe anchors align the maximum animated block with the common social-safe envelope.
  // Custom placement keeps the legacy positionY/anchor contract intact.
  const safe = safeAreaBounds(frame);
  const verticalPopReserve = (lineHeight * Math.max(0, maximumPopScale - 1)) / 2;
  const anchorY = (style.positionY / 100) * frame.height;
  const rawTop =
    style.safeAnchor === "top-safe"
      ? safe.top + verticalPopReserve
      : style.safeAnchor === "center"
        ? frame.height / 2 - blockHeightPx / 2
        : style.safeAnchor === "bottom-safe"
          ? safe.bottom - blockHeightPx - verticalPopReserve
          : style.anchor === "bottom"
            ? anchorY - blockHeightPx
            : anchorY - blockHeightPx / 2;
  const minTop = frame.height * MIN_BLOCK_MARGIN_RATIO;
  const maxTop = frame.height * (1 - MIN_BLOCK_MARGIN_RATIO) - blockHeightPx;
  const blockTopY = Math.round(Math.min(Math.max(rawTop, minTop), Math.max(minTop, maxTop)));

  const positionedWords: PositionedWord[] = [];
  const positionedRows: CaptionRow[] = rows.map((rowWords, rowIndex) => {
    const measuredRowWidth = rowWidth(rowWords);
    const requestedCenter = (style.positionX / 100) * frame.width;
    const leftPopReserve = ((maximumPopScale - 1) * (rowWords[0]?.widthPx ?? 0)) / 2;
    const rightPopReserve =
      ((maximumPopScale - 1) * (rowWords[rowWords.length - 1]?.widthPx ?? 0)) / 2;
    const frameMargin = frame.width * MIN_BLOCK_MARGIN_RATIO;
    const minCenter = frameMargin + measuredRowWidth / 2 + leftPopReserve;
    const maxCenter = frame.width - frameMargin - measuredRowWidth / 2 - rightPopReserve;
    const rowCenter = Math.min(Math.max(requestedCenter, minCenter), Math.max(minCenter, maxCenter));
    const rowLeft = rowCenter - measuredRowWidth / 2;
    const yTop = blockTopY + rowIndex * lineHeight;
    const yCenter = yTop + lineHeight / 2;

    let cursor = rowLeft;
    for (const [wordIndex, measured] of rowWords.entries()) {
      positionedWords.push({
        id: measured.word.id,
        text: measured.text,
        startMs: measured.word.startMs,
        endMs: measured.word.endMs,
        xCenter: Math.round(cursor + measured.widthPx / 2),
        yCenter: Math.round(yCenter),
        widthPx: Math.round(measured.widthPx),
        row: rowIndex,
      });
      cursor += measured.widthPx;
      const next = rowWords[wordIndex + 1];
      if (next) cursor += motionClearance(measured, next);
    }

    return {
      index: rowIndex,
      widthPx: Math.round(measuredRowWidth),
      xCenter: Math.round(rowCenter),
      yTop: Math.round(yTop),
      heightPx: lineHeight,
    };
  });

  return {
    words: positionedWords,
    rows: positionedRows,
    blockTopY,
    blockHeightPx,
    blockCenterX: Math.round(positionedRows[0]?.xCenter ?? frame.width / 2),
    blockCenterY: Math.round(blockTopY + blockHeightPx / 2),
  };
}
