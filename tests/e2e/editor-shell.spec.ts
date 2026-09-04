import { rm } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { signInAs, signOutTestSessions } from "./auth-session";
import { getStorageProvider } from "../../src/lib/storage";
import {
  createCanvasFixture,
  destroyCanvasFixture,
  openCanvasEditor,
  type CanvasFixture,
} from "./canvas-fixture";
import { PANEL_LIMITS, VIDEO_MIN_PX } from "../../src/lib/editor/panel-resize";

process.env.STORAGE_LOCAL_ROOT = path.join(process.cwd(), ".data", "e2e-storage");
process.env.WHISPER_MODEL_PATH = "";

const area = (page: Page, name: "transcript" | "video" | "style" | "timeline") =>
  page.getByTestId(`area-${name}`);
const divider = (page: Page, name: "transcript" | "style") => page.getByTestId(`divider-${name}`);
const videoBox = (page: Page) => page.getByTestId("video-box");

async function box(locator: ReturnType<typeof videoBox>) {
  return (await locator.boundingBox())!;
}

/** Drags a divider by a pixel offset, in steps, like a real gesture. */
async function dragDivider(page: Page, name: "transcript" | "style", dx: number) {
  const handle = divider(page, name);
  await handle.scrollIntoViewIfNeeded();
  const start = await box(handle);
  const x = start.x + start.width / 2;
  const y = start.y + start.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (const step of [0.35, 0.7, 1]) {
    await page.mouse.move(x + dx * step, y, { steps: 4 });
  }
  await page.mouse.up();
}

/**
 * The editor's shell: four named areas, dividers that resize two of them, and a video that stays
 * centred between them. The arithmetic is unit tested; what only a browser can answer is whether
 * the dividers reach the arithmetic and whether the areas end up where they say they are.
 */
