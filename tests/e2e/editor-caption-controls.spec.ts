import { rm } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { resolveActiveWord } from "../../src/lib/editor/active-word";
import { buildCaptionLines } from "../../src/lib/editor/caption-lines";
import { getCaptionPreset } from "../../src/lib/editor/caption-presets";
import { generateAssSubtitles } from "../../src/lib/export/ass-generator";
import { signInAs, signOutTestSessions } from "./auth-session";
import { getStorageProvider } from "../../src/lib/storage";
import {
  createCanvasFixture,
  destroyCanvasFixture,
  openCanvasEditor,
  storedState,
  type CanvasFixture,
} from "./canvas-fixture";

process.env.STORAGE_LOCAL_ROOT = path.join(process.cwd(), ".data", "e2e-storage");
process.env.WHISPER_MODEL_PATH = "";

const advancedToggle = (page: Page) => page.getByRole("button", { name: /Advanced styling/ });
const weightSlider = (page: Page) => page.getByRole("slider", { name: "Weight" });
const weightField = (page: Page) => page.getByRole("spinbutton", { name: "Weight value" });
const sizeSlider = (page: Page) => page.getByRole("slider", { name: "Size" });
const sizeField = (page: Page) => page.getByRole("spinbutton", { name: "Size value" });
const captionWords = (page: Page) => page.getByTestId("caption-word");

/** The words the canvas fixture seeds, in order. */
const FIXTURE_WORDS = [
  { word: "Peace", startMs: 0, endMs: 600 },
  { word: "stays", startMs: 600, endMs: 1200 },
  { word: "with", startMs: 1200, endMs: 1800 },
  { word: "us", startMs: 1800, endMs: 2400 },
];

/** Per-word highlighting belongs to Highlighter; Clean renders the line whole, as it always did. */
async function chooseHighlighter(page: Page) {
  await page.getByRole("button", { name: "Highlighter" }).click();
  await expect(captionWords(page).first()).toBeVisible();
}

async function waitForSaved(page: Page) {
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
}

test.describe("Caption controls", () => {
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

  test("the picker offers Clean and Highlighter only", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);

    await expect(page.getByRole("button", { name: "Clean" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Highlighter" })).toBeVisible();
    for (const retired of ["Bold Serif", "Karaoke", "Quiet"]) {
      await expect(page.getByRole("button", { name: retired })).toHaveCount(0);
    }
  });

  test("Font sits in the main Captions section, not behind Advanced styling", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);

    // Visible before anything is expanded.
    await expect(page.getByLabel("Font")).toBeVisible();
  });

  test("there are no X and Y position fields", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    await advancedToggle(page).click();

    for (const label of [/^X$/, /^Y$/, /X position/i, /Y position/i]) {
      await expect(page.getByLabel(label)).toHaveCount(0);
    }
    // Position is the frame-level choice; the exact spot is a drag on the video.
    await expect(page.getByLabel("Position")).toBeVisible();
  });

  test("Advanced styling expands and collapses with a chevron", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);

    await expect(advancedToggle(page)).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByLabel("Highlight colour")).toHaveCount(0);

    await advancedToggle(page).click();
    await expect(advancedToggle(page)).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByLabel("Highlight colour")).toBeVisible();

    await advancedToggle(page).click();
    await expect(advancedToggle(page)).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByLabel("Highlight colour")).toHaveCount(0);
  });

  test("the Weight slider and its number field stay synchronised", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    // Clean sets no weight, so both controls open at the browser's own normal.
    await expect(weightSlider(page)).toHaveValue("400");
    await expect(weightField(page)).toHaveValue("400");

    await weightSlider(page).fill("300");
    await expect(weightField(page)).toHaveValue("300");

    await weightField(page).fill("900");
    await expect(weightSlider(page)).toHaveValue("900");
  });

  test("the Size slider and its number field stay synchronised", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    await expect(sizeSlider(page)).toHaveValue("44");
    await expect(sizeField(page)).toHaveValue("44");

    await sizeSlider(page).fill("120");
    await expect(sizeField(page)).toHaveValue("120");

    await sizeField(page).fill("60");
    await expect(sizeSlider(page)).toHaveValue("60");
  });

  test("a typed value beyond the range is corrected rather than accepted", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);

    await weightField(page).fill("5000");

    await expect(weightField(page)).toHaveValue("900");
    await expect(weightSlider(page)).toHaveValue("900");
  });

  test("a weight change is saved", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);

    await weightSlider(page).fill("300");
    await weightField(page).blur();
    await waitForSaved(page);

    await expect
      .poll(async () => (await storedState(fixture.clipId))?.captions.overrides.weight)
      .toBe(300);
  });

  test("choosing Highlighter saves the preset and highlights in Neon Yellow", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);

    await page.getByRole("button", { name: "Highlighter" }).click();
    await waitForSaved(page);

    expect((await storedState(fixture.clipId))?.captions.presetId).toBe("highlighter");
    await advancedToggle(page).click();
    await expect(page.getByLabel("Highlight colour")).toHaveValue("#ccff00");
  });

  test("all five text cases are offered, and an unedited clip keeps its preset's", async ({
    page,
  }) => {
    await openCanvasEditor(page, fixture.clipId);

    const options = await page.getByLabel("Text case").locator("option").allTextContents();
    expect(options).toEqual([
      "Uppercase",
      "Sentence case",
      "Title Case",
      "lowercase",
      "Original",
    ]);
    // A clip nobody has edited renders exactly as it did before this slice: Clean's own case.
    await expect(page.getByLabel("Text case")).toHaveValue("original");
    await expect(page.getByTestId("caption-line")).toHaveText(/Peace stays with us/);
  });

  test("changing the case re-renders the words", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    await chooseHighlighter(page);

    await page.getByLabel("Text case").selectOption("lowercase");

    await expect(captionWords(page).first()).toHaveText(/^peace$/);
  });

  test("Clean renders the line whole and lights no word", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);

    // Clean is the opening preset and does not animate, so there are no per-word runs at all.
    await expect(captionWords(page)).toHaveCount(0);
    await expect(page.getByTestId("caption-line")).toBeVisible();
  });

  test("an off-step typed weight lands on the step both controls use", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);

    // The slider steps by 100. Chromium silently normalises 350 to 400, so a field that keeps
    // 350 leaves the two controls showing different numbers and saves a third.
    await weightField(page).fill("350");

    await expect(weightField(page)).toHaveValue("400");
    await expect(weightSlider(page)).toHaveValue("400");

    await weightField(page).blur();
    await waitForSaved(page);
    await expect
      .poll(async () => (await storedState(fixture.clipId))?.captions.overrides.weight)
      .toBe(400);
  });
});

