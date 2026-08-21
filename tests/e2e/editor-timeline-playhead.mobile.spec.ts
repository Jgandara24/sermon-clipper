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

/** The smallest target a finger reliably hits. */
const MIN_TOUCH_TARGET_PX = 44;

/** Comfortably past the editor's 300ms idle save debounce. */
const AFTER_AUTOSAVE_MS = 2_500;

const playhead = (page: Page) => page.getByRole("slider", { name: "Playhead" });
const startHandle = (page: Page) => page.getByRole("slider", { name: "Clip start" });
const endHandle = (page: Page) => page.getByRole("slider", { name: "Clip end" });

async function trimRange(page: Page) {
  return {
    start: await startHandle(page).getAttribute("aria-valuenow"),
    end: await endHandle(page).getAttribute("aria-valuenow"),
  };
}

/** One finger, pressed and dragged. Playwright's touchscreen only taps, so the points go direct. */
async function touchDrag(page: Page, fromX: number, fromY: number, dx: number) {
  const client = await page.context().newCDPSession(page);
  const point = (x: number) => [{ x, y: fromY, id: 0, radiusX: 8, radiusY: 8, force: 1 }];

  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(fromX) });
  for (const step of [0.3, 0.6, 1]) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: point(fromX + dx * step),
    });
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await client.detach();
}

async function dragPlayheadByTouch(page: Page, dx: number) {
  await playhead(page).scrollIntoViewIfNeeded();
  const box = (await playhead(page).boundingBox())!;
  await touchDrag(page, box.x + box.width / 2, box.y + box.height / 2, dx);
}

function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

test.describe("The playhead on a phone", () => {
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

  test("the target is big enough for a finger", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    await playhead(page).scrollIntoViewIfNeeded();

    const box = (await playhead(page).boundingBox())!;

    expect(box.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    expect(box.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
  });

  test("the marker it draws is still small", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    await playhead(page).scrollIntoViewIfNeeded();

    // The target grew; the dot did not. A 44px red circle would swamp the timeline.
    const marker = (await playhead(page).locator("span").boundingBox())!;
    expect(marker.width).toBeLessThanOrEqual(20);
    expect(marker.height).toBeLessThanOrEqual(20);
  });

  test("the bigger target still clears both trim handles", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    await playhead(page).scrollIntoViewIfNeeded();

    const target = (await playhead(page).boundingBox())!;
    for (const handle of [startHandle(page), endHandle(page)]) {
      expect(overlaps(target, (await handle.boundingBox())!)).toBe(false);
    }
  });

  test("the bigger target sits entirely above the track", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    await playhead(page).scrollIntoViewIfNeeded();

    const target = (await playhead(page).boundingBox())!;
    const track = (await page.getByRole("group", { name: "Clip trim timeline" }).boundingBox())!;

    // Being above the track is what keeps it clear of the handles, which span the track.
    expect(target.y + target.height).toBeLessThanOrEqual(track.y + 1);
  });

  test("a press on the target reaches the playhead, not a trim handle", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    await playhead(page).scrollIntoViewIfNeeded();

    const box = (await playhead(page).boundingBox())!;
    const hit = await page.evaluate(
      ([x, y]) => {
        const element = document.elementFromPoint(x as number, y as number) as HTMLElement | null;
        return (element?.closest("[data-trim]") as HTMLElement | null)?.getAttribute("data-trim") ?? "none";
      },
      [box.x + box.width / 2, box.y + box.height / 2],
    );

    expect(hit).toBe("playhead");
  });

  test("dragging it from the clip start scrubs and never trims", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    const before = await trimRange(page);
    const versionsBefore = await prisma.clipEdit.count({ where: { clipId: fixture.clipId } });

    await page.getByRole("button", { name: "Go to start" }).click();
    await expect(playhead(page)).toHaveAttribute("aria-valuenow", before.start!);

    await dragPlayheadByTouch(page, 80);

    await expect
      .poll(async () => Number(await playhead(page).getAttribute("aria-valuenow")))
      .toBeGreaterThan(0);

    await page.waitForTimeout(AFTER_AUTOSAVE_MS);
    expect(await trimRange(page)).toEqual(before);
    expect(await prisma.clipEdit.count({ where: { clipId: fixture.clipId } })).toBe(versionsBefore);
  });

  test("dragging it from the clip end scrubs and never trims", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    const before = await trimRange(page);
    const versionsBefore = await prisma.clipEdit.count({ where: { clipId: fixture.clipId } });

    await page.getByRole("button", { name: "Go to end" }).click();
    await expect(playhead(page)).toHaveAttribute("aria-valuenow", before.end!);

    await dragPlayheadByTouch(page, -80);

    await expect
      .poll(async () => Number(await playhead(page).getAttribute("aria-valuenow")))
      .toBeLessThan(Number(before.end));

    await page.waitForTimeout(AFTER_AUTOSAVE_MS);
    expect(await trimRange(page)).toEqual(before);
    expect(await prisma.clipEdit.count({ where: { clipId: fixture.clipId } })).toBe(versionsBefore);
  });
});
