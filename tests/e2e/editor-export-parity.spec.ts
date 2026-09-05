import { rm } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { prisma } from "../../src/lib/prisma";
import { buildCaptionLines } from "../../src/lib/editor/caption-lines";
import { getCaptionPreset } from "../../src/lib/editor/caption-presets";
import { resolveCaptionFace } from "../../src/lib/editor/caption-face";
import { generateAssSubtitles } from "../../src/lib/export/ass-generator";
import { createCaptionMeasurer } from "../../src/lib/export/font-metrics";
import { signInAs, signOutTestSessions } from "./auth-session";
import { getStorageProvider } from "../../src/lib/storage";
import {
  canvas,
  captionObject,
  createCanvasFixture,
  destroyCanvasFixture,
  openCanvasEditor,
  type CanvasFixture,
} from "./canvas-fixture";

process.env.STORAGE_LOCAL_ROOT = path.join(process.cwd(), ".data", "e2e-storage");
process.env.WHISPER_MODEL_PATH = "";

/**
 * Slice 13 in the browser.
 *
 * The render-level parity gate (`tests/integration/export-parity.integration.test.ts`) proves the
 * file matches the document. It cannot prove the *screen* matches the file, because it never opens
 * one. These are the three claims that need a browser and nothing more:
 *
 *  1. Export is reached from the header and nowhere else, and it is a drawer rather than a modal.
 *  2. The caption the member sees rests where the burn-in anchors it.
 *  3. A download needs no editorial approval, and the billing gate still refuses one.
 *
 * Held until the final UI was approved (2026-09-05) so the selectors were written once.
 */

const FRAME_HEIGHT = 1920;
const FRAME_WIDTH = 1080;

/** The words the canvas fixture seeds, in order. */
const FIXTURE_WORDS = [
  { word: "Peace", startMs: 0, endMs: 600 },
  { word: "stays", startMs: 600, endMs: 1200 },
  { word: "with", startMs: 1200, endMs: 1800 },
  { word: "us", startMs: 1800, endMs: 2400 },
];

const exportButton = (page: Page) => page.getByRole("button", { name: "Export MP4" });
const exportDrawer = (page: Page) => page.getByTestId("export-dialog");
const runExportButton = (page: Page) => page.getByRole("button", { name: "Export 9:16 MP4" });
const captionBlock = (page: Page) => page.getByTestId("caption-block");

let fixture: CanvasFixture | undefined;

test.beforeAll(async () => {
  fixture = await createCanvasFixture(getStorageProvider());
});

test.beforeEach(async ({ context }) => {
  await signInAs(context, fixture!.userId);
});

test.afterAll(async () => {
  await signOutTestSessions();
  await destroyCanvasFixture(fixture);
  await rm(process.env.STORAGE_LOCAL_ROOT!, { recursive: true, force: true });
  await prisma.$disconnect();
});

test.describe("Export is reached from the header, and it is not a modal", () => {
  test("the header button is the only way in", async ({ page }) => {
    await openCanvasEditor(page, fixture!.clipId);

    // Nothing offers an export until the header button is pressed. The Style column used to carry
    // this panel; the whole point of moving it is that there is now one entry point.
    await expect(exportDrawer(page)).toHaveCount(0);
    await expect(runExportButton(page)).toHaveCount(0);
    await expect(exportButton(page)).toHaveCount(1);

    await exportButton(page).click();
    await expect(exportDrawer(page)).toBeVisible();
    await expect(runExportButton(page)).toBeVisible();
  });

  test("it takes focus when it opens, and Escape closes it", async ({ page }) => {
    await openCanvasEditor(page, fixture!.clipId);
    await exportButton(page).click();

    // The close button takes focus, so a keyboard user is inside the thing that just opened.
    await expect(page.getByRole("button", { name: "Close export" })).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(exportDrawer(page)).toHaveCount(0);
  });

  test("the page behind it stays usable, which is why it is a drawer", async ({ page }) => {
    await openCanvasEditor(page, fixture!.clipId);
    await exportButton(page).click();
    await expect(exportDrawer(page)).toBeVisible();

    // An export can be refused for something the member must fix in another panel, so the page
    // behind must still answer. A modal would name a way out it had just taken away.
    await page.getByRole("button", { name: "Highlighter" }).click();
    await expect(page.getByRole("button", { name: "Highlighter" })).toBeVisible();
    await expect(exportDrawer(page)).toBeVisible();
  });
});

