import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import {
  AuthProvider,
  GeneratedClipStatus,
  Prisma,
  ProjectStatus,
  SourceOrigin,
  WorkspaceRole,
} from "@prisma/client";
import { prisma } from "../../src/lib/prisma";
import { DEV_SESSION_COOKIE } from "../../src/lib/auth";
import { getStorageProvider } from "../../src/lib/storage";
import { buildDefaultEditorState, wordId, type EditorState } from "../../src/lib/editor/types";

const execFileAsync = promisify(execFile);

process.env.STORAGE_LOCAL_ROOT = path.join(process.cwd(), ".data", "e2e-storage");
process.env.WHISPER_MODEL_PATH = "";

// The clip sits inside a longer service, so both handles have real material to move over: words
// exist before the clip start and after the clip end as well as inside it.
const SOURCE_DURATION_MS = 12_000;
const CLIP_START_MS = 3_000;
const CLIP_END_MS = 8_000;

const WORDS = [
  { word: "Before", startMs: 500, endMs: 900 },
  { word: "Grace", startMs: 3_100, endMs: 3_500 },
  { word: "abounds", startMs: 3_600, endMs: 4_200 },
  { word: "toward", startMs: 4_400, endMs: 4_900 },
  { word: "us", startMs: 6_000, endMs: 6_400 },
  { word: "After", startMs: 9_000, endMs: 9_400 },
];

type Fixture = { userId: string; workspaceId: string; clipId: string; segmentId: string };

function uniqueKey(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function createTinySourceVideo(outputPath: string) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await execFileAsync("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30:duration=12",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    outputPath,
  ]);
}

async function createFixture(): Promise<Fixture> {
  const user = await prisma.user.create({
    data: { email: `${uniqueKey("transcript")}@example.com`, authProvider: AuthProvider.DEV },
  });
  const workspace = await prisma.workspace.create({
    data: {
      name: "Transcript Workspace",
      ownerId: user.id,
      minuteBalance: new Prisma.Decimal("60.00"),
    },
  });
  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: user.id, role: WorkspaceRole.OWNER },
  });

  const storage = getStorageProvider();
  const storageKey = `transcript/${workspace.id}/source.mp4`;
  await createTinySourceVideo(storage.absolutePath(storageKey));

  const sourceVideo = await prisma.sourceVideo.create({
    data: {
      workspaceId: workspace.id,
      origin: SourceOrigin.UPLOAD,
      filename: "transcript-source.mp4",
      durationS: new Prisma.Decimal("12.00"),
      sizeBytes: BigInt(await storage.size(storageKey)),
      width: 1280,
      height: 720,
      fps: new Prisma.Decimal("30.000"),
      storageKey,
      language: "en",
    },
  });

  const project = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      sourceVideoId: sourceVideo.id,
      name: "Transcript Project",
      status: ProjectStatus.READY,
    },
  });

  const transcript = await prisma.transcript.create({
    data: {
      sourceVideoId: sourceVideo.id,
      language: "en",
      provider: "e2e-fixture",
      fullText: WORDS.map((word) => word.word).join(" "),
    },
  });
  const segment = await prisma.transcriptSegment.create({
    data: {
      transcriptId: transcript.id,
      idx: 0,
      startMs: 0,
      endMs: SOURCE_DURATION_MS,
      text: WORDS.map((word) => word.word).join(" "),
      words: WORDS.map((word) => ({
        ...word,
        confidence: 0.99,
        isFiller: false,
        deleted: false,
      })),
    },
  });

  const clip = await prisma.generatedClip.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      rank: 1,
      startMs: CLIP_START_MS,
      endMs: CLIP_END_MS,
      title: "Grace Abounds Toward Us",
      hookText: "Grace abounds",
      summary: "A sermon moment used to exercise the transcript.",
      status: GeneratedClipStatus.SUGGESTED,
    },
  });

  return {
    userId: user.id,
    workspaceId: workspace.id,
    clipId: clip.id,
    segmentId: segment.id,
  };
}

const transcript = (page: Page) => page.getByTestId("transcript");
const word = (page: Page, text: string) =>
  transcript(page).getByRole("button", { name: text, exact: true });
const editing = (page: Page, original: string) =>
  transcript(page).getByRole("textbox", { name: `Correct the word ${original}` });
const restoreButton = (page: Page) =>
  page.getByRole("button", { name: "Restore all deleted words" });
const exportButton = (page: Page) => page.getByRole("button", { name: "Export 9:16 MP4" });
/** The export refusal. Matched on the clause the restore button's own label does not contain. */
const exportRefusal = (page: Page) =>
  page.getByText(/still has words cut out of the middle/);
const playhead = (page: Page) => page.getByRole("slider", { name: "Playhead" });
const startHandle = (page: Page) => page.getByRole("slider", { name: "Clip start" });
const endHandle = (page: Page) => page.getByRole("slider", { name: "Clip end" });

