import { rm } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { signInAs, signOutTestSessions } from "./auth-session";
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

const handle = (page: Page, corner: string) => page.getByTestId(`canvas-handle-${corner}`);
const centreGuide = (page: Page) => page.getByTestId("centre-guide");
const safeZones = (page: Page) => page.getByTestId("safe-zones");
const undoButton = (page: Page) => page.getByRole("button", { name: "Undo" });
const redoButton = (page: Page) => page.getByRole("button", { name: "Redo" });

/** Drags the caption by a screen offset, in several steps so it reads as a real gesture. */
async function dragCaption(page: Page, dx: number, dy: number) {
  const box = (await captionObject(page).boundingBox())!;
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (const step of [0.3, 0.6, 1]) {
    await page.mouse.move(startX + dx * step, startY + dy * step, { steps: 4 });
  }
  await page.mouse.up();
}

async function waitForSavedBox(clipId: string) {
  await expect
    .poll(async () => (await storedCaptionBox(clipId)) !== null, { timeout: 15_000 })
    .toBe(true);
}

test.describe("Editing canvas — direct manipulation", () => {
  let fixture: CanvasFixture;

  test.beforeEach(async ({ context }) => {
    fixture = await createCanvasFixture(getStorageProvider());
    await signInAs(context, fixture.userId);
  });

  test.afterEach(async () => {
    await signOutTestSessions();
    await destroyCanvasFixture(fixture);
    if (process.env.STORAGE_LOCAL_ROOT) {
      await rm(process.env.STORAGE_LOCAL_ROOT, { recursive: true, force: true });
    }
  });

  test("the caption is selected by clicking it on the video", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    await expect(captionObject(page)).toHaveAttribute("data-selected", "false");

    await captionObject(page).click();

    await expect(captionObject(page)).toHaveAttribute("data-selected", "true");
  });

  test("a selected caption shows four corner handles and no instruction label", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    await captionObject(page).click();

    for (const corner of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
      await expect(handle(page, corner)).toBeVisible();
    }
    // The old canvas carried a label across the object. Direct manipulation does not need one.
    await expect(canvas(page).getByText(/ALL CAPTIONS/i)).toHaveCount(0);
    await expect(canvas(page).getByText(/DRAG/i)).toHaveCount(0);
  });

  test("clicking outside the caption removes the border and handles", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    await captionObject(page).click();
    await expect(handle(page, "top-left")).toBeVisible();

    // A press on the frame itself, well away from the caption.
    const box = (await canvas(page).boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.2);

    await expect(captionObject(page)).toHaveAttribute("data-selected", "false");
    await expect(handle(page, "top-left")).toHaveCount(0);
  });

  test("the caption can be dragged, and the preview follows immediately", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    const before = (await captionObject(page).boundingBox())!;

    await dragCaption(page, -60, -140);

    await expect
      .poll(async () => (await captionObject(page).boundingBox())!.y, { timeout: 5_000 })
      .toBeLessThan(before.y - 40);
    await waitForSavedBox(fixture.clipId);
  });

  test("a drag is saved as a point in the document", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);

    await dragCaption(page, 0, -160);
    await waitForSavedBox(fixture.clipId);

    const saved = (await storedCaptionBox(fixture.clipId))!;
    expect(saved.yPct).toBeGreaterThan(0);
    expect(saved.yPct).toBeLessThan(0.86);
  });

  test("a drag near the centre snaps to it and shows the centre guide", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);

    // Off-centre first, so the snap back to the middle is a real movement.
    await dragCaption(page, -120, 0);
    await waitForSavedBox(fixture.clipId);
    expect((await storedCaptionBox(fixture.clipId))!.xPct).toBeLessThan(0.45);

    const box = (await captionObject(page).boundingBox())!;
    const canvasBox = (await canvas(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + canvasBox.width / 2, box.y + box.height / 2, { steps: 8 });

    await expect(centreGuide(page)).toBeVisible();

    await page.mouse.up();
    // The guide is for the gesture, not a permanent decoration.
    await expect(centreGuide(page)).toHaveCount(0);
    await expect.poll(async () => (await storedCaptionBox(fixture.clipId))!.xPct).toBe(0.5);
  });

  test("the caption is resized from a corner handle", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    await captionObject(page).click();

    const before = (await captionObject(page).boundingBox())!;
    const grip = (await handle(page, "bottom-right").boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + 90, grip.y + 90, { steps: 8 });
    await page.mouse.up();

    await expect
      .poll(async () => (await captionObject(page).boundingBox())!.height, { timeout: 5_000 })
      .toBeGreaterThan(before.height);
    await expect
      .poll(async () => (await storedState(fixture.clipId))?.captions.overrides.sizePx ?? 0)
      .toBeGreaterThan(0);
  });

  test("one drag is one undo step", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    await expect(undoButton(page)).toBeDisabled();

    await dragCaption(page, 0, -150);
    await waitForSavedBox(fixture.clipId);

    // Many pointer frames, one entry: a single undo returns to an unedited document.
    await undoButton(page).click();
    await expect(undoButton(page)).toBeDisabled();
    await expect(redoButton(page)).toBeEnabled();
    await expect.poll(async () => storedCaptionBox(fixture.clipId), { timeout: 15_000 }).toBeNull();

    await redoButton(page).click();
    await expect.poll(async () => (await storedCaptionBox(fixture.clipId)) !== null).toBe(true);
  });

  test("safe-zone guides are shown while editing", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    await expect(safeZones(page)).toHaveCount(0);

    await page.getByLabel("Show safe zones").check();

    await expect(safeZones(page)).toBeVisible();
  });
});

