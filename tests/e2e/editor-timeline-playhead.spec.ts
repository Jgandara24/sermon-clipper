import { rm } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { prisma } from "../../src/lib/prisma";
import { DEV_SESSION_COOKIE } from "../../src/lib/auth";
import { getStorageProvider } from "../../src/lib/storage";
import {
  createCanvasFixture,
  destroyCanvasFixture,
  openCanvasEditor,
  type CanvasFixture,
} from "./canvas-fixture";

process.env.STORAGE_LOCAL_ROOT = path.join(process.cwd(), ".data", "e2e-storage");
process.env.WHISPER_MODEL_PATH = "";

/**
 * Longer than the editor's idle save debounce (300ms), by a wide margin. The defect this suite
 * guards produced a write that landed *after* the assertion, so a short wait passed while the
 * clip had already been trimmed.
 */
const AFTER_AUTOSAVE_MS = 2_500;

const playhead = (page: Page) => page.getByRole("slider", { name: "Playhead" });
const startHandle = (page: Page) => page.getByRole("slider", { name: "Clip start" });
const endHandle = (page: Page) => page.getByRole("slider", { name: "Clip end" });
const track = (page: Page) => page.getByRole("group", { name: "Clip trim timeline" });

async function trimRange(page: Page) {
  return {
    start: await startHandle(page).getAttribute("aria-valuenow"),
    end: await endHandle(page).getAttribute("aria-valuenow"),
  };
}