async function openEditor(page: Page, clipId: string) {
  await page.goto(`/app/clips/${clipId}/editor`);
  await expect(page.getByRole("heading", { name: "Grace Abounds Toward Us" })).toBeVisible();
  await expect(word(page, "Grace")).toBeVisible();
}

/**
 * Saves the kind of document the editor could write before word cuts were removed: "abounds" is
 * cut out of the middle of the clip, so a render would splice two pieces together.
 */
async function seedLegacyCut(fixture: Fixture) {
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
        wordEdits: { ...base.wordEdits, deletedWordIds: [wordId(fixture.segmentId, 2)] },
      } as never,
    },
  });
}

/** The stored document, which is the only place a trim or a cut could actually have happened. */
async function storedState(clipId: string): Promise<EditorState | null> {
  const edit = await prisma.clipEdit.findFirst({
    where: { clipId },
    orderBy: { version: "desc" },
  });
  return edit ? (edit.editorState as unknown as EditorState) : null;
}

/** Waits until the correction has actually reached the database, not merely the screen. */
async function waitForStoredOverrides(clipId: string, count: number) {
  await expect
    .poll(async () => (await storedState(clipId))?.wordEdits.textOverrides?.length ?? -1, {
      timeout: 15_000,
    })
    .toBe(count);
}

/** Nudges a trim handle by whole seconds; Shift is the 1,000 ms step. */
async function nudge(
  page: Page,
  handle: "start" | "end",
  key: "ArrowLeft" | "ArrowRight",
  times: number,
) {
  const target = handle === "start" ? startHandle(page) : endHandle(page);
  await target.focus();
  for (let i = 0; i < times; i += 1) {
    await page.keyboard.press(`Shift+${key}`);
  }
}