test.describe("Editing canvas — zoom is a view, not a document value", () => {
  let fixture: CanvasFixture;

  test.beforeEach(async ({ context }) => {
    fixture = await createCanvasFixture(getStorageProvider());
    await signInAs(context, fixture.userId);
  });

  test.afterEach(async () => {
    await signOutTestSessions();
    await destroyCanvasFixture(fixture);
    if (process.env.STORAGE_LOCAL_ROOT) {
      await rm(process.env.STORAGE_LOCAL_ROOT, { recursive: true, force: true });
    }
  });

  test("the canvas opens at 100% with reset unavailable", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);

    await expect(zoomReadout(page)).toHaveText("100%");
    await expect(page.getByRole("button", { name: "Reset zoom to 100%" })).toBeDisabled();
  });

  test("the trim timeline is untouched by the canvas", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    const start = await page.getByRole("slider", { name: "Clip start" }).getAttribute("aria-valuenow");
    const end = await page.getByRole("slider", { name: "Clip end" }).getAttribute("aria-valuenow");

    // Canvas zoom and timeline zoom are separate windows onto separate things.
    await dragCaption(page, 40, -80);
    await waitForSavedBox(fixture.clipId);

    await expect(page.getByRole("slider", { name: "Clip start" })).toHaveAttribute(
      "aria-valuenow",
      start!,
    );
    await expect(page.getByRole("slider", { name: "Clip end" })).toHaveAttribute(
      "aria-valuenow",
      end!,
    );
  });

  test("no editing guide or handle can reach an export", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    await page.getByLabel("Show safe zones").check();
    await captionObject(page).click();
    await expect(safeZones(page)).toBeVisible();
    await expect(handle(page, "top-left")).toBeVisible();

    await dragCaption(page, 0, -120);
    await waitForSavedBox(fixture.clipId);

    // The saved document is everything a render is built from. It carries the caption's point and
    // nothing about how the editor was being looked at.
    const state = (await storedState(fixture.clipId))!;
    const serialised = JSON.stringify(state);
    for (const marker of ["zoom", "pan", "guide", "safeZone", "selected", "handle"]) {
      expect(serialised).not.toContain(marker);
    }
    expect(state.captions.overrides.box).not.toBeNull();
  });
});
