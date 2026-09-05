import { describe, expect, it } from "vitest";
import { getCaptionPreset, type CaptionStyle } from "@/lib/editor/caption-presets";
import { captionMarginVPx, captionRestCentre } from "@/lib/editor/social-safe-area";
import { generateAssSubtitles, type AssCaptionLine } from "@/lib/export/ass-generator";

/**
 * Where an undragged caption rests in the preview is where the burn-in puts it.
 *
 * The burn-in anchors an edge: a bottom caption's last row sits on the bottom margin line and rows
 * grow upward, a top caption's first row sits on the top margin line and rows grow downward, and a
 * middle caption is centred. The preview used to rest the block's centre on a second set of
 * numbers (0.86, 0.1, 0.45 of the frame) and patch multi-row growth afterwards, so the two
 * disagreed by a constant per position, 96px in the middle case. Now the preview derives its
 * resting centre from the same margin the burn-in writes, and this proves the two edges coincide
 * by reading the burn-in's own output rather than repeating its arithmetic.
 */

const W = 1080;
const H = 1920;

/** Every word is 500px wide and a space is 10px, so N words wrap onto exactly N rows of 1000px. */
const WIDE_MEASURER = { measure: (text: string) => text.length * 100, spaceWidth: 10 };

function styleFor(position: CaptionStyle["position"], sizePx: number): CaptionStyle {
  return { ...getCaptionPreset("highlighter").style, position, sizePx, box: null };
}

function lineOf(rows: number): AssCaptionLine[] {
  const words = Array.from({ length: rows }, (_, index) => ({
    id: `w${index}`,
    word: "aaaaa",
    startMs: index * 400,
    endMs: index * 400 + 400,
  }));
  return [{ id: "line", startMs: 0, endMs: rows * 400, text: words.map((w) => w.word).join(" "), words }];
}

/** The distinct row anchors the burn-in positioned words at, top to bottom. */
function burnInRowAnchorsY(ass: string): number[] {
  const ys = new Set<number>();
  for (const line of ass.split("\n")) {
    if (!line.startsWith("Dialogue:") || !line.includes(",Default,")) continue;
    for (const match of line.matchAll(/\\(?:pos|move)\((-?\d+),(-?\d+)/g)) ys.add(Number(match[2]));
  }
  return [...ys].sort((a, b) => a - b);
}

describe("the preview's resting caption sits where the burn-in draws it", () => {
  const cases: Array<[CaptionStyle["position"], number, number]> = [];
  for (const position of ["bottom", "top", "middle"] as const) {
    for (const rows of [1, 2, 3]) {
      for (const sizePx of [44, 52, 64]) cases.push([position, rows, sizePx]);
    }
  }

  it.each(cases)("%s, %i row(s), %ipx: the anchored edge is the same edge", (position, rows, sizePx) => {
    const style = styleFor(position, sizePx);
    const ass = generateAssSubtitles(lineOf(rows), style, W, H, null, WIDE_MEASURER, null);
    const anchors = burnInRowAnchorsY(ass);
    expect(anchors).toHaveLength(rows);

    const rest = captionRestCentre(position, { rows, sizePx, videoHeight: H });
    const centreY = rest.yPct * H;
    const blockTop = centreY - (rows * sizePx) / 2;
    const blockBottom = centreY + (rows * sizePx) / 2;

    expect(rest.xPct).toBe(0.5);
    if (position === "bottom") {
      // \an2: the position is the bottom-centre of the last row's box.
      expect(anchors[anchors.length - 1]).toBe(Math.round(blockBottom));
    } else if (position === "top") {
      // \an8: the position is the top-centre of the first row's box.
      expect(anchors[0]).toBe(Math.round(blockTop));
    } else {
      // \an5: each row is centred on its own point, and the rows are centred on the frame.
      const mean = anchors.reduce((sum, y) => sum + y, 0) / anchors.length;
      expect(mean).toBeCloseTo(centreY, 0);
    }
  });

  it("derives the resting centre from the burn-in's own margin, not from a number of its own", () => {
    const H2 = 1000;
    const bottom = captionRestCentre("bottom", { rows: 1, sizePx: 50, videoHeight: H2 });
    expect(bottom.yPct * H2).toBe(H2 - captionMarginVPx("bottom", H2) - 25);

    const top = captionRestCentre("top", { rows: 1, sizePx: 50, videoHeight: H2 });
    expect(top.yPct * H2).toBe(captionMarginVPx("top", H2) + 25);

    const middle = captionRestCentre("middle", { rows: 3, sizePx: 50, videoHeight: H2 });
    expect(middle.yPct).toBe(0.5);
  });

  it("keeps the anchored edge fixed as rows are added, so a caption grows away from the band", () => {
    const one = captionRestCentre("bottom", { rows: 1, sizePx: 48, videoHeight: H });
    const two = captionRestCentre("bottom", { rows: 2, sizePx: 48, videoHeight: H });
    // Same bottom edge; the centre moves up by half a row.
    expect(one.yPct * H + 24).toBeCloseTo(two.yPct * H + 48, 6);

    const oneTop = captionRestCentre("top", { rows: 1, sizePx: 48, videoHeight: H });
    const twoTop = captionRestCentre("top", { rows: 2, sizePx: 48, videoHeight: H });
    expect(oneTop.yPct * H - 24).toBeCloseTo(twoTop.yPct * H - 48, 6);
  });
});
