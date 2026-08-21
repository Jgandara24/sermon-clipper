import { rm } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DEV_SESSION_COOKIE } from "../../src/lib/auth";
import { getStorageProvider } from "../../src/lib/storage";
import {
  canvas,
  captionObject,
  createCanvasFixture,
  destroyCanvasFixture,
  openCanvasEditor,
  storedCaptionBox,
  storedState,
  zoomReadout,
  type CanvasFixture,
} from "./canvas-fixture";

process.env.STORAGE_LOCAL_ROOT = path.join(process.cwd(), ".data", "e2e-storage");
process.env.WHISPER_MODEL_PATH = "";

const resetZoom = (page: Page) => page.getByRole("button", { name: "Reset zoom to 100%" });

/**
 * Drives a two-finger gesture through CDP touch events.
 *
 * Playwright's own touchscreen API taps with one finger; a pinch needs two, so the points are
 * dispatched directly. `move` is a list of [x, y] pairs per finger.
 */
async function twoFingerGesture(
  page: Page,
  start: [number, number][],
  frames: [number, number][][],
) {
  const client = await page.context().newCDPSession(page);
  const toPoints = (points: [number, number][]) =>
    points.map(([x, y], index) => ({ x, y, id: index, radiusX: 5, radiusY: 5, force: 1 }));

  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: toPoints(start),
  });
  for (const frame of frames) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: toPoints(frame),
    });
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await client.detach();
}

async function canvasCentre(page: Page) {
  await canvas(page).scrollIntoViewIfNeeded();
  const box = (await canvas(page).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

test.describe("Editing canvas on a phone", () => {
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

  test("pinching outward zooms the canvas in", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    await expect(zoomReadout(page)).toHaveText("100%");

    const { x, y } = await canvasCentre(page);
    await twoFingerGesture(
      page,
      [
        [x - 30, y],
        [x + 30, y],
      ],
      [
        [
          [x - 60, y],
          [x + 60, y],
        ],
        [
          [x - 90, y],
          [x + 90, y],
        ],
      ],
    );

    await expect.poll(async () => zoomReadout(page).textContent()).not.toBe("100%");
  });

  test("pinching inward returns to 100% and no further", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    const { x, y } = await canvasCentre(page);

    await twoFingerGesture(
      page,
      [
        [x - 90, y],
        [x + 90, y],
      ],
      [
        [
          [x - 20, y],
          [x + 20, y],
        ],
        [
          [x - 4, y],
          [x + 4, y],
        ],
      ],
    );

    // The canvas never zooms out past the whole frame.
    await expect(zoomReadout(page)).toHaveText("100%");
  });

  test("two fingers pan the canvas once it is zoomed", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    const { x, y } = await canvasCentre(page);

    // Spread to zoom, then carry both fingers sideways in the same gesture.
    await twoFingerGesture(
      page,
      [
        [x - 30, y],
        [x + 30, y],
      ],
      [
        [
          [x - 90, y],
          [x + 90, y],
        ],
        [
          [x - 130, y],
          [x + 50, y],
        ],
        [
          [x - 150, y],
          [x + 30, y],
        ],
      ],
    );

    const transform = await page
      .getByTestId("canvas-content")
      .evaluate((node) => getComputedStyle(node).transform);
    // A pan shows up as translation in the content's own transform, not in any saved value.
    expect(transform).not.toBe("none");
    await expect.poll(async () => zoomReadout(page).textContent()).not.toBe("100%");
  });

  test("reset returns the canvas to 100%", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    const { x, y } = await canvasCentre(page);

    await twoFingerGesture(
      page,
      [
        [x - 30, y],
        [x + 30, y],
      ],
      [
        [
          [x - 100, y],
          [x + 100, y],
        ],
      ],
    );
    await expect.poll(async () => zoomReadout(page).textContent()).not.toBe("100%");
    await expect(resetZoom(page)).toBeEnabled();

    await resetZoom(page).click();

    await expect(zoomReadout(page)).toHaveText("100%");
    await expect(resetZoom(page)).toBeDisabled();
    await expect(page.getByTestId("canvas-content")).toHaveCSS("transform", "none");
  });

  test("zooming and panning change no saved value", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    const before = JSON.stringify(await storedState(fixture.clipId));
    const { x, y } = await canvasCentre(page);

    await twoFingerGesture(
      page,
      [
        [x - 30, y],
        [x + 30, y],
      ],
      [
        [
          [x - 100, y],
          [x + 100, y],
        ],
        [
          [x - 140, y],
          [x + 60, y],
        ],
      ],
    );
    await expect.poll(async () => zoomReadout(page).textContent()).not.toBe("100%");

    // The whole point of the canvas: how the frame is being looked at is not part of the clip.
    expect(JSON.stringify(await storedState(fixture.clipId))).toBe(before);
    expect(await storedCaptionBox(fixture.clipId)).toBeNull();
  });

  test("the caption still drags while the canvas is zoomed", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    const { x, y } = await canvasCentre(page);

    await twoFingerGesture(
      page,
      [
        [x - 40, y],
        [x + 40, y],
      ],
      [
        [
          [x - 80, y],
          [x + 80, y],
        ],
      ],
    );
    await expect.poll(async () => zoomReadout(page).textContent()).not.toBe("100%");

    // Zoom must never block direct manipulation.
    await captionObject(page).scrollIntoViewIfNeeded();
    const box = (await captionObject(page).boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);

    await expect(captionObject(page)).toHaveAttribute("data-selected", "true");
  });
});
