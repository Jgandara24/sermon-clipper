import { highlightSlices } from "@/lib/editor/active-word";
import { applyTextCase } from "@/lib/editor/text-case";
import type { CaptionStyle } from "@/lib/editor/caption-presets";
import type { CaptionLine, CaptionWord } from "@/lib/editor/caption-lines";

/**
 * Renders one ASS (Advanced SubStation Alpha) subtitle file per clip export, burned in via
 * ffmpeg's `subtitles=` filter (libass).
 *
 * A line that carries its words is cut into one subtitle event per highlight stretch, with the
 * active word coloured. The stretches come from the same resolver the preview calls, so the word
 * lit on screen and the word lit in the file are the same word at every instant. A line without
 * words, or one the member has retyped, renders as a single event with nothing highlighted —
 * there is no word list to align a highlight to.
 */

function hexToAssColor(hex: string): string {
  const clean = hex.replace("#", "").padEnd(6, "0").slice(0, 6);
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}

function resolveAlignment(position: CaptionStyle["position"], alignment: CaptionStyle["alignment"]): number {
  const row = position === "top" ? 6 : position === "middle" ? 3 : 0;
  const col = alignment === "left" ? 1 : alignment === "right" ? 3 : 2;
  return row + col;
}

function marginVForPosition(position: CaptionStyle["position"], videoHeight: number): number {
  if (position === "top") return Math.round(videoHeight * 0.08);
  if (position === "middle") return 0;
  return Math.round(videoHeight * 0.12);
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

/** A caption line to render. `words` is optional: without it the line renders unhighlighted. */
export type AssCaptionLine = Pick<CaptionLine, "startMs" | "endMs" | "text"> & {
  id?: string;
  words?: CaptionWord[];
};

export function generateAssSubtitles(
  lines: AssCaptionLine[],
  style: CaptionStyle,
  videoWidth: number,
  videoHeight: number,
  lowerThird?: {
    headline: string;
    subhead: string;
    primaryColor: string;
    accentColor: string;
    startMs: number;
    endMs: number;
  } | null,
): string {
  const alignment = resolveAlignment(style.position, style.alignment);
  const marginV = marginVForPosition(style.position, videoHeight);
  const borderStyle = style.background === "pill" ? 3 : 1;
  const primaryColor = hexToAssColor(style.textColor);
  const outlineColor = hexToAssColor(style.strokeColor);
  const backColor = style.background === "pill" ? "&H80000000" : "&H00000000";
  const outline = style.background === "pill" ? Math.max(style.strokePx, 6) : style.strokePx;
  const shadow = style.shadow ? 2 : 0;
  const fontName = style.fontFamily.split(",")[0].trim().replace(/^['"]|['"]$/g, "");

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${videoWidth}`,
    `PlayResY: ${videoHeight}`,
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${fontName},${style.sizePx},${primaryColor},${primaryColor},${outlineColor},${backColor},${style.weight >= 600 ? -1 : 0},0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},${alignment},40,40,${marginV},1`,
    `Style: LowerThird,${fontName},38,${hexToAssColor(lowerThird?.accentColor ?? "#facc15")},${hexToAssColor(lowerThird?.accentColor ?? "#facc15")},${hexToAssColor(lowerThird?.primaryColor ?? "#0f766e")},${hexToAssColor(lowerThird?.primaryColor ?? "#0f766e")},1,0,0,0,100,100,0,0,3,8,1,1,70,70,400,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  // A caption the member dragged is drawn at that exact point, centred on itself. Without a
  // dragged position nothing is emitted, so every clip made before direct manipulation renders
  // byte-identically to how it always did.
  const positionTag = style.box
    ? `{\\an5\\pos(${Math.round(style.box.xPct * videoWidth)},${Math.round(style.box.yPct * videoHeight)})}`
    : "";

  const highlightTag = `{\\c${hexToAssColor(style.highlightColor)}}`;
  const restoreTag = `{\\c${primaryColor}}`;

  function dialogue(startMs: number, endMs: number, body: string): string {
    return `Dialogue: 0,${msToAssTime(startMs)},${msToAssTime(endMs)},Default,,0,0,0,,${positionTag}${body}`;
  }

  const events = lines
    .flatMap((line) => {
      const words = line.words ?? [];
      // A retyped line no longer corresponds to its words, so there is nothing to align a
      // highlight to. It renders whole, exactly as it reads.
      const retyped = words.map((word) => word.word).join(" ") !== line.text;
      if (words.length === 0 || retyped) {
        return [dialogue(line.startMs, line.endMs, escapeAssText(applyTextCase(line.text, style.textCase)))];
      }

      return highlightSlices({
        id: line.id ?? "line",
        startMs: line.startMs,
        endMs: line.endMs,
        words,
        text: line.text,
      }).map((slice) =>
        dialogue(
          slice.startMs,
          slice.endMs,
          words
            .map((word) => {
              const cased = escapeAssText(applyTextCase(word.word, style.textCase));
              return word.id === slice.activeWordId
                ? `${highlightTag}${cased}${restoreTag}`
                : cased;
            })
            .join(" "),
        ),
      );
    })
    .join("\n");
  const lowerThirdEvent = lowerThird
    ? `Dialogue: 1,${msToAssTime(lowerThird.startMs)},${msToAssTime(lowerThird.endMs)},LowerThird,,0,0,0,,${escapeAssText(`${lowerThird.headline}\\N${lowerThird.subhead}`)}`
    : "";

  return `${header}\n${events}${lowerThirdEvent ? `\n${lowerThirdEvent}` : ""}\n`;
}
