import {
  POP,
  popPhases,
  popPhaseTags,
  popShiftSegments,
  popResetTags,
} from "@/lib/editor/caption-animation";
import { applyTextCase } from "@/lib/editor/text-case";
import { isBoldCaptionWeight, resolveCaptionFace } from "@/lib/editor/caption-face";
import type { CaptionStyle } from "@/lib/editor/caption-presets";
import { captionActivations } from "@/lib/editor/caption-timeline";
import type { CaptionLine, CaptionWord } from "@/lib/editor/caption-lines";
import { layOutCaptionRows, type CaptionWordMeasurer } from "@/lib/editor/caption-layout";
import {
  captionMarginHPx,
  captionMarginVPx,
  captionMaxWidthPx,
} from "@/lib/editor/social-safe-area";
import type { TitleBanner } from "@/lib/editor/title-banner";
import { layOutTitleBanner, type TitleLayout } from "@/lib/editor/title-layout";

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

/**
 * Measures caption text in the face the burn-in draws with, so each word can be given its own
 * position. Without one, a line is emitted as a single run and libass lays it out, exactly as it
 * always has.
 */
export type AssCaptionMeasurer = {
  measure: CaptionWordMeasurer;
  spaceWidth: number;
};

/** A caption line to render. `words` is optional: without it the line renders unhighlighted. */
export type AssCaptionLine = Pick<CaptionLine, "startMs" | "endMs" | "text"> & {
  id?: string;
  words?: CaptionWord[];
};

/** The style name every caption event is drawn in. The lower third has its own. */
const CAPTION_STYLE_NAME = "Default";

/**
 * Counts the caption events in a generated script.
 *
 * Render QC asks whether the burn-in actually drew the captions the clip has (P1.3). A plain
 * count of "Dialogue:" would answer wrongly: the lower third is a Dialogue event too, so a clip
 * whose captions were all dropped would still look like it had one. Only events in the caption
 * style count.
 */
export function countCaptionDialogueEvents(assContent: string): number {
  let count = 0;
  for (const line of assContent.split(/\r?\n/)) {
    if (!line.startsWith("Dialogue:")) continue;
    const fields = line.slice("Dialogue:".length).split(",");
    if (fields[3]?.trim() === CAPTION_STYLE_NAME) count += 1;
  }
  return count;
}


// --- The title overlay ------------------------------------------------------------------------
//
// The title is drawn as shapes plus text rather than as a styled box, because "box dimensions" is
// a property the preview and the file have to agree on and an ASS opaque box hugs its text at a
// size neither renderer states. A drawing is stated: the rectangle in the file is the rectangle
// the layout computed, to the pixel.

/** The style line the title's events draw with: its own face, size and weight. */
function titleStyleLine(banner: TitleBanner): string {
  const face = resolveCaptionFace(banner);
  const colour = hexToAssColor(banner.color);
  return `Style: Title,${face.family},${banner.sizePx},${colour},${colour},${colour},${colour},${face.bold ? -1 : 0},0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`;
}

/**
 * The form a colour takes in an override tag, which is not the form a style line takes.
 *
 * A style line carries alpha in the same field (`&H00BBGGRR`). An override does not: `\1c` sets
 * the colour and `\1a` the alpha, and running them together makes libass read the pair wrong.
 */
function assColourTag(hex: string): string {
  const clean = hex.replace("#", "").padEnd(6, "0").slice(0, 6);
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  return `&H${b}${g}${r}&`.toUpperCase();
}

/** An `\p1` drawing of a filled rectangle, running from the event's own position. */
function rectangleDrawing(width: number, height: number): string {
  return `m 0 0 l ${width} 0 ${width} ${height} 0 ${height}`;
}

/** The `\an` a line of title text is anchored by, which is what alignment means in the file. */
function titleAlignmentTag(align: TitleBanner["align"]): string {
  if (align === "left") return "\\an4";
  if (align === "right") return "\\an6";
  return "\\an5";
}

/**
 * Every event the title needs: the border shape, the background shape, then one event per line.
 *
 * Layers put the shapes under the text. The border is the full box and the background is inset by
 * the border's width on every side, so a border is drawn *inside* the width the member set rather
 * than growing the box past it.
 */
