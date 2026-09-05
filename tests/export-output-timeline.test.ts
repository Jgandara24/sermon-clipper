import { describe, expect, it } from "vitest";
import { rangeDurationMs, toOutputTimeline } from "@/lib/export/output-timeline";

describe("toOutputTimeline", () => {
  const range = { startMs: 2000, endMs: 8000 };

  it("subtracts the range's start, so the file starts at zero", () => {
    expect(toOutputTimeline(2000, range)).toBe(0);
    expect(toOutputTimeline(2500, range)).toBe(500);
  });

  it("maps the range's end to the file's length", () => {
    expect(toOutputTimeline(8000, range)).toBe(rangeDurationMs(range));
    expect(rangeDurationMs(range)).toBe(6000);
  });

  it("ends a word that runs past the range where the file ends, rather than past it", () => {
    // wordsInRange keeps a word that starts inside the range and ends outside it; its caption
    // must not be timed beyond the last frame.
    expect(toOutputTimeline(8300, range)).toBe(6000);
  });

  it("draws an instant before the range from the first frame, as the preview does", () => {
    // A title timed against a start the trim has since moved past. The preview shows it from the
    // clip's first frame; the old kept-range mapping pushed it to the end of the file instead.
    expect(toOutputTimeline(1500, range)).toBe(0);
  });
});
