import { popPhases, popPhaseTags, popResetTags } from "@/lib/editor/caption-animation";
import { applyTextCase } from "@/lib/editor/text-case";
import { isBoldCaptionWeight, resolveCaptionFace } from "@/lib/editor/caption-face";
import type { CaptionStyle } from "@/lib/editor/caption-presets";
import { captionActivations } from "@/lib/editor/caption-timeline";
import type { CaptionLine, CaptionWord } from "@/lib/editor/caption-lines";

/**
 * Renders one ASS (Advanced SubStation Alpha) subtitle file per clip export, burned in via
 * ffmpeg's `subtitles=` filter (libass).
 *
 * A line that carries its words is cut into one subtitle event per phase of the highlight, with
 * the active word coloured and scaled. The stretches come from the same resolver the preview
 * calls, and the phases from the same curve it evaluates, so the word lit on screen and the word
 * lit in the file are the same word at the same size at every instant.
 *
 * A line the member has retyped no longer spells out its words, so its highlight is timed by the
 * shared rule in `caption-lines.ts` rather than by matching — it is highlighted, not left dead.
 * A line carrying no words at all has nothing to align a highlight to and renders whole, as does
 * every preset that does not highlight.
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
  // The same resolver the preview measures with, so both renderers name one face.
  const fontName = resolveCaptionFace(style).family;

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${videoWidth}`,
    `PlayResY: ${videoHeight}`,
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${fontName},${style.sizePx},${primaryColor},${primaryColor},${outlineColor},${backColor},${isBoldCaptionWeight(style.weight) ? -1 : 0},0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},${alignment},40,40,${marginV},1`,
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

  // One decision about what is on screen, shared with the preview: which line, which words, and
  // which stretch. Applying these rules twice is what let the file show a caption the browser did
  // not, three milliseconds either side of a line.
  const events = captionActivations(lines as CaptionLine[], style.activeWordHighlight)
    .flatMap((activation) => {
      const runFor = (activeTags: string | null) =>
        activation.words.length === 0
          ? escapeAssText(applyTextCase(activation.line.text, style.textCase))
          : activation.words
              .map((word) => {
                const cased = escapeAssText(applyTextCase(word.word, style.textCase));
                if (word.id !== activation.activeWordId || activeTags === null) return cased;
                // Scale and colour together, then back to rest, so the words after this one are
                // neither popped nor coloured. Nothing here moves a neighbour — that is Slice 8.
                return `{${activeTags}}${highlightTag}${cased}${restoreTag}{${popResetTags()}}`;
              })
              .join(" ");

      if (activation.activeWordId === null) {
        return [dialogue(activation.startMs, activation.endMs, runFor(null))];
      }

      // One event per phase of the pop. libass gives no agreed meaning to two `\t` over the same
      // property, so each event carries exactly one, starting from a value it states.
      const phases = popPhases(activation.endMs - activation.startMs);
      if (phases.length === 0) {
        return [dialogue(activation.startMs, activation.endMs, runFor(null))];
      }

      return phases.map((phase) =>
        dialogue(
          activation.startMs + phase.startMs,
          activation.startMs + phase.endMs,
          runFor(popPhaseTags(phase)),
        ),
      );
    })
    .join("\n");
  const lowerThirdEvent = lowerThird
    ? `Dialogue: 1,${msToAssTime(lowerThird.startMs)},${msToAssTime(lowerThird.endMs)},LowerThird,,0,0,0,,${escapeAssText(`${lowerThird.headline}\\N${lowerThird.subhead}`)}`
    : "";

  return `${header}\n${events}${lowerThirdEvent ? `\n${lowerThirdEvent}` : ""}\n`;
}
