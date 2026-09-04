import { rm } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { prisma } from "../../src/lib/prisma";
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
/** Comfortably past the editor's 300ms idle save debounce. */
const AFTER_AUTOSAVE_MS = 2_500;

const titleRow = (page: Page) => page.getByTestId("title-track");
const videoRow = (page: Page) => page.getByRole("group", { name: "Clip trim timeline" });
const audioRow = (page: Page) => page.getByTestId("audio-track");
const window_ = (page: Page) => page.getByTestId("timeline-window");
const startHandle = (page: Page) => page.getByRole("slider", { name: "Clip start" });
const endHandle = (page: Page) => page.getByRole("slider", { name: "Clip end" });
const volumeSlider = (page: Page) => page.getByRole("slider", { name: "Original volume" });
const selectTrack = (page: Page, track: "title" | "video" | "audio") =>
  page.getByTestId(`track-select-${track}`).click();
const captionsPanel = (page: Page) => page.getByRole("heading", { name: "Captions" });
const titlePanel = (page: Page) => page.getByRole("heading", { name: "Title", exact: true });
const audioPanel = (page: Page) => page.getByRole("heading", { name: "Audio", exact: true });

async function storedTitle(clipId: string) {
  const state = await storedState(clipId);
  return state ? readTitleBanner(state.overlays) : null;
}

async function trimRange(page: Page) {
  return {
    start: await startHandle(page).getAttribute("aria-valuenow"),
    end: await endHandle(page).getAttribute("aria-valuenow"),
  };
}

/** What the handles are allowed to reach: the media, whatever the window shows of it. */
async function trimLimits(page: Page) {
  return {
    min: await startHandle(page).getAttribute("aria-valuemin"),
    max: await endHandle(page).getAttribute("aria-valuemax"),
  };
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

  test("zoom shows less or more of the source, and never moves the trim limits", async ({
    page,
  }) => {
    const before = await trimRange(page);
    const limitsBefore = await trimLimits(page);
    await expect(window_(page)).toHaveAttribute("data-end", String(SOURCE_MS));

    // In, three times: the 15s of context becomes under two seconds, which a six-second source
    // has room to show, so the window finally stops short of the media's end.
    for (let step = 0; step < 3; step += 1) {
      await page.getByRole("button", { name: "Zoom in" }).click();
    }
    await expect(page.getByTestId("timeline-zoom")).toHaveText("8×");
    const zoomedEnd = Number(await window_(page).getAttribute("data-end"));
    expect(zoomedEnd).toBeLessThan(SOURCE_MS);
    expect(zoomedEnd).toBeGreaterThanOrEqual(CLIP_END_MS);

    // The handles neither moved nor changed what they are allowed to reach.
    expect(await trimRange(page)).toEqual(before);
    expect(await trimLimits(page)).toEqual(limitsBefore);

    // Back to rest, then out: more context than the source has is clamped to the source.
    await page.getByRole("button", { name: "Reset timeline zoom" }).click();
    await expect(page.getByTestId("timeline-zoom")).toHaveText("1×");
    await expect(window_(page)).toHaveAttribute("data-end", String(SOURCE_MS));
    await page.getByRole("button", { name: "Zoom out" }).click();
    await expect(page.getByTestId("timeline-zoom")).toHaveText("0.5×");
    await expect(window_(page)).toHaveAttribute("data-start", "0");
    await expect(window_(page)).toHaveAttribute("data-end", String(SOURCE_MS));
    expect(await trimRange(page)).toEqual(before);
    expect(await trimLimits(page)).toEqual(limitsBefore);
  });

  test("the transport controls sit centred above the tracks", async ({ page }) => {
    const controls = page.getByTestId("transport-controls");
    await controls.scrollIntoViewIfNeeded();
    const bar = (await controls.boundingBox())!;
    const tracks = (await videoRow(page).boundingBox())!;

    expect(Math.abs(bar.x + bar.width / 2 - (tracks.x + tracks.width / 2))).toBeLessThan(2);
    expect(bar.y + bar.height).toBeLessThanOrEqual(tracks.y);
    await expect(controls.getByRole("button", { name: "Play clip" })).toBeVisible();
    // Moved, not copied: the preview's own bar no longer carries them.
    await expect(page.getByRole("button", { name: "Go to start" })).toHaveCount(1);
  });

  test("the original volume reaches the preview at once and the document soon after", async ({
    page,
  }) => {
    await selectTrack(page, "audio");
    await expect(volumeSlider(page)).toHaveValue("100");
    expect(await page.evaluate(() => document.querySelector("video")!.volume)).toBe(1);

    await volumeSlider(page).fill("40");

    // The preview plays the sermon's own sound at the new level on the same input event.
    expect(await page.evaluate(() => document.querySelector("video")!.volume)).toBeCloseTo(0.4, 5);
    await expect
      .poll(async () => (await storedState(fixture.clipId))?.audio.originalVolume, {
        timeout: 15_000,
      })
      .toBe(0.4);
  });

  test("Title opens Title settings, Video returns to Captions, Audio opens Audio settings", async ({
    page,
  }) => {
    // The editor opens on Video, which shows Captions: what every clip opened to before.
    await expect(captionsPanel(page)).toBeVisible();
    await expect(titlePanel(page)).toHaveCount(0);
    await expect(audioPanel(page)).toHaveCount(0);

    await selectTrack(page, "title");
    await expect(titlePanel(page)).toBeVisible();
    await expect(captionsPanel(page)).toHaveCount(0);

    await selectTrack(page, "video");
    await expect(captionsPanel(page)).toBeVisible();
    await expect(titlePanel(page)).toHaveCount(0);

    await selectTrack(page, "audio");
    await expect(audioPanel(page)).toBeVisible();
    await expect(captionsPanel(page)).toHaveCount(0);

    // The panels the plan does not name stay where they are, whichever track is selected.
    await expect(page.getByRole("heading", { name: "Layout" })).toBeVisible();
  });

  test("pressing a row selects its track too, and selecting is not an edit", async ({ page }) => {
    const versionsBefore = await prisma.clipEdit.count({ where: { clipId: fixture.clipId } });
    await audioRow(page).scrollIntoViewIfNeeded();
    const box = (await audioRow(page).boundingBox())!;

    await page.mouse.click(box.x + box.width * 0.2, box.y + box.height / 2);

    await expect(audioPanel(page)).toBeVisible();
    await expect(page.getByTestId("track-select-audio")).toHaveAttribute("aria-pressed", "true");
    await page.waitForTimeout(AFTER_AUTOSAVE_MS);
    expect(await prisma.clipEdit.count({ where: { clipId: fixture.clipId } })).toBe(versionsBefore);
  });

  test("taking the Title row's offer opens Title settings on the new title", async ({ page }) => {
    await titleRow(page).scrollIntoViewIfNeeded();
    await page.getByTestId("title-track-add").click();

    await expect(titlePanel(page)).toBeVisible();
    await expect(page.getByTestId("title-text")).toBeVisible();
    await expect(page.getByTestId("track-select-title")).toHaveAttribute("aria-pressed", "true");
  });
});
