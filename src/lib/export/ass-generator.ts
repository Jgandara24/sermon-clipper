import {
  overshootScale,
  POP_IN_ACCEL,
  POP_IN_MS,
  POP_SETTLE_ACCEL,
  POP_SETTLE_MS,
} from "@/lib/editor/caption-animation";
import { layoutCaptionLine, type TextMeasurer } from "@/lib/editor/caption-layout";
import type { CaptionLine } from "@/lib/editor/caption-lines";
import type { CaptionStyle } from "@/lib/editor/caption-presets";
import { assBoldFlag, assFontName } from "@/lib/editor/fonts";

/**
 * Renders one ASS (Advanced SubStation Alpha) subtitle file per clip export, burned in via
 * ffmpeg's `subtitles=` filter (libass).
 *
 * Kinetic captions emit ONE ABSOLUTELY-POSITIONED DIALOGUE EVENT PER WORD STATE (\an5\pos),
 * never \k karaoke tags. Two reasons, recorded in DECISIONS.md:
 *  - \k only wipes color; the product wants the CapCut-style scale pop (\fscx/\fscy via \t),
 *    which \k cannot express.
 *  - libass centers a shared event by its rendered width, so scaling one word in a shared
 *    line re-centers and shifts every other word. Words positioned at their own centers
 *    (from layoutCaptionLine, the same layout the browser preview draws) scale about
 *    themselves; nothing else can move, by construction.
 *
 * The active word is split out of its base event's time range (base-before / active /
 * base-after) rather than layered on top — double-drawing a stroked glyph leaves a visible
 * outline fringe under the scaled copy.
 */

export function hexToAssColor(hex: string): string {
  const clean = hex.replace("#", "").padEnd(6, "0").slice(0, 6);
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}

