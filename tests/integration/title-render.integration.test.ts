import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { getCaptionPreset } from "@/lib/editor/caption-presets";
import { resolveCaptionFace } from "@/lib/editor/caption-face";
import { createCaptionMeasurer } from "@/lib/export/font-metrics";
import { generateAssSubtitles } from "@/lib/export/ass-generator";
import { defaultTitleBanner, type TitleBanner } from "@/lib/editor/title-banner";
import { layOutTitleBanner } from "@/lib/editor/title-layout";

const execFileAsync = promisify(execFile);
const W = 1080;
const H = 1920;
const FONTS_DIR = path.join(process.cwd(), "public", "fonts");
const style = getCaptionPreset("highlighter").style;

/**
 * The title, rendered.
 *
 * Reading the generated text proves the numbers are what we meant to write. It cannot prove libass
 * draws a box there, at that size, in that colour — and "the preview shows it and the export does
 * not" is the defect this whole plan exists to prevent. So this burns it in and reads the pixels.
 */

function measurerFor(banner: TitleBanner) {
  const face = resolveCaptionFace(banner);
  const m = createCaptionMeasurer({ family: face.family, bold: face.bold, sizePx: banner.sizePx });
  return { measure: m.measure, spaceWidth: m.spaceWidth };
}

function banner(overrides: Partial<TitleBanner> = {}): TitleBanner {
  return {
    ...defaultTitleBanner({ startMs: 0, endMs: 9000 }),
    text: "grace upon grace",
    startMs: 500,
    endMs: 2500,
    ...overrides,
  };
}

function assFor(t: TitleBanner) {
  // No caption lines at all: the only ink in the frame is the title's own.
  return generateAssSubtitles([], style, W, H, null, null, { banner: t, measurer: measurerFor(t) });
}

function layoutFor(t: TitleBanner) {
  return layOutTitleBanner({ title: t, videoWidth: W, videoHeight: H, ...measurerFor(t) });
}

/** The bounding box of every pixel brighter than the background, with its brightest value. */
async function inkBox(pngPath: string) {
  const { stdout } = await execFileAsync(
    "ffmpeg",
    ["-v", "error", "-i", pngPath, "-f", "rawvideo", "-pix_fmt", "gray", "-"],
    { encoding: "buffer", maxBuffer: 1 << 28 },
  );
  const raw = stdout as unknown as Buffer;
  let top = -1;
  let bottom = -1;
  let left = W;
  let right = -1;
  let count = 0;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      if (raw[y * W + x] <= 90) continue;
      count += 1;
      if (top < 0) top = y;
      bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  return { top, bottom, left, right, count };
}

async function renderFrame(ass: string, atSeconds: number) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "title-render-"));
  const assPath = path.join(dir, "title.ass");
  const png = path.join(dir, "frame.png");
  await writeFile(assPath, ass, "utf8");
  await execFileAsync("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `color=c=0x181818:s=${W}x${H}:d=4:rate=100,format=yuv420p`,
    "-vf", `subtitles=filename='${assPath}':fontsdir='${FONTS_DIR}'`,
    "-ss", String(atSeconds), "-frames:v", "1", png,
  ]);
  return { png, dir };
}

describe("the title is burned in where the layout says it is", () => {
  it("draws the box at exactly the rectangle the layout computed", async () => {
    const title = banner();
    const { png, dir } = await renderFrame(assFor(title), 1.0);
    try {
      const ink = await inkBox(png);
      const box = layoutFor(title).box;

      // Within a pixel: libass rasterises a drawing's edges, and a whole-number coordinate can
      // land either side of a pixel boundary.
      expect(Math.abs(ink.left - box.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(ink.top - box.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(ink.right - (box.x + box.width - 1))).toBeLessThanOrEqual(1);
      expect(Math.abs(ink.bottom - (box.y + box.height - 1))).toBeLessThanOrEqual(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("shows nothing before it starts or after it ends", async () => {
    const title = banner();
    const ass = assFor(title);
    const before = await renderFrame(ass, 0.2);
    const after = await renderFrame(ass, 3.0);
    try {
      expect((await inkBox(before.png)).count).toBe(0);
      expect((await inkBox(after.png)).count).toBe(0);
    } finally {
      await rm(before.dir, { recursive: true, force: true });
      await rm(after.dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("moves to the bottom-safe line when anchored there", async () => {
    const title = banner({ anchor: "bottom-safe" });
    const { png, dir } = await renderFrame(assFor(title), 1.0);
    try {
      const ink = await inkBox(png);
      const box = layoutFor(title).box;
      expect(Math.abs(ink.top - box.y)).toBeLessThanOrEqual(1);
      expect(box.y).toBeGreaterThan(H / 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("grows downward when its text wraps, and still fits its own box", async () => {
    const title = banner({ text: "peace is not the absence of trouble but the presence", widthPct: 0.5 });
    const { png, dir } = await renderFrame(assFor(title), 1.0);
    try {
      const ink = await inkBox(png);
      const layout = layoutFor(title);
      expect(layout.lines.length).toBeGreaterThan(1);
      expect(Math.abs(ink.bottom - (layout.box.y + layout.box.height - 1))).toBeLessThanOrEqual(1);
      // Every glyph is inside the box, which is what the padding is for.
      expect(ink.left).toBeGreaterThanOrEqual(layout.box.x - 1);
      expect(ink.right).toBeLessThanOrEqual(layout.box.x + layout.box.width);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("keeps a bordered title inside the width the member set", async () => {
    // The border is drawn inside the box. If it grew the box, resizing would not mean what it says.
    // Yellow, not red: the ink check reads a greyscale frame, and pure red converts to 76 — under
    // the threshold. A border the check cannot see would make this pass for the wrong reason.
    const plain = banner({ border: { widthPx: 0, color: "#FFFF00" } });
    const bordered = banner({ border: { widthPx: 10, color: "#FFFF00" } });
    const a = await renderFrame(assFor(plain), 1.0);
    const b = await renderFrame(assFor(bordered), 1.0);
    try {
      const inkA = await inkBox(a.png);
      const inkB = await inkBox(b.png);
      expect(Math.abs(inkA.left - inkB.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(inkA.right - inkB.right)).toBeLessThanOrEqual(1);
    } finally {
      await rm(a.dir, { recursive: true, force: true });
      await rm(b.dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("leaves the caption events untouched when a title is added", async () => {
    // A title must not move a caption by a pixel. Same clip, rendered with and without one.
    const lines = [
      {
        id: "l",
        startMs: 0,
        endMs: 2000,
        text: "peace is here",
        words: ["peace", "is", "here"].map((word, index) => ({
          id: `l:${index}`,
          word,
          startMs: index * 600,
          endMs: (index + 1) * 600,
        })),
      },
    ];
    const face = resolveCaptionFace(style);
    const capMeasurer = createCaptionMeasurer({
      family: face.family,
      bold: face.bold,
      sizePx: style.sizePx,
    });
    const measurer = { measure: capMeasurer.measure, spaceWidth: capMeasurer.spaceWidth };
    const title = banner({ anchor: "top-safe" });

    const without = generateAssSubtitles(lines, style, W, H, null, measurer, null);
    const withTitle = generateAssSubtitles(lines, style, W, H, null, measurer, {
      banner: title,
      measurer: measurerFor(title),
    });

    const captionsOf = (ass: string) =>
      ass.split("\n").filter((line) => line.startsWith("Dialogue:") && line.includes(",Default,"));
    expect(captionsOf(withTitle)).toEqual(captionsOf(without));
  });
});
