import { rm } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { signInAs, signOutTestSessions } from "./auth-session";
import { getStorageProvider } from "../../src/lib/storage";
import {
  canvas,
  createCanvasFixture,
  destroyCanvasFixture,
  openCanvasEditor,
  type CanvasFixture,
} from "./canvas-fixture";

process.env.STORAGE_LOCAL_ROOT = path.join(process.cwd(), ".data", "e2e-storage");
process.env.WHISPER_MODEL_PATH = "";

/**
 * A caption line the frame cannot hold on one row.
 *
 * The burn-in wraps this, and before Slice 8a the preview did not — it drew one long row with
 * `whitespace-nowrap`. Now both read the same measured layout, so this is the case where the two
 * would visibly disagree if the preview stopped reading it.
 */
const LONG_WORDS = [
  { word: "Everlasting", startMs: 0, endMs: 800 },
  { word: "righteousness", startMs: 800, endMs: 1600 },
  { word: "throughout", startMs: 1600, endMs: 2400 },
];

const captionWords = (page: Page) => page.getByTestId("caption-word");

async function chooseHighlighter(page: Page) {
  await page.getByRole("button", { name: "Highlighter" }).click();
  await expect(captionWords(page).first()).toBeVisible();
  // Nothing may be measured before the bundled face has loaded: a canvas asked too early answers
  // in the fallback's metrics, and the answer looks perfectly valid.
  await page.evaluate(() => document.fonts.ready);
}

/** Each word's box, in page coordinates. */
async function wordBoxes(page: Page) {
  const words = captionWords(page);
  const count = await words.count();
  const boxes = [];
  for (let index = 0; index < count; index += 1) {
    const box = await words.nth(index).boundingBox();
    if (box) boxes.push(box);
  }
  return boxes;
}

test.describe("A caption too wide for the frame wraps in the preview", () => {
  let fixture: CanvasFixture;

  test.beforeEach(async ({ context }) => {
    fixture = await createCanvasFixture(getStorageProvider(), { words: LONG_WORDS });
    await signInAs(context, fixture.userId);
  });

  test.afterEach(async () => {
    await signOutTestSessions();
    await destroyCanvasFixture(fixture);
    if (process.env.STORAGE_LOCAL_ROOT) {
      await rm(process.env.STORAGE_LOCAL_ROOT, { recursive: true, force: true });
    }
  });

  test("the words sit on more than one row", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    await chooseHighlighter(page);

    const boxes = await wordBoxes(page);
    expect(boxes.length).toBe(LONG_WORDS.length);

    // Rows are distinguished by their vertical centre; a single row would give exactly one.
    const rows = new Set(boxes.map((box) => Math.round(box.y + box.height / 2)));
    expect(rows.size).toBeGreaterThan(1);
  });

  test("no word hangs outside the video", async ({ page }) => {
    // The failure this prevents: with every word positioned and no wrapping rule, the same line
    // ran from x -81 to x 1161 on a 1080 frame and was clipped on both sides.
    await openCanvasEditor(page, fixture.clipId);
    await chooseHighlighter(page);

    const frame = await canvas(page).boundingBox();
    expect(frame).not.toBeNull();

    for (const box of await wordBoxes(page)) {
      expect(box.x).toBeGreaterThanOrEqual(frame!.x - 1);
      expect(box.x + box.width).toBeLessThanOrEqual(frame!.x + frame!.width + 1);
    }
  });

  test("the rows stack upward, keeping the caption off the bottom of the frame", async ({
    page,
  }) => {
    // The burn-in anchors an undragged caption at the bottom and grows upward, because the bottom
    // band of the frame belongs to the platform's own chrome. The preview has to do the same, or a
    // two-row caption sits lower on screen than it does in the exported file.
    await openCanvasEditor(page, fixture.clipId);
    await chooseHighlighter(page);

    const frame = await canvas(page).boundingBox();
    const boxes = await wordBoxes(page);
    const lowest = Math.max(...boxes.map((box) => box.y + box.height));

    expect(lowest).toBeLessThan(frame!.y + frame!.height);
  });
});
