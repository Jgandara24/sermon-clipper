import { describe, expect, it } from "vitest";
import { buildCaptionLines, exclusiveLineSpans, type CaptionWord } from "@/lib/editor/caption-lines";
import { generateAssSubtitles } from "@/lib/export/ass-generator";
import { getCaptionPreset } from "@/lib/editor/caption-presets";

/**
 * Making caption lines mutually exclusive fixed a Highlighter defect — two lines on screen meant
 * two highlighted words — but a line's on-screen span is not Highlighter's to change. Shortening
 * every line shortens Clean's captions too, and a clip a church approved would burn in with
 * different timings than it had.
 *
 * So the exclusivity belongs to the highlighting path, and the line builder keeps producing what
 * it always produced.
 */

const LEGACY_PRESET_IDS = ["clean", "bold-serif", "karaoke", "quiet"] as const;

function words(spec: Array<[string, number, number]>): CaptionWord[] {
  return spec.map(([word, startMs, endMs], index) => ({ id: `w${index}`, word, startMs, endMs }));
}

/** Word five runs past word six's start, which is what puts two lines on screen at once. */
const OVERLAP = words([
  ["one", 0, 400],
  ["two", 400, 800],
  ["three", 800, 1200],
  ["four", 1200, 1600],
  ["five", 1600, 2600],
  ["six", 2400, 3000],
]);

const timestamps = (ass: string) =>
  ass
    .split("\n")
    .filter((l) => l.startsWith("Dialogue: 0"))
    .map((l) => {
      const parts = l.split(",");
      return `${parts[1]}-${parts[2]}`;
    });

describe("caption line timing", () => {
  it("builds lines that end at their last word, as origin/main did", () => {
    const lines = buildCaptionLines(OVERLAP);
    expect(lines).toHaveLength(2);
    // Line one ends at word five's end, not clipped back to word six's start.
    expect(lines[0].startMs).toBe(0);
    expect(lines[0].endMs).toBe(2600);
    expect(lines[1].startMs).toBe(2400);
    expect(lines[1].endMs).toBe(3000);
  });

  it("keeps those timestamps in the burn-in for every legacy preset", () => {
    for (const id of LEGACY_PRESET_IDS) {
      const ass = generateAssSubtitles(
        buildCaptionLines(OVERLAP),
        getCaptionPreset(id).style,
        1080,
        1920,
      );
      // One event per line, spanning exactly the line — which is what origin/main emitted.
      expect(timestamps(ass), `${id} changed its caption timing`).toEqual([
        "0:00:00.00-0:00:02.60",
        "0:00:02.40-0:00:03.00",
      ]);
    }
  });

  it("makes the spans mutually exclusive only where the highlight needs it", () => {
    const raw = buildCaptionLines(OVERLAP);
    const exclusive = exclusiveLineSpans(raw);
    expect(exclusive[0].endMs).toBe(2400);
    expect(exclusive[1].startMs).toBe(2400);
    // The words themselves are untouched; only the line's own span moved, and only earlier.
    expect(exclusive[0].words).toEqual(raw[0].words);
    expect(exclusive[0].startMs).toBe(raw[0].startMs);
  });

  it("shows one Highlighter line at the overlapping instant", () => {
    const exclusive = exclusiveLineSpans(buildCaptionLines(OVERLAP));
    const onScreen = exclusive.filter((l) => 2500 >= l.startMs && 2500 < l.endMs);
    expect(onScreen).toHaveLength(1);
  });

  it("never puts two Highlighter events on screen together", () => {
    const ass = generateAssSubtitles(
      buildCaptionLines(OVERLAP),
      getCaptionPreset("highlighter").style,
      1080,
      1920,
    );
    const spans = ass
      .split("\n")
      .filter((l) => l.startsWith("Dialogue: 0"))
      .map((l) => {
        const parts = l.split(",");
        return { start: parts[1], end: parts[2] };
      });
    for (let i = 1; i < spans.length; i += 1) {
      expect(spans[i].start >= spans[i - 1].end, `event ${i} overlaps event ${i - 1}`).toBe(true);
    }
  });
});