test.describe("the editor shell", () => {
  // Three columns with their own minimums are a desktop layout; a narrower window stacks them,
  // which is a different behaviour and not what these tests are about.
  test.use({ viewport: { width: 1600, height: 900 } });

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

  test("names its four areas, each heading centred over its own area", async ({ page }) => {
    for (const [name, heading] of [
      ["transcript", "Transcript"],
      ["video", "Video"],
      ["style", "Style"],
      ["timeline", "Timeline"],
    ] as const) {
      const region = area(page, name);
      await region.scrollIntoViewIfNeeded();
      await expect(region).toBeVisible();

      const label = region.getByRole("heading", { name: heading, exact: true });
      await expect(label).toBeVisible();

      const regionBox = await box(region);
      const labelBox = await box(label);
      const drift = Math.abs(
        labelBox.x + labelBox.width / 2 - (regionBox.x + regionBox.width / 2),
      );
      expect(drift, `${heading} heading is centred`).toBeLessThan(2);
    }
  });

  test("the transcript sits left of the video, and the style panel right of it", async ({
    page,
  }) => {
    const [transcript, video, style] = await Promise.all([
      box(area(page, "transcript")),
      box(area(page, "video")),
      box(area(page, "style")),
    ]);

    expect(transcript.x + transcript.width).toBeLessThanOrEqual(video.x + 1);
    expect(video.x + video.width).toBeLessThanOrEqual(style.x + 1);
    // And the timeline runs under all three.
    const timeline = await box(area(page, "timeline"));
    expect(timeline.y).toBeGreaterThan(video.y);
  });

  test("dragging a divider resizes only its own panel, and the video stays centred", async ({
    page,
  }) => {
    const before = {
      transcript: await box(area(page, "transcript")),
      style: await box(area(page, "style")),
      video: await box(videoBox(page)),
    };
    const columns = await box(page.getByTestId("editor-columns"));
    const centreOf = (b: { x: number; width: number }) => b.x + b.width / 2;
    expect(Math.abs(centreOf(before.video) - centreOf(columns))).toBeLessThan(2);

    await dragDivider(page, "transcript", 80);

    const after = {
      transcript: await box(area(page, "transcript")),
      style: await box(area(page, "style")),
      video: await box(videoBox(page)),
    };
    expect(after.transcript.width).toBeGreaterThan(before.transcript.width + 40);
    // The panel on the other side of the video is untouched.
    expect(Math.round(after.style.width)).toBe(Math.round(before.style.width));
    // And the video is still centred on the page, not on the column it lives in.
    expect(Math.abs(centreOf(after.video) - centreOf(columns))).toBeLessThan(2);
    expect(after.video.width).toBeGreaterThanOrEqual(VIDEO_MIN_PX - 1);
  });

  test("a divider stops at its panel's limit however far the pointer goes", async ({ page }) => {
    await dragDivider(page, "transcript", 4_000);
    const widest = await box(area(page, "transcript"));
    expect(widest.width).toBeLessThanOrEqual(PANEL_LIMITS.transcript.max + 1);

    await dragDivider(page, "transcript", -4_000);
    const narrowest = await box(area(page, "transcript"));
    expect(narrowest.width).toBeGreaterThanOrEqual(PANEL_LIMITS.transcript.min - 1);
  });

  test("a divider answers the arrow keys, for anyone not using a pointer", async ({ page }) => {
    const before = await box(area(page, "style"));

    await divider(page, "style").focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");

    // The Style divider sits on that panel's left edge: pressing left widens it.
    await expect
      .poll(async () => (await box(area(page, "style"))).width)
      .toBeGreaterThan(before.width);
  });

  test("resizing a panel is a view choice, and never writes a version", async ({ page }) => {
    const { prisma } = await import("../../src/lib/prisma");
    const before = await prisma.clipEdit.count({ where: { clipId: fixture.clipId } });

    await dragDivider(page, "style", -60);
    await page.waitForTimeout(2_500);

    expect(await prisma.clipEdit.count({ where: { clipId: fixture.clipId } })).toBe(before);
  });

  test("the header carries every action the editor needs, and says what each does", async ({
    page,
  }) => {
    const header = page.getByTestId("editor-header");
    await expect(header).toBeVisible();

    for (const name of [
      "Back to clips",
      "Undo",
      "Redo",
      "Save changes",
      "Export MP4",
    ]) {
      const action = header.getByRole("button", { name }).or(header.getByRole("link", { name }));
      await expect(action, `${name} is in the header`).toBeVisible();
      await expect(action).toHaveAttribute("title", /\S/);
    }

    // The clip's own title, and whether it is saved, both sit here too.
    await expect(header.getByRole("heading", { name: "Peace Stays With Us" })).toBeVisible();
    await expect(header.getByTestId("save-status")).toBeVisible();
  });

  test("Export is reached from the header and nowhere else", async ({ page }) => {
    // It used to sit at the foot of the Style column, where it was one panel among many.
    await expect(area(page, "style").getByRole("heading", { name: "Export" })).toHaveCount(0);
    await expect(page.getByTestId("export-dialog")).toHaveCount(0);

    await page.getByTestId("editor-header").getByRole("button", { name: "Export MP4" }).click();

    const dialog = page.getByTestId("export-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Export|Start/ }).first()).toBeVisible();

    // Not a modal: the rest of the editor stays reachable, because an export can be refused for
    // something the member has to fix in another panel.
    await expect(
      area(page, "transcript").getByRole("heading", { name: "Script", exact: true }),
    ).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("export-dialog")).toHaveCount(0);
  });

  test("every button in the editor says what it does on hover", async ({ page }) => {
    // A short description on each control, which is the only help a member gets in a dense editor.
    const missing = await page
      .getByTestId("clip-editor")
      .locator("button:visible, a[href]:visible")
      .evaluateAll((elements) =>
        elements
          .filter((element) => !(element.getAttribute("title") ?? "").trim())
          .map(
            (element) =>
              `${element.tagName.toLowerCase()}: ${
                (element.getAttribute("aria-label") || element.textContent || "").trim().slice(0, 40)
              }`,
          ),
      );

    expect(missing, `controls with no hover description: ${missing.join(" | ")}`).toEqual([]);
  });
});