test.describe("One highlighted word at a time", () => {
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

  test("exactly one word is highlighted at the opening frame", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    await chooseHighlighter(page);

    const active = page.locator("[data-testid='caption-word'][data-active='true']");
    await expect(captionWords(page)).toHaveCount(4);
    await expect(active).toHaveCount(1);
    await expect(active).toHaveText(/^PEACE$/);
  });

  test("the highlight moves to the word being spoken, one at a time", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    await chooseHighlighter(page);
    const active = page.locator("[data-testid='caption-word'][data-active='true']");

    // Clicking a transcript word seeks to its exact start, so the caption must light that word.
    await page
      .getByTestId("transcript")
      .getByRole("button", { name: "with", exact: true })
      .click();

    await expect(active).toHaveCount(1);
    await expect(active).toHaveText(/^WITH$/);

    await page.getByRole("button", { name: "Go to start" }).click();
    await expect(active).toHaveCount(1);
    await expect(active).toHaveText(/^PEACE$/);
  });

  test("the caption line is laid out at rest spacing", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    await chooseHighlighter(page);
    const line = page.getByTestId("caption-line");

    const spacing = await line.evaluate((node) => {
      const style = getComputedStyle(node);
      return { letter: style.letterSpacing, word: style.wordSpacing };
    });

    // No permanent clearance reserved for a word that is about to pop. Slice 8 owns motion.
    // The browser reports an unset letter-spacing as either "normal" or "0px"; both mean none.
    for (const value of [spacing.letter, spacing.word]) {
      expect(["normal", "0px"]).toContain(value);
    }
  });

  test("highlighting a word does not move the line", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    await chooseHighlighter(page);
    const line = page.getByTestId("caption-line");
    const before = (await line.boundingBox())!;

    await page.getByRole("button", { name: "Forward 3 seconds" }).click();
    await page.getByRole("button", { name: "Go to start" }).click();

    const after = (await line.boundingBox())!;
    // The highlight is a colour, not a layout change.
    expect(Math.abs(after.width - before.width)).toBeLessThan(1);
    expect(Math.abs(after.height - before.height)).toBeLessThan(1);
  });

  test("the burn-in lights the same word the preview is showing", async ({ page }) => {
    await openCanvasEditor(page, fixture.clipId);
    await chooseHighlighter(page);
    await page.getByRole("button", { name: "Highlighter" }).click();
    await waitForSaved(page);
    await page.getByRole("button", { name: "Go to start" }).click();

    const onScreen = await page
      .locator("[data-testid='caption-word'][data-active='true']")
      .textContent();

    // The same transcript, through the same resolver, as the render would use.
    const words = FIXTURE_WORDS.map((word, index) => ({ ...word, id: `w${index}` }));
    const line = buildCaptionLines(words)[0];
    const style = getCaptionPreset("highlighter").style;
    const firstEvent = generateAssSubtitles([line], style, 1080, 1920)
      .split("\n")
      .find((row) => row.startsWith("Dialogue: 0"))!;

    expect(firstEvent).toContain(onScreen!.trim());
    expect(resolveActiveWord(line.words, 0)!.word.toUpperCase()).toBe(onScreen!.trim());
  });
});
