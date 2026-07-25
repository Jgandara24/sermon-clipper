import type { CaptionStyle } from "@/lib/editor/caption-presets";
import type { CaptionLine } from "@/lib/editor/caption-lines";

/**
 * Renders one ASS (Advanced SubStation Alpha) subtitle file per clip export, burned in via
 * ffmpeg's `subtitles=` filter (libass). No per-word karaoke wipe (\k tags) at MVP — every
 * preset renders at the line level, still matching its distinct color/position/box styling.
 * See DECISIONS.md for why karaoke word-highlight timing was deferred.
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

export function generateAssSubtitles(
  lines: Array<Pick<CaptionLine, "startMs" | "endMs" | "text">>,
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
  const bold = style.bold ? -1 : 0;
  const fontName = style.fontFamily.split(",")[0].trim().replace(/^['"]|['"]$/g, "");

  // Drag-and-drop caption placement: \pos pins the block's center at the chosen frame point
  // (\an5 makes the coordinate the block center), overriding the style's alignment/margins.
  const positionOverride = style.offset
    ? `{\\an5\\pos(${Math.round(style.offset.x * videoWidth)},${Math.round(style.offset.y * videoHeight)})}`
    : "";

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${videoWidth}`,
    `PlayResY: ${videoHeight}`,
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${fontName},${style.sizePx},${primaryColor},${primaryColor},${outlineColor},${backColor},${bold},0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},${alignment},40,40,${marginV},1`,
    `Style: LowerThird,${fontName},38,${hexToAssColor(lowerThird?.accentColor ?? "#facc15")},${hexToAssColor(lowerThird?.accentColor ?? "#facc15")},${hexToAssColor(lowerThird?.primaryColor ?? "#0f766e")},${hexToAssColor(lowerThird?.primaryColor ?? "#0f766e")},1,0,0,0,100,100,0,0,3,8,1,1,70,70,400,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  const events = lines
    .map((line) => {
      const text = style.uppercase ? line.text.toUpperCase() : line.text;
      return `Dialogue: 0,${msToAssTime(line.startMs)},${msToAssTime(line.endMs)},Default,,0,0,0,,${positionOverride}${escapeAssText(text)}`;
    })
    .join("\n");
  const lowerThirdEvent = lowerThird
    ? `Dialogue: 1,${msToAssTime(lowerThird.startMs)},${msToAssTime(lowerThird.endMs)},LowerThird,,0,0,0,,${escapeAssText(`${lowerThird.headline}\\N${lowerThird.subhead}`)}`
    : "";

  return `${header}\n${events}${lowerThirdEvent ? `\n${lowerThirdEvent}` : ""}\n`;
}
