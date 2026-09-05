import { parseLowerThird } from "@/lib/brand-template";
import { applyCaptionTextOverrides, buildCaptionLines } from "@/lib/editor/caption-lines";
import { resolveCaptionFace } from "@/lib/editor/caption-face";
import { resolveCaptionStyle } from "@/lib/editor/caption-style";
import { readTitleBanner, retimeTitleBanner, type TitleBanner } from "@/lib/editor/title-banner";
import { applyWordTextOverrides } from "@/lib/editor/transcript";
import type { EditorState } from "@/lib/editor/types";
import { flattenWords, wordsInRange } from "@/lib/editor/words";
import { generateAssSubtitles, type AssCaptionMeasurer } from "@/lib/export/ass-generator";
import { cropRectToPixels, resolveCropRect } from "@/lib/export/crop";
import { createCaptionMeasurer, UnbundledCaptionFaceError } from "@/lib/export/font-metrics";
import {
  rangeDurationMs,
  toOutputTimeline,
  type TimeRange,
} from "@/lib/export/output-timeline";
import { assertContinuousRange } from "./continuous-range";

/**
 * Everything a render is derived from, and nothing that has to be fetched.
 *
 * The derivation used to live inside `runExportJob`, in between a storage download and an ffmpeg
 * run, so the only way to ask "does the file match the document?" was to render one and look at
 * the pixels. Slice 13 needs to ask it directly: the parity gate drives this function with the
 * same document the preview holds and compares what it produced against what the preview shows.
 *
 * It is pure. Given a document it returns the range, the crop, and the subtitle script — the
 * three things the renderer consumes — and it refuses, with the continuity gate's own failure, a
 * document that still cuts words out of the middle of the clip. The handler asks that question
 * first, before it downloads anything; asking it here as well means the plan can never describe
 * a render the gate would not allow, whoever calls it.
 */

/** The transcript, in the shape the editor's word helpers read. */
export type ExportRenderSegment = {
  id: string;
  startMs: number;
  endMs: number;
  words: Array<{
    word: string;
    startMs: number;
    endMs: number;
    confidence: number;
    isFiller: boolean;
    deleted: boolean;
  }>;
};

/** The brand template's fields, already loaded. Null when the document names none. */
export type ExportRenderBrandTemplate = {
  churchName: string;
  speakerName: string | null;
  primaryColor: string;
  accentColor: string;
  lowerThird: unknown;
};

export type ExportRenderPlanInput = {
  state: EditorState;
  segments: ExportRenderSegment[];
  sourceWidth: number;
  sourceHeight: number;
  outputWidth: number;
  outputHeight: number;
  brandTemplate: ExportRenderBrandTemplate | null;
};

export type ExportRenderPlan = {
  /** The one span of the source the file contains: the clip's own range, on the source timeline. */
  range: TimeRange;
  cropPixels: { x: number; y: number; w: number; h: number };
  /** The subtitle script the burn-in draws: captions, the title, and nothing else. */
  assContent: string;
  /** Caption lines on the output timeline. Render QC counts them. */
  captionLineCount: number;
  /** How long the rendered file should be, in seconds: the range's length. */
  outputDurationS: number;
  /** The gain the export applies after loudness normalisation, and the preview applies to the
   * video element. One number, read once, so the two cannot drift. */
  originalVolume: number;
};

