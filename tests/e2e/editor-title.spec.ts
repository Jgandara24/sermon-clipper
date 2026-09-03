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

const addButton = (page: Page) => page.getByTestId("title-add");
const removeButton = (page: Page) => page.getByTestId("title-remove");
const textField = (page: Page) => page.getByTestId("title-text");
const banner = (page: Page) => page.getByTestId("title-banner");
const lines = (page: Page) => page.getByTestId("title-line");

async function storedTitle(clipId: string) {
  const state = await storedState(clipId);
  return state ? readTitleBanner(state.overlays) : null;
}

/**
 * The Title overlay, through the real editor.
 *
 * The model and the burn-in have unit and render coverage. What only a browser can answer is
 * whether the controls reach the document, whether the preview follows them, and whether a title
 * the member removed stays removed.
 */
test.describe("the title overlay", () => {
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

  test("a clip starts with no title, and adding one defaults to the first three seconds", async ({
    page,
  }) => {
    await expect(banner(page)).toHaveCount(0);
    await expect(addButton(page)).toBeVisible();

    await addButton(page).click();

    await expect.poll(async () => (await storedTitle(fixture.clipId)) !== null, {
      timeout: 15_000,
    }).toBe(true);

    const title = (await storedTitle(fixture.clipId))!;
    expect(title.startMs).toBe(CLIP_START_MS);
    expect(title.endMs).toBe(Math.min(CLIP_END_MS, CLIP_START_MS + 3000));
    expect(title.anchor).toBe("top-safe");
  });

  test("typing a title shows it in the preview, cased as it will be burned in", async ({ page }) => {
    await addButton(page).click();
    await textField(page).fill("grace upon grace");

    // The default case is uppercase, and the preview lays out the same string the file draws.
    await expect(lines(page).first()).toHaveText("GRACE UPON GRACE");
    await expect(banner(page)).toBeVisible();
  });

  test("the preview follows a colour while it is being changed", async ({ page }) => {
    await addButton(page).click();
    await textField(page).fill("GRACE");

    // Filled rather than assigned: React tracks an input's value, and writing it directly makes
    // React treat the event as a no-op — which is also why a colour picker has to be driven the
    // way a person drives it to prove the preview follows.
    await page.getByTestId("title-background").fill("#ff0000");

    await expect(banner(page)).toHaveCSS("background-color", "rgb(255, 0, 0)");
  });

  test("a wider title wraps in the preview, and the box grows with it", async ({ page }) => {
    await addButton(page).click();
    await textField(page).fill("peace is not the absence of trouble but the presence of God");

    const oneLineHeight = (await banner(page).boundingBox())!.height;
    await expect.poll(async () => await lines(page).count()).toBeGreaterThan(1);
    expect((await banner(page).boundingBox())!.height).toBeGreaterThanOrEqual(oneLineHeight);
  });

  test("removing a title takes it off the canvas and it does not come back on reload", async ({
    page,
  }) => {
    await addButton(page).click();
    await textField(page).fill("GRACE");
    await expect(banner(page)).toBeVisible();

    await removeButton(page).click();
    await expect(banner(page)).toHaveCount(0);
    await expect(addButton(page)).toBeVisible();

    await expect.poll(async () => (await storedTitle(fixture.clipId)) === null, {
      timeout: 15_000,
    }).toBe(true);

    // The dismissal is the point: a default that came back would have to be removed every time.
    await openCanvasEditor(page, fixture.clipId);
    await expect(banner(page)).toHaveCount(0);
    await expect(addButton(page)).toBeVisible();
  });

  test("asking for a title again brings one back after it was removed", async ({ page }) => {
    await addButton(page).click();
    await removeButton(page).click();
    await expect(addButton(page)).toBeVisible();

    await addButton(page).click();
    await expect(banner(page)).toBeVisible();

    await expect.poll(async () => (await storedTitle(fixture.clipId)) !== null, {
      timeout: 15_000,
    }).toBe(true);
  });

  test("dragging the title's block moves when it shows, without changing its length", async ({
    page,
  }) => {
    await addButton(page).click();
    await textField(page).fill("GRACE");

    const before = (await storedTitle(fixture.clipId))!;
    const region = page.getByTestId("title-region");
    // The Title row sits at the top of the timeline, above the panel that was just used, so it is
    // scrolled to first: boundingBox reports viewport coordinates, and the mouse uses them too.
    await region.scrollIntoViewIfNeeded();
    const box = (await region.boundingBox())!;

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();

    await expect
      .poll(async () => (await storedTitle(fixture.clipId))!.startMs, { timeout: 15_000 })
      .toBeGreaterThan(before.startMs);

    const after = (await storedTitle(fixture.clipId))!;
    // The length is what a drag must not change.
    expect(after.endMs - after.startMs).toBe(before.endMs - before.startMs);
  });

  test("dragging an edge trims that end and leaves the other alone", async ({ page }) => {
    await addButton(page).click();
    await textField(page).fill("GRACE");

    const before = (await storedTitle(fixture.clipId))!;
    const handle = page.getByTestId("title-handle-end");
    await handle.scrollIntoViewIfNeeded();
    const box = (await handle.boundingBox())!;

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 50, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();

    await expect
      .poll(async () => (await storedTitle(fixture.clipId))!.endMs, { timeout: 15_000 })
      .toBeLessThan(before.endMs);
    expect((await storedTitle(fixture.clipId))!.startMs).toBe(before.startMs);
  });

  test("dragging the title on the canvas gives it a place of its own", async ({ page }) => {
    await addButton(page).click();
    await textField(page).fill("GRACE");

    // Scrolled into view first: boundingBox reports viewport coordinates, and the mouse uses
    // them too, so a box the page has not scrolled to is a point the pointer never reaches.
    await banner(page).scrollIntoViewIfNeeded();
    const before = (await banner(page).boundingBox())!;
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    for (const step of [0.3, 0.6, 1]) {
      await page.mouse.move(
        before.x + before.width / 2,
        before.y + before.height / 2 + 80 * step,
        { steps: 4 },
      );
    }
    await page.mouse.up();

    // Dragging is choosing a place, so the title stops being anchored.
    await expect
      .poll(async () => (await storedTitle(fixture.clipId))?.anchor, { timeout: 15_000 })
      .toBe("custom");
    expect((await storedTitle(fixture.clipId))!.box).toBeTruthy();
    expect((await banner(page).boundingBox())!.y).toBeGreaterThan(before.y);
  });

  test("the title snaps to the horizontal centre with a visible guide", async ({ page }) => {
    await addButton(page).click();
    await textField(page).fill("GRACE");

    await banner(page).scrollIntoViewIfNeeded();
    const start = (await banner(page).boundingBox())!;
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    // Nudged a few pixels off centre: near enough that the snap should claim it.
    await page.mouse.move(start.x + start.width / 2 + 4, start.y + start.height / 2 + 40, {
      steps: 6,
    });

    await expect(page.getByTestId("centre-guide")).toBeVisible();
    await page.mouse.up();
    await expect(page.getByTestId("centre-guide")).toHaveCount(0);
  });

  test("changing the position moves the box, and the document records it", async ({ page }) => {
    await addButton(page).click();
    await textField(page).fill("GRACE");

    const atTop = (await banner(page).boundingBox())!.y;
    await page.getByTestId("title-position-bottom-safe").click();

    await expect.poll(async () => (await storedTitle(fixture.clipId))?.anchor, {
      timeout: 15_000,
    }).toBe("bottom-safe");
    expect((await banner(page).boundingBox())!.y).toBeGreaterThan(atTop);
  });
});
