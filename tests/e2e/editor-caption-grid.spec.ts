import { rm } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { prisma } from "../../src/lib/prisma";
import { buildDefaultEditorState } from "../../src/lib/editor/types";
import { signInAs, signOutTestSessions } from "./auth-session";
import { getStorageProvider } from "../../src/lib/storage";
import {
  CLIP_END_MS,
  CLIP_START_MS,
  canvas,
  captionObject,
  createCanvasFixture,
  destroyCanvasFixture,
  type CanvasFixture,
  type FixtureWord,
} from "./canvas-fixture";

process.env.STORAGE_LOCAL_ROOT = path.join(process.cwd(), ".data", "e2e-storage");
process.env.WHISPER_MODEL_PATH = "";

/**
 * The preview and the burn-in must put a caption on screen for the same stretch, and the burn-in
 * can only state centiseconds. For a Highlighter line with nothing to highlight the preview was
 * still selecting from the line's raw boundaries — 3ms to 1007ms — while the file showed it from
 * 0ms to 1010ms. This drives the real `VideoPreview` through the transport a member uses, so the
 * selector is exercised where it is wired, not only in isolation.
 *
 * The first line runs 3ms to 1007ms. The second starts at 1610ms so that three 200ms nudges back
 * from "with" land exactly on 1010ms, the first millisecond after the quantised end, with nothing
 * else on screen there.
 */
const OFF_GRID_WORDS: FixtureWord[] = [
  { word: "Peace", startMs: 3, endMs: 609 },
  { word: "stays", startMs: 609, endMs: 1007 },
  { word: "with", startMs: 1610, endMs: 2200 },
  { word: "us", startMs: 2200, endMs: 2400 },
];

const transcriptWord = (page: Page, text: string) =>
  page.getByTestId("transcript").getByRole("button", { name: text, exact: true });
const playhead = (page: Page) => page.getByRole("slider", { name: "Playhead" });

/** Opens the editor without asserting a caption is on screen — that is what these tests decide. */
async function openEditor(page: Page, clipId: string) {
  await page.goto(`/app/clips/${clipId}/editor`);
  await expect(page.getByRole("heading", { name: "Peace Stays With Us" })).toBeVisible();
  await expect(canvas(page)).toBeVisible();
  await canvas(page).scrollIntoViewIfNeeded();
  await expect(transcriptWord(page, "Peace")).toBeVisible();
}

/** Seeks through the transport: a transcript word's exact start, then 200ms playhead nudges. */
async function seekTo(page: Page, word: string, nudges: number) {
  await transcriptWord(page, word).click();
  const wordStart = OFF_GRID_WORDS.find((w) => w.word === word)!.startMs;
  await expect(playhead(page)).toHaveAttribute("aria-valuenow", String(wordStart));
  await playhead(page).focus();
  const direction = nudges < 0 ? -1 : 1;
  for (let i = 1; i <= Math.abs(nudges); i += 1) {
    await page.keyboard.press(direction < 0 ? "ArrowLeft" : "ArrowRight");
    // Each nudge is computed from the position the timeline has rendered, so the next press
    // must wait for this one to land or two presses become one step.
    await expect(playhead(page)).toHaveAttribute(
      "aria-valuenow",
      String(wordStart + direction * i * 200),
    );
  }
}

/**
 * The first line retyped to whitespace only, on Highlighter. No control writes
 * `captions.textOverrides`; the document carries it, so it is seeded the way a saved edit would be.
 */
async function seedBlankHighlighterLine(fixture: CanvasFixture) {
  const base = buildDefaultEditorState({
    sourceVideoId: "unused-by-the-editor-page",
    startMs: CLIP_START_MS,
    endMs: CLIP_END_MS,
  });
  await prisma.clipEdit.create({
    data: {
      clipId: fixture.clipId,
      version: 1,
      savedBy: fixture.userId,
      editorState: {
        ...base,
        version: 1,
        captions: {
          presetId: "highlighter",
          overrides: {},
          textOverrides: [{ segmentId: "line-0", text: " \t " }],
        },
      } as never,
    },
  });
}

test.describe("A wordless Highlighter caption sits on the burn-in's grid", () => {
  let fixture: CanvasFixture;

  test.beforeEach(async ({ context }) => {
    fixture = await createCanvasFixture(getStorageProvider(), { words: OFF_GRID_WORDS });
    await seedBlankHighlighterLine(fixture);
    await signInAs(context, fixture.userId);
  });

  test.afterEach(async () => {
    await signOutTestSessions();
    await destroyCanvasFixture(fixture);
    if (process.env.STORAGE_LOCAL_ROOT) {
      await rm(process.env.STORAGE_LOCAL_ROOT, { recursive: true, force: true });
    }
  });

  test("the caption is on screen at 0ms, where the file starts it", async ({ page }) => {
    await openEditor(page, fixture.clipId);

    await page.getByRole("button", { name: "Go to start" }).click();
    await expect(playhead(page)).toHaveAttribute("aria-valuenow", "0");

    // Raw selection said 3ms; the file says 0ms. The preview must agree with the file.
    await expect(captionObject(page)).toBeVisible();
    await expect(page.getByTestId("caption-word")).toHaveCount(0);
  });

  test("the caption is still on screen at 1009ms, where the file still shows it", async ({
    page,
  }) => {
    await openEditor(page, fixture.clipId);

    await seekTo(page, "stays", 2);
    await expect(playhead(page)).toHaveAttribute("aria-valuenow", "1009");

    await expect(captionObject(page)).toBeVisible();
    await expect(page.getByTestId("caption-word")).toHaveCount(0);
  });

  test("the caption is gone at 1010ms, where the file ends it", async ({ page }) => {
    await openEditor(page, fixture.clipId);

    await seekTo(page, "with", -3);
    await expect(playhead(page)).toHaveAttribute("aria-valuenow", "1010");

    await expect(captionObject(page)).toHaveCount(0);

    // One nudge back inside the line, and it returns: the absence above was the edge, not a
    // caption that never rendered.
    await page.keyboard.press("ArrowLeft");
    await expect(playhead(page)).toHaveAttribute("aria-valuenow", "810");
    await expect(captionObject(page)).toBeVisible();
  });
});

test.describe("A legacy preset keeps the line's raw boundaries", () => {
  let fixture: CanvasFixture;

  test.beforeEach(async ({ context }) => {
    // No document saved: the clip opens on Clean, exactly as every clip made before this slice.
    fixture = await createCanvasFixture(getStorageProvider(), { words: OFF_GRID_WORDS });
    await signInAs(context, fixture.userId);
  });

  test.afterEach(async () => {
    await signOutTestSessions();
    await destroyCanvasFixture(fixture);
    if (process.env.STORAGE_LOCAL_ROOT) {
      await rm(process.env.STORAGE_LOCAL_ROOT, { recursive: true, force: true });
    }
  });

  test("Clean shows the caption from 3ms and not at 0ms or 1009ms", async ({ page }) => {
    await openEditor(page, fixture.clipId);
    await expect(page.getByRole("button", { name: "Clean" })).toBeVisible();

    await page.getByRole("button", { name: "Go to start" }).click();
    await expect(playhead(page)).toHaveAttribute("aria-valuenow", "0");
    await expect(captionObject(page)).toHaveCount(0);

    await transcriptWord(page, "Peace").click();
    await expect(playhead(page)).toHaveAttribute("aria-valuenow", "3");
    await expect(captionObject(page)).toBeVisible();

    await seekTo(page, "stays", 2);
    await expect(playhead(page)).toHaveAttribute("aria-valuenow", "1009");
    await expect(captionObject(page)).toHaveCount(0);
  });
});