export function buildExportRenderPlan(input: ExportRenderPlanInput): ExportRenderPlan {
  const { state, segments, outputWidth, outputHeight } = input;

  // A deliverable is one unbroken span of the source. A document that would render as anything
  // else is refused here with the gate's own code, so nothing below has to reason about cuts.
  assertContinuousRange(state, segments);
  const range: TimeRange = { startMs: state.source.startMs, endMs: state.source.endMs };

  // Corrections are applied here too, so the caption the member approved in the preview is the
  // caption the rendered file burns in.
  const wordsInClip = applyWordTextOverrides(
    wordsInRange(flattenWords(segments), range.startMs, range.endMs),
    state,
  );

  const cropRect = resolveCropRect(state.layout, input.sourceWidth, input.sourceHeight);
  const cropPixels = cropRectToPixels(cropRect, input.sourceWidth, input.sourceHeight);

  const captionLines = applyCaptionTextOverrides(
    buildCaptionLines(
      wordsInClip.map((word) => ({
        id: word.id,
        word: word.word,
        startMs: word.startMs,
        endMs: word.endMs,
      })),
    ),
    state.captions.textOverrides,
  ).map((line) => ({
    ...line,
    // The words travel with the line so the burn-in can light the same word the preview does,
    // moved onto the file's clock by the same function as the line itself — a word left on the
    // source timeline would highlight at the wrong moment.
    words: line.words.map((word) => ({
      ...word,
      startMs: toOutputTimeline(word.startMs, range),
      endMs: toOutputTimeline(word.endMs, range),
    })),
    // Caption timestamps are on the source timeline; the rendered file starts at zero.
    startMs: toOutputTimeline(line.startMs, range),
    endMs: toOutputTimeline(line.endMs, range),
  }));

  const style = resolveCaptionStyle(state.captions.presetId, state.captions.overrides);

  // Per-word positioning needs the same file libass will draw with. A preset whose face this
  // repository does not ship keeps the single run it has always emitted — measuring a face we do
  // not have would be a guess, and libass would silently substitute another one anyway.
  let captionMeasurer: AssCaptionMeasurer | null = null;
  if (style.activeWordHighlight) {
    const face = resolveCaptionFace(style);
    try {
      const measurer = createCaptionMeasurer({
        family: face.family,
        bold: face.bold,
        sizePx: style.sizePx,
      });
      captionMeasurer = { measure: measurer.measure, spaceWidth: measurer.spaceWidth };
    } catch (error) {
      if (!(error instanceof UnbundledCaptionFaceError)) throw error;
    }
  }
  // The title, if this clip carries one. Its times are on the source timeline like every other
  // time in the document, so they move onto the file's clock the same way the captions do — a
  // title left on the source timeline would appear late by the length of the trimmed-off start.
  const storedTitle = readTitleBanner(state.overlays);
  let title: { banner: TitleBanner; measurer: AssCaptionMeasurer } | null = null;
  if (storedTitle) {
    const face = resolveCaptionFace(storedTitle);
    try {
      const measurer = createCaptionMeasurer({
        family: face.family,
        bold: face.bold,
        sizePx: storedTitle.sizePx,
      });
      title = {
        banner: retimeTitleBanner(storedTitle, (ms) => toOutputTimeline(ms, range)),
        measurer: { measure: measurer.measure, spaceWidth: measurer.spaceWidth },
      };
    } catch (error) {
      // A face this repository does not ship cannot be measured, and drawing the box from guessed
      // widths would put text outside it. The bundled-font gate exists so this cannot happen in
      // the worker image; if it somehow does, the clip renders without the title rather than with
      // a broken one.
      if (!(error instanceof UnbundledCaptionFaceError)) throw error;
    }
  }

  const brandTemplate = input.brandTemplate;
  const lowerThird = brandTemplate ? parseLowerThird(brandTemplate.lowerThird) : null;
  const assContent = generateAssSubtitles(
    captionLines,
    style,
    outputWidth,
    outputHeight,
    brandTemplate && lowerThird
      ? {
          headline: lowerThird.headline || brandTemplate.churchName,
          subhead: lowerThird.subhead || brandTemplate.speakerName || "",
          primaryColor: brandTemplate.primaryColor,
          accentColor: brandTemplate.accentColor,
          startMs: 0,
          endMs: Math.min(4000, Math.max(1000, rangeDurationMs(range))),
        }
      : null,
    captionMeasurer,
    title,
  );
  return {
    range,
    cropPixels,
    assContent,
    captionLineCount: captionLines.length,
    outputDurationS: rangeDurationMs(range) / 1_000,
    originalVolume: state.audio.originalVolume,
  };
}
