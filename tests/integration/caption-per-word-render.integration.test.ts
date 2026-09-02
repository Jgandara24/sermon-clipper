import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { resolveCaptionFace } from "@/lib/editor/caption-face";
import { getCaptionPreset, type CaptionStyle } from "@/lib/editor/caption-presets";
import { generateAssSubtitles, type AssCaptionLine } from "@/lib/export/ass-generator";
import { createCaptionMeasurer } from "@/lib/export/font-metrics";

const execFileAsync = promisify(execFile);

/**
 * The acceptance gate for per-word positioning, promised by the 2026-09-02 decision.
 *
 * Reading the generated text proves the numbers are what we meant to write. It cannot prove they
 * put ink where libass used to put it, and that is the whole risk: a wrap point or an anchor that
 * disagrees moves a caption on a clip a church already approved. So this renders both versions
 * with real ffmpeg and compares the pixels.
 */

const W = 1080;
const H = 1920;
const FONTS_DIR = path.join(process.cwd(), "public", "fonts");

/** A line of long words: 1242px against 1000px of usable frame, so it has to wrap. */
const OVERFLOWING: AssCaptionLine[] = [
  {
    id: "wide",
    startMs: 0,
    endMs: 2400,
    text: "everlasting righteousness throughout",
    words: [
      { id: "wide:0", word: "everlasting", startMs: 0, endMs: 800 },
      { id: "wide:1", word: "righteousness", startMs: 800, endMs: 1600 },
      { id: "wide:2", word: "throughout", startMs: 1600, endMs: 2400 },
    ],
  },
];

function measurerFor(style: CaptionStyle) {
  const face = resolveCaptionFace(style);
  const m = createCaptionMeasurer({ family: face.family, bold: face.bold, sizePx: style.sizePx });
  return { measure: m.measure, spaceWidth: m.spaceWidth };
}

type Ink = { top: number; bottom: number; left: number; right: number };

/** The bounding box of everything drawn, optionally inside one horizontal band. */
async function inkOf(pngPath: string, band?: [number, number]): Promise<Ink> {
  const { stdout } = await execFileAsync(
    "ffmpeg",
    ["-v", "error", "-i", pngPath, "-f", "rawvideo", "-pix_fmt", "gray", "-"],
    { encoding: "buffer", maxBuffer: 1 << 28 },
  );
  const raw = stdout as unknown as Buffer;
  const y0 = band ? band[0] : 0;
  const y1 = band ? band[1] : H - 1;
  let top = -1;
  let bottom = -1;
  let left = W;
  let right = -1;
  for (let y = y0; y <= y1; y += 1) {
    let rowHas = false;
    for (let x = 0; x < W; x += 1) {
      // The background is 0x18; anything well above it is drawn text.
      if (raw[y * W + x] > 90) {
        rowHas = true;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
    if (rowHas) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  return { top, bottom, left, right };
}

async function renderFrame(ass: string, atSeconds: number): Promise<{ png: string; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "caption-render-"));
  const assPath = path.join(dir, "captions.ass");
  const png = path.join(dir, "frame.png");
  await writeFile(assPath, ass, "utf8");
  await execFileAsync("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `color=c=0x181818:s=${W}x${H}:d=3,format=yuv420p`,
    "-vf", `subtitles=filename='${assPath}':fontsdir='${FONTS_DIR}'`,
    "-ss", String(atSeconds), "-frames:v", "1", png,
  ]);
  return { png, dir };
}

/** Renders the same caption twice: as it ships today, and with each word positioned. */
async function renderBoth(style: CaptionStyle, lines: AssCaptionLine[], atSeconds: number) {
  const today = await renderFrame(generateAssSubtitles(lines, style, W, H, null, null), atSeconds);
  const perWord = await renderFrame(
    generateAssSubtitles(lines, style, W, H, null, measurerFor(style)),
    atSeconds,
  );
  return { today, perWord };
}

describe("per-word positioning puts ink where libass used to put it", () => {
  it("keeps an undragged caption's rows in exactly the same place", async () => {
    const style = getCaptionPreset("highlighter").style;
    const { today, perWord } = await renderBoth(style, OVERFLOWING, 1.1);

    try {
      const before = await inkOf(today.png);
      const after = await inkOf(perWord.png);

      // Both wrap to two rows, and the block is anchored at the bottom in both.
      expect(after.top).toBe(before.top);
      expect(after.bottom).toBe(before.bottom);
      // The row pitch follows from the two rows occupying the same band.
      expect(before.bottom - before.top).toBe(after.bottom - after.top);
    } finally {
      await rm(today.dir, { recursive: true, force: true });
      await rm(perWord.dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("lays an unscaled row out identically to libass, to the pixel", async () => {
    // The row without the active word on it has nothing scaled, so this compares layout alone.
    // If our advance widths or space width were wrong, this is where it would show.
    const style = getCaptionPreset("highlighter").style;
    const { today, perWord } = await renderBoth(style, OVERFLOWING, 1.1);
    const secondRow: [number, number] = [1640, 1690];

    try {
      const before = await inkOf(today.png, secondRow);
      const after = await inkOf(perWord.png, secondRow);

      expect(after.left).toBe(before.left);
      expect(after.right).toBe(before.right);
    } finally {
      await rm(today.dir, { recursive: true, force: true });
      await rm(perWord.dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("keeps a dragged caption centred on its point", async () => {
    const style: CaptionStyle = {
      ...getCaptionPreset("highlighter").style,
      box: { xPct: 0.5, yPct: 0.42 },
    };
    const { today, perWord } = await renderBoth(style, OVERFLOWING, 1.1);

    try {
      const before = await inkOf(today.png);
      const after = await inkOf(perWord.png);
      const centre = (ink: Ink) => (ink.top + ink.bottom) / 2;

      // Within a pixel: each row's own position is rounded to a whole number.
      expect(Math.abs(centre(after) - centre(before))).toBeLessThanOrEqual(1);
    } finally {
      await rm(today.dir, { recursive: true, force: true });
      await rm(perWord.dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("keeps every word inside the frame on a line that would otherwise be clipped", async () => {
    // Without a wrapping rule this same line ran from x -81 to x 1161.
    const style = getCaptionPreset("highlighter").style;
    const { perWord } = await renderBoth(style, OVERFLOWING, 1.1);

    try {
      const ink = await inkOf(perWord.png);
      expect(ink.left).toBeGreaterThan(0);
      expect(ink.right).toBeLessThan(W - 1);
    } finally {
      await rm(perWord.dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("leaves a preset that does not highlight completely untouched", async () => {
    // Clean is handed a measurer it cannot use, and must render the bytes it always did.
    const style = getCaptionPreset("clean").style;
    const withMeasurer = generateAssSubtitles(OVERFLOWING, style, W, H, null, {
      measure: () => 100,
      spaceWidth: 10,
    });
    const without = generateAssSubtitles(OVERFLOWING, style, W, H, null, null);

    expect(withMeasurer).toBe(without);
  });
});