test.describe("The caption on screen rests where the burn-in anchors it", () => {
  /**
   * The bottom edge of the caption block, in frame coordinates.
   *
   * The canvas is exactly the 9:16 frame, so a box measured against it converts directly. The
   * block itself is measured rather than the canvas object around it: the object carries a border
   * and padding that the burn-in has no equivalent for, and at preview scale those few CSS pixels
   * are tens of frame pixels.
   */
  async function captionBlockEdgesInFrame(page: Page) {
    const frame = (await canvas(page).boundingBox())!;
    const block = (await captionBlock(page).boundingBox())!;
    const toFrameY = (clientY: number) => ((clientY - frame.y) / frame.height) * FRAME_HEIGHT;
    return {
      top: toFrameY(block.y),
      bottom: toFrameY(block.y + block.height),
      centreX: ((block.x + block.width / 2 - frame.x) / frame.width) * FRAME_WIDTH,
    };
  }

  /** Where the burn-in would put this line's single row, read out of its own generated script. */
  function burnInRowY(): number {
    const style = getCaptionPreset("highlighter").style;
    const face = resolveCaptionFace(style);
    const measurer = createCaptionMeasurer({
      family: face.family,
      bold: face.bold,
      sizePx: style.sizePx,
    });
    const line = buildCaptionLines(
      FIXTURE_WORDS.map((word, index) => ({ ...word, id: `w${index}` })),
    )[0];
    const ass = generateAssSubtitles([line], style, FRAME_WIDTH, FRAME_HEIGHT, null, {
      measure: measurer.measure,
      spaceWidth: measurer.spaceWidth,
    });
    const ys = new Set<number>();
    for (const row of ass.split("\n")) {
      if (!row.startsWith("Dialogue:") || !row.includes(",Default,")) continue;
      for (const match of row.matchAll(/\\(?:pos|move)\((-?\d+),(-?\d+)/g)) ys.add(Number(match[2]));
    }
    const found = [...ys];
    expect(found).toHaveLength(1);
    return found[0];
  }

  /**
   * How far the screen may sit from the file, in frame pixels.
   *
   * Measured, not guessed: the block's bottom edge reports 1689.93 against the burn-in's 1690, a
   * drift of 0.07px, which is layout rounding on two boxes scaled by roughly 0.3. Two frame pixels
   * is thirty times that, and still seven times tighter than the error this exists to catch: before
   * the preview was moved onto the burn-in's anchor it rested this block at 1675.2, 14.8px out.
   *
   * A position, not a text width, so it does not scale with glyph count the way the measurer
   * parity tolerance does. It is the same bound whatever the line says.
   */
  const POSITION_TOLERANCE_FRAME_PX = 2;

  test("the block's bottom edge is the burn-in's own margin line", async ({ page }) => {
    await openCanvasEditor(page, fixture!.clipId);
    await page.getByRole("button", { name: "Highlighter" }).click();
    // The bundled face arrives over the network and its metrics differ from the fallback's.
    // Nothing may be measured before it lands, or this measures a font swap.
    await page.evaluate(() => document.fonts.ready);
    await expect(captionBlock(page)).toBeVisible();

    const edges = await captionBlockEdgesInFrame(page);

    // 1920 - 230 = 1690, the top of the 12 percent band the platforms cover with their own UI.
    // The caption sits on that line and grows upward, on screen exactly as in the file.
    expect(burnInRowY()).toBe(1690);
    expect(edges.bottom).toBeGreaterThan(1690 - POSITION_TOLERANCE_FRAME_PX);
    expect(edges.bottom).toBeLessThan(1690 + POSITION_TOLERANCE_FRAME_PX);
  });

  test("it is centred across the frame, as the burn-in centres it", async ({ page }) => {
    await openCanvasEditor(page, fixture!.clipId);
    await page.getByRole("button", { name: "Highlighter" }).click();
    await page.evaluate(() => document.fonts.ready);
    await expect(captionBlock(page)).toBeVisible();

    const edges = await captionBlockEdgesInFrame(page);
    expect(Math.abs(edges.centreX - FRAME_WIDTH / 2)).toBeLessThan(POSITION_TOLERANCE_FRAME_PX);
  });

  test("it sits clear of the band it is anchored to, rather than inside it", async ({ page }) => {
    await openCanvasEditor(page, fixture!.clipId);
    await page.getByRole("button", { name: "Highlighter" }).click();
    await page.evaluate(() => document.fonts.ready);
    await expect(captionBlock(page)).toBeVisible();

    // The whole reason the burn-in anchors an edge: everything drawn is above the platform's own
    // strip. A block centred on a fixed fraction would hang into it as rows were added.
    const edges = await captionBlockEdgesInFrame(page);
    expect(edges.top).toBeLessThan(edges.bottom);
    expect(edges.bottom).toBeLessThanOrEqual(1690 + POSITION_TOLERANCE_FRAME_PX);
  });
});

test.describe("A download needs no approval, and billing still binds", () => {
  test("an unapproved clip exports, and says so", async ({ page }) => {
    await openCanvasEditor(page, fixture!.clipId);
    await exportButton(page).click();

    // The clip is SUGGESTED: never sent for review, never approved. Approval gates publishing and
    // scheduling, never a manual download (2026-08-18 decision), and the panel says as much.
    await expect(exportDrawer(page)).toContainText("Approval is not needed to download");

    await runExportButton(page).click();

    // It starts. Whether the render finishes is the integration suite's question, not this one.
    await expect(exportDrawer(page)).toContainText(/Queued for export|Rendering|Download MP4/);
    await expect(exportDrawer(page)).not.toContainText("read-only");
  });

  test("a workspace whose trial has ended is refused, in the drawer", async ({ page }) => {
    // Read-only is a billing state, not a role: the member is still the owner and the button is
    // still there. The refusal has to arrive when it is pressed.
    await prisma.workspace.update({
      where: { id: fixture!.workspaceId },
      data: { trialEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000), paidAt: null },
    });

    try {
      await openCanvasEditor(page, fixture!.clipId);
      await exportButton(page).click();
      await runExportButton(page).click();

      await expect(exportDrawer(page)).toContainText(
        "The trial ended. This workspace is read-only until it changes to Paid.",
      );
      await expect(exportDrawer(page)).not.toContainText("Download MP4");
    } finally {
      // Restored for whatever runs next, and because leaving a fixture read-only would fail the
      // next spec for a reason that has nothing to do with it.
      await prisma.workspace.update({
        where: { id: fixture!.workspaceId },
        data: { trialEndsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
      });
    }
  });
});

test.describe("No editor chrome is part of the caption itself", () => {
  test("selecting the caption draws handles around it without moving it", async ({ page }) => {
    await openCanvasEditor(page, fixture!.clipId);
    await page.getByRole("button", { name: "Highlighter" }).click();
    await page.evaluate(() => document.fonts.ready);
    await expect(captionBlock(page)).toBeVisible();

    const before = (await captionBlock(page).boundingBox())!;
    await captionObject(page).click();
    await expect(page.getByTestId("canvas-handle-top-left")).toBeVisible();
    const after = (await captionBlock(page).boundingBox())!;

    // The handles are drawn on the object, not in the block: selecting must not shift a single
    // pixel of what the file will contain. This is the screen half of the render gate's claim
    // that no handle reaches the MP4.
    expect(Math.abs(after.y - before.y)).toBeLessThan(1);
    expect(Math.abs(after.height - before.height)).toBeLessThan(1);
  });
});