function msToAssTime(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const totalCentiseconds = Math.round(clamped / 10);
  const centiseconds = totalCentiseconds % 100;
  const totalSeconds = Math.floor(totalCentiseconds / 100);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(
    centiseconds,
  ).padStart(2, "0")}`;
}

function escapeAssText(text: string): string {
  return text.replace(/\n/g, "\\N").replace(/\{/g, "(").replace(/\}/g, ")");
}

// Events below ASS's centisecond resolution render as nothing (or start==end, which some
// renderers drop); never emit one.
const MIN_EVENT_MS = 10;

export type GenerateAssSubtitlesParams = {
  /** Lines with word timing already on the OUTPUT timeline (offset applied by the caller). */
  lines: CaptionLine[];
  style: CaptionStyle;
  videoWidth: number;
  videoHeight: number;
  /** Text measurement against the same faces libass burns with (fontkit on the worker). */
  measure: TextMeasurer;
  lowerThird?: {
    headline: string;
    subhead: string;
    primaryColor: string;
    accentColor: string;
    startMs: number;
    endMs: number;
  } | null;
};

export function generateAssSubtitles(params: GenerateAssSubtitlesParams): string {
  const { lines, style, videoWidth, videoHeight, measure, lowerThird } = params;

  const fontName = assFontName(style.fontFamily, style.fontWeight);
  const bold = assBoldFlag(style.fontFamily, style.fontWeight) ? 1 : 0;
  const primaryColor = hexToAssColor(style.textColor);
  const highlightColor = hexToAssColor(style.highlightColor);
  const outlineColor = hexToAssColor(style.outlineColor);
  // Under BorderStyle 1, libass draws the drop shadow in BackColour.
  const shadowColor = hexToAssColor(style.shadowColor);

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    // PlayRes equals the real output frame, so layout pixels are ASS pixels — no scaling
    // factor between the preview stage, this file, and the encode.
    `PlayResX: ${videoWidth}`,
    `PlayResY: ${videoHeight}`,
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Caption,${fontName},${style.sizePx},${primaryColor},${primaryColor},${outlineColor},${shadowColor},${bold},0,0,0,100,100,0,0,1,${style.outlineWidthPx},${style.shadowDistancePx},5,0,0,0,1`,
    "Style: CaptionBox,Arial,20,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1",
    `Style: LowerThird,${fontName},38,${hexToAssColor(lowerThird?.accentColor ?? "#facc15")},${hexToAssColor(lowerThird?.accentColor ?? "#facc15")},${hexToAssColor(lowerThird?.primaryColor ?? "#0f766e")},${hexToAssColor(lowerThird?.primaryColor ?? "#0f766e")},1,0,0,0,100,100,0,0,3,8,1,1,70,70,400,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  const events: string[] = [];

  for (const line of lines) {
    if (line.words.length === 0 || line.endMs - line.startMs < MIN_EVENT_MS) continue;
    const layout = layoutCaptionLine(line, style, { width: videoWidth, height: videoHeight }, measure);

    // Pill background: one \p1 rectangle per row (layer 0, under the words), from the same
    // measured geometry the words use.
    if (style.background === "pill") {
      const padX = Math.round(style.sizePx * 0.4);
      for (const row of layout.rows) {
        const w = row.widthPx + 2 * padX;
        const x0 = row.xCenter - Math.round(w / 2);
        events.push(
          `Dialogue: 0,${msToAssTime(line.startMs)},${msToAssTime(line.endMs)},CaptionBox,,0,0,0,,{\\an7\\pos(${x0},${row.yTop})\\1c&H000000&\\1a&H80&\\bord0\\shad0\\p1}m 0 0 l ${w} 0 l ${w} ${row.heightPx} l 0 ${row.heightPx}{\\p0}`,
        );
      }
    }

    const animate = style.highlightMode === "word";
    const popScale = Math.round(style.highlightScale * 100);
    const popOvershoot = Math.round(overshootScale(style.highlightScale) * 100);

    for (const word of layout.words) {
      // \q2 (no auto-wrap) + \fsp0 (no extra spacing): the event is a single word whose
      // geometry must be exactly what layoutCaptionLine measured.
      const at = `{\\an5\\pos(${word.xCenter},${word.yCenter})\\q2\\fsp0`;
      const text = escapeAssText(word.text);

      if (!animate) {
        events.push(
          `Dialogue: 0,${msToAssTime(line.startMs)},${msToAssTime(line.endMs)},Caption,,0,0,0,,${at}}${text}`,
        );
        continue;
      }

      // Clamp the active window inside the line; degenerate windows fall back to a plain event.
      const activeStart = Math.max(line.startMs, Math.min(word.startMs, line.endMs));
      const activeEnd = Math.max(activeStart, Math.min(word.endMs, line.endMs));
      if (activeEnd - activeStart < MIN_EVENT_MS) {
        events.push(
          `Dialogue: 0,${msToAssTime(line.startMs)},${msToAssTime(line.endMs)},Caption,,0,0,0,,${at}}${text}`,
        );
        continue;
      }

      if (activeStart - line.startMs >= MIN_EVENT_MS) {
        events.push(
          `Dialogue: 0,${msToAssTime(line.startMs)},${msToAssTime(activeStart)},Caption,,0,0,0,,${at}}${text}`,
        );
      }
      // Active word: highlight color + the pop (\t times are relative to THIS event's start,
      // which is why the event must begin exactly at the word's start).
      const pop =
        style.highlightScale > 1
          ? `\\t(0,${POP_IN_MS},${POP_IN_ACCEL},\\fscx${popOvershoot}\\fscy${popOvershoot})\\t(${POP_IN_MS},${POP_IN_MS + POP_SETTLE_MS},${POP_SETTLE_ACCEL},\\fscx${popScale}\\fscy${popScale})`
          : "";
      events.push(
        `Dialogue: 1,${msToAssTime(activeStart)},${msToAssTime(activeEnd)},Caption,,0,0,0,,${at}\\1c${highlightColor}${pop}}${text}`,
      );
      if (line.endMs - activeEnd >= MIN_EVENT_MS) {
        events.push(
          `Dialogue: 0,${msToAssTime(activeEnd)},${msToAssTime(line.endMs)},Caption,,0,0,0,,${at}}${text}`,
        );
      }
    }
  }

  const lowerThirdEvent = lowerThird
    ? `Dialogue: 1,${msToAssTime(lowerThird.startMs)},${msToAssTime(lowerThird.endMs)},LowerThird,,0,0,0,,${escapeAssText(`${lowerThird.headline}\\N${lowerThird.subhead}`)}`
    : "";

  return `${header}\n${events.join("\n")}${lowerThirdEvent ? `\n${lowerThirdEvent}` : ""}\n`;
}
