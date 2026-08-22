// What is on screen, and when — decided once for both renderers.
//
// The preview used to pick its caption line from the line's own boundaries while the burn-in
// emitted events on the grid a subtitle timestamp can state. For a line running 3–1007ms that
// meant the file showed the caption from 0ms to 1010ms and the browser from 3ms to 1007ms, so at
// either edge one of them had a caption on screen and the other did not. Every rule that decides
// what is drawn — which line, which words, which stretch — therefore lives here, and both
// renderers read it rather than each applying its own.

import { quantisedHighlightSlices } from "./active-word";
import {
  exclusiveLineSpans,
  isRetyped,
  retypedWords,
  type CaptionLine,
  type CaptionWord,
} from "./caption-lines";

export type CaptionActivation = {
  line: CaptionLine;
  /** The words as drawn, with the retyped rule already applied. Empty when the line renders whole. */
  words: CaptionWord[];
  startMs: number;
  endMs: number;
  /** null means the caption is on screen with nothing highlighted. */
  activeWordId: string | null;
};

/**
 * Every stretch the caption is on screen for, in order and never overlapping.
 *
 * A preset that does not highlight keeps the line boundaries it always had: its timing is not this
 * slice's to change, and a clip a church approved renders as it did. A preset that highlights gets
 * mutually exclusive line spans, the retyped-text rule, and stretches quantised to the timestamp
 * grid — the three rules that have to be identical on both sides.
 */
export function captionActivations(
  lines: CaptionLine[],
  highlight: boolean,
): CaptionActivation[] {
  if (!highlight) {
    return lines.map((line) => ({
      line,
      words: [],
      startMs: line.startMs,
      endMs: line.endMs,
      activeWordId: null,
    }));
  }

  return exclusiveLineSpans(lines).flatMap((line) => {
    const words = isRetyped(line) ? retypedWords(line) : (line.words ?? []);
    // A line with nothing to highlight — never timed, or retyped to whitespace — is one stretch
    // with no active word, and it goes through the same quantisation as every other stretch.
    // Handing back its raw boundaries instead put the preview at 3–1007ms while the file, which
    // can only state centiseconds, showed 0–1010ms: the drift this module exists to remove.
    return quantisedHighlightSlices({ ...line, words }).map((slice) => ({
      line,
      words,
      startMs: slice.startMs,
      endMs: slice.endMs,
      activeWordId: slice.activeWordId,
    }));
  });
}

/** The activation covering `ms`, or null when no caption is on screen. */
export function captionActivationAt(
  lines: CaptionLine[],
  ms: number,
  highlight: boolean,
): CaptionActivation | null {
  return (
    captionActivations(lines, highlight).find((a) => ms >= a.startMs && ms < a.endMs) ?? null
  );
}
