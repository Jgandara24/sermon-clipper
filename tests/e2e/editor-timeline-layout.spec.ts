import { rm } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { signInAs, signOutTestSessions } from "./auth-session";
import { getStorageProvider } from "../../src/lib/storage";
import {
  CLIP_END_MS,
  CLIP_START_MS,
  createCanvasFixture,
  destroyCanvasFixture,
  openCanvasEditor,
  storedState,
  type CanvasFixture,
} from "./canvas-fixture";
import { readTitleBanner } from "../../src/lib/editor/title-banner";

process.env.STORAGE_LOCAL_ROOT = path.join(process.cwd(), ".data", "e2e-storage");
process.env.WHISPER_MODEL_PATH = "";

/** The fixture's source is six seconds long, so the 15s of context clamps to the whole of it. */
const SOURCE_MS = 6_000;

const titleRow = (page: Page) => page.getByTestId("title-track");
const videoRow = (page: Page) => page.getByRole("group", { name: "Clip trim timeline" });
const audioRow = (page: Page) => page.getByTestId("audio-track");
const window_ = (page: Page) => page.getByTestId("timeline-window");
const startHandle = (page: Page) => page.getByRole("slider", { name: "Clip start" });
const endHandle = (page: Page) => page.getByRole("slider", { name: "Clip end" });

async function storedTitle(clipId: string) {
  const state = await storedState(clipId);
  return state ? readTitleBanner(state.overlays) : null;
}

/**
 * The timeline as a layout: three rows on one scale, with the source around the clip.
 *
 * The window and zoom maths are unit tested. What only a browser can answer is whether the rows
 * line up, whether the window the maths produced is the one on screen, and whether the empty
 * Title row's offer reaches the document.
 */
test.describe("the timeline layout", () => {
  let fixture: CanvasFixture;

  test.beforeEach(async ({ context, page }) => {
    fixture = await createCanvasFixture(getStorageProvider());
    await signInAs(context, fixture.userId);
    await openCanvasEditor(page, fixture.clipId);
  });

  test.afterEach(async () => {
    await signOutTestSessions();
    await destroyCanvasFixture(fixture);
    if (process.env.STORAGE_LOCAL_ROOT) {
      await rm(process.env.STORAGE_LOCAL_ROOT, { recursive: true, force: true });
    }
  });

  test("shows Title, Video and Audio rows, stacked in that order on one scale", async ({
    page,
  }) => {
    await videoRow(page).scrollIntoViewIfNeeded();
    const rows = [titleRow(page), videoRow(page), audioRow(page)];
    for (const row of rows) await expect(row).toBeVisible();

    const boxes = await Promise.all(rows.map(async (row) => (await row.boundingBox())!));
    const [title, video, audio] = boxes;

    // One pixel-to-time scale for every row: the same left edge and the same width.
    for (const box of boxes) {
      expect(Math.abs(box.x - video.x)).toBeLessThan(1);
      expect(Math.abs(box.width - video.width)).toBeLessThan(1);
    }
    expect(title.y + title.height).toBeLessThanOrEqual(video.y);
    expect(video.y + video.height).toBeLessThanOrEqual(audio.y);
  });

  test("shows the source on both sides of the clip, clamped to the media", async ({ page }) => {
    await expect(window_(page)).toHaveAttribute("data-start", String(0));
    await expect(window_(page)).toHaveAttribute("data-end", String(SOURCE_MS));

    // The clip sits inside that window at its real position: its end is two thirds of the way
    // along a six-second window, so the end handle is two thirds of the way along the row.
    await videoRow(page).scrollIntoViewIfNeeded();
    const row = (await videoRow(page).boundingBox())!;
    const handle = (await endHandle(page).boundingBox())!;
    const expectedX = row.x + (row.width * CLIP_END_MS) / SOURCE_MS;
    expect(Math.abs(handle.x + handle.width / 2 - expectedX)).toBeLessThan(3);
    expect(Number(await startHandle(page).getAttribute("aria-valuenow"))).toBe(CLIP_START_MS);
  });

  test("the Audio row shows where the speech is, from the transcript", async ({ page }) => {
    // Four words begin in the fixture's six seconds, each in a bucket of its own; nothing is drawn
    // for the silence after them.
    await expect(audioRow(page).locator("rect")).toHaveCount(4);
  });

  test("the empty Title row offers a title, and taking it makes the default one", async ({
    page,
  }) => {
    await expect(page.getByTestId("title-banner")).toHaveCount(0);
    await titleRow(page).scrollIntoViewIfNeeded();

    await page.getByTestId("title-track-add").click();

    await expect(page.getByTestId("title-region")).toBeVisible();
    await expect.poll(async () => (await storedTitle(fixture.clipId)) !== null, {
      timeout: 15_000,
    }).toBe(true);
    const title = (await storedTitle(fixture.clipId))!;
    expect(title.startMs).toBe(CLIP_START_MS);
    expect(title.endMs).toBe(CLIP_START_MS + 3_000);

    // Drawn on the row's shared scale: three seconds of a six-second window is half the row.
    const row = (await titleRow(page).boundingBox())!;
    const region = (await page.getByTestId("title-region").boundingBox())!;
    expect(Math.abs(region.width - row.width / 2)).toBeLessThan(4);
  });
});
