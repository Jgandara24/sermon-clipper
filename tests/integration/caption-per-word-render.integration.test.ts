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

/** A line of five ordinary words on one row, for comparing spacing. */
const FIVE_WORDS: AssCaptionLine[] = [
  {
    id: "five",
    startMs: 0,
    endMs: 2500,
    text: "peace is not the absence",
    words: ["peace", "is", "not", "the", "absence"].map((word, index) => ({
      id: `five:${index}`,
      word,
      startMs: index * 500,
      endMs: (index + 1) * 500,
    })),
  },
];

/**
 * The widest gap that still sits inside a word, in pixels.
 *
 * Measured at Highlighter's 48px bold: gaps between letters run 2 to 7px, gaps between words 17
 * to 21px once the sizing is right. Sixteen sits between the two.
 */
const WITHIN_WORD_GAP_PX = 16;

/**
 * The columns of drawn ink in one band, grouped into words.
 *
 * Letters are separated by background too, so the raw runs count letters. Runs closer together
 * than a within-word gap are one word.
 */
async function inkWords(pngPath: string, band: [number, number]): Promise<Array<[number, number]>> {
  const { stdout } = await execFileAsync(
    "ffmpeg",
    ["-v", "error", "-i", pngPath, "-f", "rawvideo", "-pix_fmt", "gray", "-"],
    { encoding: "buffer", maxBuffer: 1 << 28 },
  );
  const raw = stdout as unknown as Buffer;
  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let x = 0; x < W; x += 1) {
    let hasInk = false;
    for (let y = band[0]; y <= band[1] && !hasInk; y += 1) {
      if (raw[y * W + x] > 90) hasInk = true;
    }
    if (hasInk && start < 0) start = x;
    if (!hasInk && start >= 0) {
      runs.push([start, x - 1]);
      start = -1;
    }
  }
  if (start >= 0) runs.push([start, W - 1]);

  const words: Array<[number, number]> = [];
  for (const run of runs) {
    const previous = words[words.length - 1];
    if (previous && run[0] - previous[1] - 1 <= WITHIN_WORD_GAP_PX) {
      previous[1] = run[1];
      continue;
    }
    words.push([...run] as [number, number]);
  }
  return words;
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

describe("per-word spacing matches what libass does with the same words", () => {
  const style = getCaptionPreset("highlighter").style;
  const ROW: [number, number] = [1600, 1700];

  it("puts the words the same distance apart as libass's own layout", async () => {
    // The bug this guards against, found by the product owner watching a render and measured
    // afterwards: an ASS font size is a height, not an em. libass scales a face so its ascent
    // plus descent equals the number, and measuring at the number itself made every advance
    // 16.4 percent too wide. Rendered, that put a gap of about 40px where libass puts 20 — the
    // line read as though the space bar had been pressed twice between every pair of words.
    //
    // Nothing about this is visible in the generated text, so it is asserted against pixels.
    const withPositions = generateAssSubtitles(FIVE_WORDS, style, W, H, null, measurerFor(style));
    const libassOwn = generateAssSubtitles(FIVE_WORDS, style, W, H, null, null);

    // At the instant an activation begins, nothing is scaled and nothing has moved.
    const ours = await renderFrame(withPositions, 0);
    const theirs = await renderFrame(libassOwn, 0);

    try {
      const oursWords = await inkWords(ours.png, ROW);
      const theirsWords = await inkWords(theirs.png, ROW);

      const gaps = (words: Array<[number, number]>) =>
        words.slice(1).map((word, index) => word[0] - words[index][1] - 1);

      const oursGaps = gaps(oursWords);
      const theirsGaps = gaps(theirsWords);
      expect(oursGaps.length).toBe(theirsGaps.length);

      // Within a few pixels: the two lay out by different code, and a whole-number position
      // rounds. What must not recur is a gap that is twice the other's.
      for (const [index, gap] of oursGaps.entries()) {
        expect(
          Math.abs(gap - theirsGaps[index]),
          `gap ${index}: ours ${gap}, libass ${theirsGaps[index]}`,
        ).toBeLessThanOrEqual(4);
      }

      // And the line as a whole is the same width, which is the reading a viewer actually gets.
      const width = (words: Array<[number, number]>) =>
        words[words.length - 1][1] - words[0][0] + 1;
      expect(Math.abs(width(oursWords) - width(theirsWords))).toBeLessThanOrEqual(6);
    } finally {
      await rm(ours.dir, { recursive: true, force: true });
      await rm(theirs.dir, { recursive: true, force: true });
    }
  }, 180_000);
});
