import type { CaptionWordMeasurer } from "@/lib/editor/caption-layout";
import { safeAreaAnchorY } from "@/lib/editor/social-safe-area";
import { applyTextCase } from "@/lib/editor/text-case";
import type { TitleBanner } from "@/lib/editor/title-banner";

/**
 * Where the title's box and each of its lines sit, computed once for both renderers.
 *
 * The preview and the burn-in are two different text engines, and Slice 7 spent five rounds
 * discovering how many ways they can disagree. Every number either of them needs is here: the box,
 * the wrap, the line height, where each line's centre sits, where the text is anchored. Neither
 * side measures anything the other does not.
 *
 * Pure, and holds no fonts and no DOM. The caller injects a measurer bound to the face and size it
 * is drawing, so the same rule serves fontkit on the worker and the canvas in the browser.
 */

/**
 * A line's height in pixels.
 *
 * An ASS `Fontsize` is a height, not an em: libass scales the face so its ascent plus descent
 * equals the number. So a line occupies exactly that many pixels and neither renderer has to guess
 * a leading. This is the same rule the caption measurers were corrected to on 2026-09-02.
 */
export function titleLineHeightPx(sizePx: number): number {
  return sizePx;
}

/** Room between the text and the box's edge, in proportion to the size so it scales with it. */
function paddingFor(sizePx: number): { x: number; y: number } {
  return { x: Math.round(sizePx * 0.4), y: Math.round(sizePx * 0.25) };
}

export type TitleLayout = {
  /** The box, in pixels of the output frame. */
  box: { x: number; y: number; width: number; height: number };
  /** The wrapped lines, already cased — exactly the strings both renderers draw. */
  lines: string[];
  /** The centre of each line, in frame pixels. */
  lineCentresY: number[];
  /** Where a line is anchored horizontally, which depends on the alignment. */
  textX: number;
  /** The width the text has to live in, inside the padding and any border. */
  textWidth: number;
  lineHeight: number;
  padding: { x: number; y: number };
  border: { widthPx: number; color: string };
  sizePx: number;
};

/** Greedy word wrap. A word too wide for the line keeps its own line rather than being broken. */
function wrap(text: string, maxWidth: number, measure: CaptionWordMeasurer, spaceWidth: number) {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return [""];

  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;

  for (const word of words) {
    const wordWidth = measure(word);
    if (line.length === 0) {
      line = word;
      lineWidth = wordWidth;
      continue;
    }
    const withWord = lineWidth + spaceWidth + wordWidth;
    if (withWord <= maxWidth) {
      line = `${line} ${word}`;
      lineWidth = withWord;
      continue;
    }
    lines.push(line);
    line = word;
    lineWidth = wordWidth;
  }
  lines.push(line);
  return lines;
}

export function layOutTitleBanner(params: {
  title: TitleBanner;
  videoWidth: number;
  videoHeight: number;
  measure: CaptionWordMeasurer;
  spaceWidth: number;
}): TitleLayout {
  const { title, videoWidth, videoHeight, measure, spaceWidth } = params;

  const width = Math.round(videoWidth * title.widthPct);
  const padding = paddingFor(title.sizePx);
  const lineHeight = titleLineHeightPx(title.sizePx);
  // The border eats into the box rather than growing it. Outside, a bordered title would be wider
  // than the width the member set, and resizing would not mean what it says.
  const inset = padding.x + title.border.widthPx;
  const textWidth = Math.max(1, width - inset * 2);

  const lines = wrap(applyTextCase(title.text, title.textCase), textWidth, measure, spaceWidth);
  const height =
    lines.length * lineHeight + (padding.y + title.border.widthPx) * 2;

  // Vertical placement. The anchor names a line in the shared safe area; only a dragged title
  // carries a point of its own.
  const y = (() => {
    if (title.anchor === "top-safe") return Math.round(videoHeight * safeAreaAnchorY("top-safe"));
    if (title.anchor === "bottom-safe") {
      return Math.round(videoHeight * safeAreaAnchorY("bottom-safe")) - height;
    }
    if (title.anchor === "center") return Math.round(videoHeight / 2 - height / 2);
    return Math.round(videoHeight * (title.box?.yPct ?? 0.5) - height / 2);
  })();

  const x =
    title.anchor === "custom"
      ? Math.round(videoWidth * (title.box?.xPct ?? 0.5) - width / 2)
      : Math.round((videoWidth - width) / 2);

  const textX = (() => {
    if (title.align === "left") return x + inset;
    if (title.align === "right") return x + width - inset;
    return x + width / 2;
  })();

  const firstCentre = y + padding.y + title.border.widthPx + lineHeight / 2;
  const lineCentresY = lines.map((_, index) => firstCentre + index * lineHeight);

  return {
    box: { x, y, width, height },
    lines,
    lineCentresY,
    textX,
    textWidth,
    lineHeight,
    padding,
    border: title.border,
    sizePx: title.sizePx,
  };
}