/** Drags an element by a pixel offset, in steps, like a real gesture. */
async function dragBy(page: Page, locator: ReturnType<typeof playhead>, dx: number) {
  await locator.scrollIntoViewIfNeeded();
  const box = (await locator.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (const step of [0.3, 0.6, 1]) {
    await page.mouse.move(x + dx * step, y, { steps: 4 });
  }
  await page.mouse.up();
}

test.describe("The playhead and the trim handles are separate targets", () => {
  let fixture: CanvasFixture;

  test.beforeEach(async ({ context }) => {
    fixture = await createCanvasFixture(getStorageProvider());
    await context.addCookies([
      {
        name: DEV_SESSION_COOKIE,
        value: fixture.userId,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
  });

  test.afterEach(async () => {
    await destroyCanvasFixture(fixture);
    if (process.env.STORAGE_LOCAL_ROOT) {
      await rm(process.env.STORAGE_LOCAL_ROOT, { recursive: true, force: true });
    }
  });

  test("a press on the playhead reaches the playhead, not a trim handle", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    await playhead(page).scrollIntoViewIfNeeded();

    // At the clip start the two used to occupy identical pixels, and the handle was on top.
    const box = (await playhead(page).boundingBox())!;
    const hit = await page.evaluate(
      ([x, y]) => {
        const element = document.elementFromPoint(x as number, y as number) as HTMLElement | null;
        const owner = element?.closest("[data-trim]") as HTMLElement | null;
        return owner?.getAttribute("data-trim") ?? "none";
      },
      [box.x + box.width / 2, box.y + box.height / 2],
    );

    expect(hit).toBe("playhead");
  });

  test("the playhead's target does not overlap either trim handle", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    await playhead(page).scrollIntoViewIfNeeded();

    const knob = (await playhead(page).boundingBox())!;
    for (const handle of [startHandle(page), endHandle(page)]) {
      const box = (await handle.boundingBox())!;
      const overlaps =
        knob.x < box.x + box.width &&
        box.x < knob.x + knob.width &&
        knob.y < box.y + box.height &&
        box.y < knob.y + knob.height;
      expect(overlaps).toBe(false);
    }
  });

  test("dragging the playhead from the clip start never trims the clip", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    const before = await trimRange(page);
    const versionsBefore = await prisma.clipEdit.count({ where: { clipId: fixture.clipId } });

    await page.getByRole("button", { name: "Go to start" }).click();
    await expect(playhead(page)).toHaveAttribute("aria-valuenow", before.start!);
    await dragBy(page, playhead(page), 90);

    await expect
      .poll(async () => Number(await playhead(page).getAttribute("aria-valuenow")))
      .toBeGreaterThan(0);

    // Long enough for a debounced write to have landed, which is what made this intermittent.
    await page.waitForTimeout(AFTER_AUTOSAVE_MS);

    expect(await trimRange(page)).toEqual(before);
    expect(await prisma.clipEdit.count({ where: { clipId: fixture.clipId } })).toBe(versionsBefore);
  });

  test("dragging the playhead from the clip end never trims the clip", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    const before = await trimRange(page);
    const versionsBefore = await prisma.clipEdit.count({ where: { clipId: fixture.clipId } });

    await page.getByRole("button", { name: "Go to end" }).click();
    await expect(playhead(page)).toHaveAttribute("aria-valuenow", before.end!);
    await dragBy(page, playhead(page), -90);

    await expect
      .poll(async () => Number(await playhead(page).getAttribute("aria-valuenow")))
      .toBeLessThan(Number(before.end));

    await page.waitForTimeout(AFTER_AUTOSAVE_MS);

    expect(await trimRange(page)).toEqual(before);
    expect(await prisma.clipEdit.count({ where: { clipId: fixture.clipId } })).toBe(versionsBefore);
  });

  test("the start handle still trims, and the trim is saved", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    const before = await trimRange(page);

    await dragBy(page, startHandle(page), 70);

    await expect
      .poll(async () => Number(await startHandle(page).getAttribute("aria-valuenow")))
      .toBeGreaterThan(Number(before.start));
    // The clip end is not dragged by moving the start.
    expect((await trimRange(page)).end).toBe(before.end);

    await expect
      .poll(
        async () => prisma.clipEdit.count({ where: { clipId: fixture.clipId } }),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
  });

  test("the end handle still trims, and the trim is saved", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    const before = await trimRange(page);

    await dragBy(page, endHandle(page), -70);

    await expect
      .poll(async () => Number(await endHandle(page).getAttribute("aria-valuenow")))
      .toBeLessThan(Number(before.end));
    expect((await trimRange(page)).start).toBe(before.start);

    await expect
      .poll(
        async () => prisma.clipEdit.count({ where: { clipId: fixture.clipId } }),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
  });

  test("clicking the timeline still seeks, and still writes nothing", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    const before = await trimRange(page);
    const versionsBefore = await prisma.clipEdit.count({ where: { clipId: fixture.clipId } });

    await track(page).scrollIntoViewIfNeeded();
    const box = (await track(page).boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);

    await expect
      .poll(async () => Number(await playhead(page).getAttribute("aria-valuenow")))
      .toBeGreaterThan(0);

    await page.waitForTimeout(AFTER_AUTOSAVE_MS);
    expect(await trimRange(page)).toEqual(before);
    expect(await prisma.clipEdit.count({ where: { clipId: fixture.clipId } })).toBe(versionsBefore);
  });

  test("the playhead still answers the arrow keys", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    const before = await trimRange(page);

    await playhead(page).focus();
    await page.keyboard.press("Shift+ArrowRight");

    await expect
      .poll(async () => Number(await playhead(page).getAttribute("aria-valuenow")))
      .toBe(1000);

    await page.waitForTimeout(AFTER_AUTOSAVE_MS);
    // Nudging the playhead is still not an edit.
    expect(await trimRange(page)).toEqual(before);
    expect(await prisma.clipEdit.count({ where: { clipId: fixture.clipId } })).toBe(0);
  });

  test("the trim handles still answer the arrow keys", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    const before = await trimRange(page);

    await startHandle(page).focus();
    await page.keyboard.press("Shift+ArrowRight");

    await expect
      .poll(async () => Number(await startHandle(page).getAttribute("aria-valuenow")))
      .toBe(Number(before.start) + 1000);
  });
});