test.describe("Editor transcript behaviour", () => {
  let fixture: Fixture;

  test.beforeEach(async ({ context }) => {
    fixture = await createFixture();
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
    if (fixture?.workspaceId) {
      await prisma.workspace.delete({ where: { id: fixture.workspaceId } });
    }
    if (fixture?.userId) {
      await prisma.user.delete({ where: { id: fixture.userId } });
    }
    if (process.env.STORAGE_LOCAL_ROOT) {
      await rm(process.env.STORAGE_LOCAL_ROOT, { recursive: true, force: true });
    }
  });

  test("clicking a word seeks to that word's exact timestamp", async ({ page }) => {
    await openEditor(page, fixture.clipId);
    await expect(playhead(page)).toHaveAttribute("aria-valuenow", String(CLIP_START_MS));

    await word(page, "toward").click();

    // 4,400 ms is where "toward" starts — not the nearest second, and not the caption line's start.
    await expect(playhead(page)).toHaveAttribute("aria-valuenow", "4400");
  });

  test("clicking a different word seeks again, to that word", async ({ page }) => {
    await openEditor(page, fixture.clipId);

    await word(page, "toward").click();
    await expect(playhead(page)).toHaveAttribute("aria-valuenow", "4400");

    await word(page, "us").click();
    await expect(playhead(page)).toHaveAttribute("aria-valuenow", "6000");
  });

  test("the selected word is editable in place, with the caret in it", async ({ page }) => {
    await openEditor(page, fixture.clipId);

    await word(page, "abounds").click();

    const field = editing(page, "abounds");
    await expect(field).toBeVisible();
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("abounds");
    // The word became the field; it is not a button sitting next to one.
    await expect(word(page, "abounds")).toHaveCount(0);
  });

  test("selecting a word opens no separate word-action box", async ({ page }) => {
    await openEditor(page, fixture.clipId);
    const buttonsBefore = await transcript(page).getByRole("button").count();

    await word(page, "abounds").click();
    await expect(editing(page, "abounds")).toBeFocused();

    // The old box carried these. Editing in place means none of them come back.
    await expect(page.getByRole("button", { name: /set clip (start|end)/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /close word tools/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^timing/i })).toHaveCount(0);
    // Selecting a word replaces one button with the field. It adds no controls at all.
    await expect(transcript(page).getByRole("button")).toHaveCount(buttonsBefore - 1);
  });

  test("Enter commits once, leaves editing, and takes the caret with it", async ({ page }) => {
    await openEditor(page, fixture.clipId);

    let writes = 0;
    page.on("request", (request) => {
      if (request.method() === "PUT" && request.url().includes("/edit-state")) writes += 1;
    });

    await word(page, "abounds").click();
    const field = editing(page, "abounds");
    await field.fill("abound");
    await page.keyboard.press("Enter");

    // Editing is over the moment Enter lands: no field, so no caret.
    await expect(field).toHaveCount(0);
    await expect(transcript(page).getByRole("textbox")).toHaveCount(0);
    await expect(word(page, "abound")).toBeVisible();

    await waitForStoredOverrides(fixture.clipId, 1);
    // One correction is one write. Committing again on the way out would make it two, and would
    // cost the member an approval for an edit they only made once.
    expect(writes).toBe(1);
  });

  test("a correction survives a reload", async ({ page }) => {
    await openEditor(page, fixture.clipId);

    await word(page, "abounds").click();
    await editing(page, "abounds").fill("abound");
    await page.keyboard.press("Enter");
    await waitForStoredOverrides(fixture.clipId, 1);

    await page.reload();

    await expect(word(page, "abound")).toBeVisible();
    await expect(word(page, "abounds")).toHaveCount(0);
  });

  test("undo restores the transcribed word and redo puts the correction back", async ({ page }) => {
    await openEditor(page, fixture.clipId);

    await word(page, "abounds").click();
    await editing(page, "abounds").fill("abound");
    await page.keyboard.press("Enter");
    await expect(word(page, "abound")).toBeVisible();
    await waitForStoredOverrides(fixture.clipId, 1);

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(word(page, "abounds")).toBeVisible();
    await expect(word(page, "abound")).toHaveCount(0);

    await page.getByRole("button", { name: "Redo" }).click();
    await expect(word(page, "abound")).toBeVisible();
    await expect(word(page, "abounds")).toHaveCount(0);
  });

  test("the whole typed correction is one undo step", async ({ page }) => {
    await openEditor(page, fixture.clipId);

    await word(page, "Grace").click();
    const field = editing(page, "Grace");
    // The field selects its word on open, so typing replaces it. Typed a character at a time:
    // history must keep the whole correction as one entry, not five.
    await field.pressSequentially("Mercy", { delay: 60 });
    await expect(field).toHaveValue("Mercy");
    await page.keyboard.press("Enter");
    await expect(word(page, "Mercy")).toBeVisible();

    await page.getByRole("button", { name: "Undo" }).click();

    await expect(word(page, "Grace")).toBeVisible();
    await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  test("correcting a word never trims or cuts the clip", async ({ page }) => {
    await openEditor(page, fixture.clipId);
    const startBefore = await startHandle(page).getAttribute("aria-valuenow");
    const endBefore = await endHandle(page).getAttribute("aria-valuenow");

    await word(page, "abounds").click();
    await editing(page, "abounds").fill("abound");
    await page.keyboard.press("Enter");
    await waitForStoredOverrides(fixture.clipId, 1);

    await expect(startHandle(page)).toHaveAttribute("aria-valuenow", startBefore!);
    await expect(endHandle(page)).toHaveAttribute("aria-valuenow", endBefore!);
    // Every word the clip had, it still has. A cut would have removed one.
    for (const text of ["Grace", "abound", "toward", "us"]) {
      await expect(word(page, text)).toBeVisible();
    }

    const stored = await storedState(fixture.clipId);
    expect(stored!.source.startMs).toBe(CLIP_START_MS);
    expect(stored!.source.endMs).toBe(CLIP_END_MS);
    expect(stored!.wordEdits.deletedWordIds).toEqual([]);
    expect(stored!.extensions).toEqual([]);
  });

  test("only the text changes: the word keeps its id and its timestamps", async ({ page }) => {
    await openEditor(page, fixture.clipId);

    await word(page, "abounds").click();
    await editing(page, "abounds").fill("abound");
    await page.keyboard.press("Enter");
    await waitForStoredOverrides(fixture.clipId, 1);

    const stored = await storedState(fixture.clipId);
    // "abounds" is the third word of the only segment, so its id is positional and unchanged.
    expect(stored!.wordEdits.textOverrides).toEqual([
      { wordId: `${fixture.segmentId}:2`, text: "abound" },
    ]);

    // The transcript itself is never rewritten — the timestamps a correction could have moved are
    // still exactly what was transcribed.
    const segment = await prisma.transcriptSegment.findUnique({ where: { id: fixture.segmentId } });
    expect(segment!.words).toEqual(
      WORDS.map((entry) => ({ ...entry, confidence: 0.99, isFiller: false, deleted: false })),
    );

    // And the corrected word still sits at its own time.
    await word(page, "abound").click();
    await expect(playhead(page)).toHaveAttribute("aria-valuenow", "3600");
  });

  test("the transcript contracts when the start handle moves inward", async ({ page }) => {
    await openEditor(page, fixture.clipId);
    await expect(word(page, "Grace")).toBeVisible();
    await expect(word(page, "abounds")).toBeVisible();

    // 3,000 ms -> 4,000 ms, past both "Grace" and "abounds".
    await nudge(page, "start", "ArrowRight", 1);

    await expect(word(page, "Grace")).toHaveCount(0);
    await expect(word(page, "abounds")).toHaveCount(0);
    await expect(word(page, "toward")).toBeVisible();
    await expect(word(page, "us")).toBeVisible();
  });

  test("the transcript contracts when the end handle moves inward", async ({ page }) => {
    await openEditor(page, fixture.clipId);
    await expect(word(page, "us")).toBeVisible();

    // 8,000 ms -> 5,000 ms, back past "us".
    await nudge(page, "end", "ArrowLeft", 3);

    await expect(word(page, "us")).toHaveCount(0);
    await expect(word(page, "Grace")).toBeVisible();
    await expect(word(page, "toward")).toBeVisible();
  });

  test("the transcript expands when the start handle extends outward", async ({ page }) => {
    await openEditor(page, fixture.clipId);
    await expect(word(page, "Before")).toHaveCount(0);

    // 3,000 ms -> 0 ms, pulling in material from before the clip.
    await nudge(page, "start", "ArrowLeft", 3);

    await expect(word(page, "Before")).toBeVisible();
    await expect(word(page, "Grace")).toBeVisible();
  });

  test("the transcript expands when the end handle extends outward", async ({ page }) => {
    await openEditor(page, fixture.clipId);
    await expect(word(page, "After")).toHaveCount(0);

    // 8,000 ms -> 10,000 ms, pulling in material from after the clip.
    await nudge(page, "end", "ArrowRight", 2);

    await expect(word(page, "After")).toBeVisible();
    await expect(word(page, "us")).toBeVisible();
  });

  test("a word pulled in by a trim is editable like any other", async ({ page }) => {
    await openEditor(page, fixture.clipId);
    await nudge(page, "end", "ArrowRight", 2);

    await word(page, "After").click();

    await expect(editing(page, "After")).toBeFocused();
    await expect(playhead(page)).toHaveAttribute("aria-valuenow", "9000");
  });
  test("a clip with no cuts offers nothing to restore", async ({ page }) => {
    await openEditor(page, fixture.clipId);

    await expect(restoreButton(page)).toHaveCount(0);
    await expect(page.getByText(/cut words out of the middle/i)).toHaveCount(0);
  });

  test("a clip with legacy cuts offers to restore them", async ({ page }) => {
    await seedLegacyCut(fixture);
    await openEditor(page, fixture.clipId);

    await expect(restoreButton(page)).toBeVisible();
    // The cut word stays visible and struck through, so the clip reads honestly.
    await expect(transcript(page).getByText("abounds")).toHaveClass(/line-through/);
    await expect(word(page, "abounds")).toHaveCount(0);
  });

  test("a clip with legacy cuts cannot be exported", async ({ page }) => {
    await seedLegacyCut(fixture);
    await openEditor(page, fixture.clipId);

    await exportButton(page).click();

    await expect(exportRefusal(page)).toBeVisible();
    // The refusal names the way out, which is the control sitting above it.
    await expect(exportRefusal(page)).toContainText("Restore all deleted words");
    // Refused outright: nothing was queued for any worker to render.
    expect(await prisma.exportJob.count({ where: { clipId: fixture.clipId } })).toBe(0);
  });

  test("restoring the words is saved, and is one undo step", async ({ page }) => {
    await seedLegacyCut(fixture);
    await openEditor(page, fixture.clipId);

    await restoreButton(page).click();

    // Autosaved through the same scheduler every other edit uses.
    await expect
      .poll(async () => (await storedState(fixture.clipId))?.wordEdits.deletedWordIds.length ?? -1, {
        timeout: 15_000,
      })
      .toBe(0);
    await expect(word(page, "abounds")).toBeVisible();
    await expect(restoreButton(page)).toHaveCount(0);

    // One entry: a single undo puts the cut back, and a single redo takes it away again.
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(restoreButton(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();

    await page.getByRole("button", { name: "Redo" }).click();
    await expect(restoreButton(page)).toHaveCount(0);
    await expect(word(page, "abounds")).toBeVisible();
  });

  test("the export is accepted once the words are restored", async ({ page }) => {
    await seedLegacyCut(fixture);
    await openEditor(page, fixture.clipId);

    await exportButton(page).click();
    await expect(exportRefusal(page)).toBeVisible();

    await restoreButton(page).click();
    await expect
      .poll(async () => (await storedState(fixture.clipId))?.wordEdits.deletedWordIds.length ?? -1, {
        timeout: 15_000,
      })
      .toBe(0);

    await exportButton(page).click();

    // Accepted this time: the panel moves on to the queued state and the refusal is gone.
    await expect(page.getByText("Queued for export…")).toBeVisible();
    await expect(exportRefusal(page)).toHaveCount(0);
    expect(await prisma.exportJob.count({ where: { clipId: fixture.clipId } })).toBe(1);
  });
});