function titleDialogueLines(banner: TitleBanner, layout: TitleLayout): string[] {
  const from = msToAssTime(banner.startMs);
  const to = msToAssTime(banner.endMs);
  const shadow = banner.shadow ? 4 : 0;
  const lines: string[] = [];

  const shape = (
    layer: number,
    x: number,
    y: number,
    width: number,
    height: number,
    colour: string,
  ) =>
    `Dialogue: ${layer},${from},${to},Title,,0,0,0,,{\\an7\\pos(${x},${y})\\bord0\\shad${shadow}\\1c${assColourTag(colour)}\\p1}${rectangleDrawing(width, height)}{\\p0}`;

  const border = layout.border.widthPx;
  if (border > 0) {
    lines.push(shape(1, layout.box.x, layout.box.y, layout.box.width, layout.box.height, layout.border.color));
    lines.push(
      shape(
        2,
        layout.box.x + border,
        layout.box.y + border,
        layout.box.width - border * 2,
        layout.box.height - border * 2,
        banner.backgroundColor,
      ),
    );
  } else {
    lines.push(shape(1, layout.box.x, layout.box.y, layout.box.width, layout.box.height, banner.backgroundColor));
  }

  const align = titleAlignmentTag(banner.align);
  for (const [index, text] of layout.lines.entries()) {
    lines.push(
      `Dialogue: 3,${from},${to},Title,,0,0,0,,{${align}\\pos(${Math.round(layout.textX)},${Math.round(layout.lineCentresY[index])})\\bord0\\shad0\\1c${assColourTag(banner.color)}}${escapeAssText(text)}`,
    );
  }

  return lines;
}

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
  measurer?: AssCaptionMeasurer | null,
  /**
   * The title overlay and the measurer for its own face and size. Both or neither: a title cannot
   * be laid out without measuring it, and drawing one from guessed widths is how a box comes out
   * too small for the text inside it.
   */
  title?: { banner: TitleBanner; measurer: AssCaptionMeasurer } | null,
): string {
  const alignment = resolveAlignment(style.position, style.alignment);
  const marginV = captionMarginVPx(style.position, videoHeight);
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
    `Style: Default,${fontName},${style.sizePx},${primaryColor},${primaryColor},${outlineColor},${backColor},${isBoldCaptionWeight(style.weight) ? -1 : 0},0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},${alignment},${captionMarginHPx()},${captionMarginHPx()},${marginV},1`,
    ...(title ? [titleStyleLine(title.banner)] : []),
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

  // Per-word positioning applies where it can be done honestly: a preset that highlights, drawn in
  // a face this repository ships and can therefore measure. Everything else keeps the single run it
  // has always emitted and lets libass lay it out, so Clean and every retired preset are untouched.
  const perWord = Boolean(measurer) && style.activeWordHighlight;

  /**
   * Where a row sits, and which point of it the position refers to.
   *
   * Both rules are expressed through libass's own alignment rather than reconstructed arithmetic:
   * an anchored caption states the same margin line the style already states, and a dragged one
   * states its point. That is what makes the placement match what ships today (2026-09-02
   * decision).
   */
  function rowPlacement(rowIndex: number, rowCount: number): { tag: string; x: number; y: number } {
    const pitch = style.sizePx;
    if (style.box) {
      // Dragged: the block centres on the point, so rows spread either side of it.
      const centre = style.box.yPct * videoHeight;
      return {
        tag: "\\an5",
        x: style.box.xPct * videoWidth,
        y: Math.round(centre + (rowIndex - (rowCount - 1) / 2) * pitch),
      };
    }
    if (style.position === "top") {
      // Anchored at the top: the first row sits on the margin line and rows grow downward.
      return { tag: "\\an8", x: videoWidth / 2, y: Math.round(marginV + rowIndex * pitch) };
    }
    if (style.position === "middle") {
      return {
        tag: "\\an5",
        x: videoWidth / 2,
        y: Math.round(videoHeight / 2 + (rowIndex - (rowCount - 1) / 2) * pitch),
      };
    }
    // Anchored at the bottom: the last row sits on the margin line and rows grow upward, which is
    // what the frame's bottom band being the platform's own makes necessary.
    return {
      tag: "\\an2",
      x: videoWidth / 2,
      y: Math.round(videoHeight - marginV - (rowCount - 1 - rowIndex) * pitch),
    };
  }

  function perWordEvents(activation: {
    words: CaptionWord[];
    startMs: number;
    endMs: number;
    activeWordId: string | null;
  }): string[] {
    const layout = layOutCaptionRows({
      words: activation.words.map((word) => ({
        id: word.id,
        text: applyTextCase(word.word, style.textCase),
      })),
      measure: measurer!.measure,
      spaceWidth: measurer!.spaceWidth,
      activeWordId: activation.activeWordId,
      peakScale: POP.peakScale,
      maxWidth: captionMaxWidthPx(videoWidth),
    });

    const activeDurationMs = activation.endMs - activation.startMs;
    const phases = activation.activeWordId === null ? [] : popPhases(activeDurationMs);
    // A neighbour is subdivided further than the pop is. `\move` carries no acceleration, so one
    // straight line per phase changed a neighbour's speed three or four times across a pop and sat
    // a quarter of its clearance from the curve mid-rise. The pop's own events are untouched.
    const segments = activation.activeWordId === null ? [] : popShiftSegments(activeDurationMs);

    return layout.rows.flatMap((row, rowIndex) => {
      const place = rowPlacement(rowIndex, layout.rows.length);
      return row.words.flatMap((word) => {
        const restX = Math.round(place.x + word.restX);
        const at = `{${place.tag}\\pos(${restX},${place.y})}`;
        const text = escapeAssText(word.text);

        // The active word never moves. It grows about its own centre, which is the property the
        // whole per-word arrangement exists to keep: nothing it does can drag anything with it.
        if (word.id === activation.activeWordId && phases.length > 0) {
          // libass gives no agreed meaning to two transforms over one property, so each event
          // carries exactly one and states the value it starts from.
          return phases.map(
            (phase) =>
              `Dialogue: 0,${msToAssTime(activation.startMs + phase.startMs)},${msToAssTime(activation.startMs + phase.endMs)},Default,,0,0,0,,${at}{${popPhaseTags(phase)}}${highlightTag}${text}`,
          );
        }

        const shiftPx = word.shiftedX - word.restX;
        // A word with nowhere to go — no active word on this line, or on another row entirely —
        // is one event at rest. Splitting it into segments would multiply the file for no motion.
        if (shiftPx === 0 || segments.length === 0) {
          return [
            `Dialogue: 0,${msToAssTime(activation.startMs)},${msToAssTime(activation.endMs)},Default,,0,0,0,,${at}${text}`,
          ];
        }

        // A neighbour moves aside and back. `\t` cannot animate a position, and `\move` is one
        // straight motion per event with no acceleration, so the motion is split into short pieces
        // that each track the shared curve, and is straight within each. The preview interpolates
        // over the same pieces; both are exact at every boundary.
        return segments.map((segment) => {
          const from = Math.round(place.x + word.restX + shiftPx * segment.from);
          const to = Math.round(place.x + word.restX + shiftPx * segment.to);
          const span = Math.max(1, Math.round(segment.endMs - segment.startMs));
          const motion =
            from === to
              ? `{${place.tag}\\pos(${from},${place.y})}`
              : `{${place.tag}\\move(${from},${place.y},${to},${place.y},0,${span})}`;
          return `Dialogue: 0,${msToAssTime(activation.startMs + segment.startMs)},${msToAssTime(activation.startMs + segment.endMs)},Default,,0,0,0,,${motion}${text}`;
        });
      });
    });
  }

  // One decision about what is on screen, shared with the preview: which line, which words, and
  // which stretch. Applying these rules twice is what let the file show a caption the browser did
  // not, three milliseconds either side of a line.
  const events = captionActivations(lines as CaptionLine[], style.activeWordHighlight)
    .flatMap((activation) => {
      // A line with no words to place has nothing to position per word; it renders whole either
      // way, so it keeps the path it always used.
      if (perWord && activation.words.length > 0) {
        return perWordEvents(activation);
      }

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
  const titleEvents = title
    ? titleDialogueLines(
        title.banner,
        layOutTitleBanner({
          title: title.banner,
          videoWidth,
          videoHeight,
          ...title.measurer,
        }),
      )
    : [];

  const lowerThirdEvent = lowerThird
    ? `Dialogue: 1,${msToAssTime(lowerThird.startMs)},${msToAssTime(lowerThird.endMs)},LowerThird,,0,0,0,,${escapeAssText(`${lowerThird.headline}\\N${lowerThird.subhead}`)}`
    : "";

  return `${header}\n${events}${titleEvents.length > 0 ? `\n${titleEvents.join("\n")}` : ""}${lowerThirdEvent ? `\n${lowerThirdEvent}` : ""}\n`;
}
