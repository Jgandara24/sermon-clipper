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

const execFileAsync = promisify(execFile);

process.env.STORAGE_LOCAL_ROOT = path.join(process.cwd(), ".data", "e2e-storage");
process.env.WHISPER_MODEL_PATH = "";

type Fixture = { userId: string; workspaceId: string; clipId: string };

function uniqueKey(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function createTinySourceVideo(outputPath: string) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await execFileAsync("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30:duration=5",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    outputPath,
  ]);
}

async function createFixture(): Promise<Fixture> {
  const user = await prisma.user.create({
    data: { email: `${uniqueKey("undo-redo")}@example.com`, authProvider: AuthProvider.DEV },
  });
  const workspace = await prisma.workspace.create({
    data: {
      name: "Undo Redo Workspace",
      ownerId: user.id,
      minuteBalance: new Prisma.Decimal("60.00"),
    },
  });
  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: user.id, role: WorkspaceRole.OWNER },
  });

  const storage = getStorageProvider();
  const storageKey = `undo-redo/${workspace.id}/source.mp4`;
  await createTinySourceVideo(storage.absolutePath(storageKey));

  const sourceVideo = await prisma.sourceVideo.create({
    data: {
      workspaceId: workspace.id,
      origin: SourceOrigin.UPLOAD,
      filename: "undo-redo-source.mp4",
      durationS: new Prisma.Decimal("5.00"),
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
      name: "Undo Redo Project",
      status: ProjectStatus.READY,
    },
  });

  const transcript = await prisma.transcript.create({
    data: {
      sourceVideoId: sourceVideo.id,
      language: "en",
      provider: "e2e-fixture",
      fullText: "John 14 says peace stays with us.",
    },
  });
  await prisma.transcriptSegment.create({
    data: {
      transcriptId: transcript.id,
      idx: 0,
      startMs: 0,
      endMs: 4000,
      text: "John 14 says peace stays with us.",
      words: [
        { word: "John", startMs: 200, endMs: 500, confidence: 0.99, isFiller: false, deleted: false },
        { word: "14", startMs: 520, endMs: 820, confidence: 0.99, isFiller: false, deleted: false },
        { word: "says", startMs: 900, endMs: 1200, confidence: 0.99, isFiller: false, deleted: false },
        { word: "peace", startMs: 1300, endMs: 1700, confidence: 0.99, isFiller: false, deleted: false },
        { word: "stays", startMs: 1800, endMs: 2200, confidence: 0.99, isFiller: false, deleted: false },
        { word: "with", startMs: 2300, endMs: 2600, confidence: 0.99, isFiller: false, deleted: false },
        { word: "us", startMs: 2700, endMs: 3000, confidence: 0.99, isFiller: false, deleted: false },
      ],
    },
  });

  const clip = await prisma.generatedClip.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      rank: 1,
      startMs: 0,
      endMs: 4000,
      title: "Peace Stays With Us",
      hookText: "Peace stays",
      summary: "A sermon moment used to exercise undo and redo.",
      status: GeneratedClipStatus.SUGGESTED,
    },
  });

  return { userId: user.id, workspaceId: workspace.id, clipId: clip.id };
}

const undoButton = (page: Page) => page.getByRole("button", { name: "Undo" });
const redoButton = (page: Page) => page.getByRole("button", { name: "Redo" });
/** "Face" is a discrete layout choice; its pressed styling is what the assertions read. */
const faceButton = (page: Page) => page.getByRole("button", { name: "Face", exact: true });
const centerButton = (page: Page) => page.getByRole("button", { name: "Center", exact: true });

async function expectSelectedMode(page: Page, label: "Center" | "Face") {
  const selected = label === "Face" ? faceButton(page) : centerButton(page);
  await expect(selected).toHaveClass(/border-teal-700/);
}

/** A transcript correction: the editor's other kind of discrete edit, alongside a layout choice. */
const saysWord = (page: Page) => page.getByRole("button", { name: "says", exact: true });
const saysField = (page: Page) =>
  page.getByRole("textbox", { name: "Correct the word says" });

/** Corrects "says" to "said" and commits it, which is one edit and one history entry. */
async function correctSaysWord(page: Page) {
  await saysWord(page).click();
  await saysField(page).fill("said");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "said", exact: true })).toBeVisible();
}

async function openEditor(page: Page, clipId: string) {
  await page.goto(`/app/clips/${clipId}/editor`);
  await expect(page.getByRole("heading", { name: "Peace Stays With Us" })).toBeVisible();
}

test.describe("Editor undo and redo", () => {
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

  test("both buttons start disabled, with nothing to undo or redo", async ({ page }) => {
    await openEditor(page, fixture.clipId);

    await expect(undoButton(page)).toBeDisabled();
    await expect(redoButton(page)).toBeDisabled();
  });

  test("the buttons step backwards and forwards through edits", async ({ page }) => {
    await openEditor(page, fixture.clipId);
    await expectSelectedMode(page, "Center");

    await faceButton(page).click();
    await expectSelectedMode(page, "Face");
    await expect(undoButton(page)).toBeEnabled();

    await undoButton(page).click();
    await expectSelectedMode(page, "Center");
    await expect(redoButton(page)).toBeEnabled();

    await redoButton(page).click();
    await expectSelectedMode(page, "Face");
    await expect(redoButton(page)).toBeDisabled();
  });

  test("Command+Z and Command+Shift+Z work, as on macOS", async ({ page }) => {
    await openEditor(page, fixture.clipId);

    await faceButton(page).click();
    await expectSelectedMode(page, "Face");

    await page.keyboard.press("Meta+z");
    await expectSelectedMode(page, "Center");

    await page.keyboard.press("Meta+Shift+z");
    await expectSelectedMode(page, "Face");
  });

  test("Control+Z and Control+Y work, as on Windows", async ({ page }) => {
    await openEditor(page, fixture.clipId);

    await faceButton(page).click();
    await expectSelectedMode(page, "Face");

    await page.keyboard.press("Control+z");
    await expectSelectedMode(page, "Center");

    await page.keyboard.press("Control+y");
    await expectSelectedMode(page, "Face");
  });

  test("one trim drag is one undo step", async ({ page }) => {
    await openEditor(page, fixture.clipId);

    const startHandle = page.getByRole("slider", { name: "Clip start" });
    const before = await startHandle.getAttribute("aria-valuenow");

    // A drag with several intermediate moves: the editor must record one entry, not one per move.
    // Scroll first — a box measured off screen sends the pointer events outside the page.
    await startHandle.scrollIntoViewIfNeeded();
    const box = (await startHandle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    for (const offset of [30, 60, 90, 120]) {
      await page.mouse.move(box.x + box.width / 2 + offset, box.y + box.height / 2, { steps: 4 });
    }
    await page.mouse.up();

    await expect
      .poll(async () => startHandle.getAttribute("aria-valuenow"))
      .not.toBe(before);

    await undoButton(page).click();
    await expect.poll(async () => startHandle.getAttribute("aria-valuenow")).toBe(before);
    // One drag, one entry: the stack is empty again.
    await expect(undoButton(page)).toBeDisabled();
  });

  test("an undo is saved, and survives a reload", async ({ page }) => {
    await openEditor(page, fixture.clipId);

    await correctSaysWord(page);
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();

    await undoButton(page).click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();

    const versions = await prisma.clipEdit.findMany({
      where: { clipId: fixture.clipId },
      orderBy: { version: "asc" },
    });
    // The edit and the undo are both written.
    expect(versions.length).toBeGreaterThanOrEqual(2);
    expect(
      (versions.at(-1)!.editorState as { wordEdits: { textOverrides: unknown[] } }).wordEdits
        .textOverrides,
    ).toEqual([]);

    await page.reload();
    await expect(page.getByRole("heading", { name: "Peace Stays With Us" })).toBeVisible();
    // The undo was stored, so the reloaded clip says what was transcribed.
    await expect(saysWord(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "said", exact: true })).toHaveCount(0);
  });

  test("a save acknowledgement neither adds history nor destroys redo", async ({ page }) => {
    await openEditor(page, fixture.clipId);

    await faceButton(page).click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();

    await undoButton(page).click();
    // Wait for the undo's own save to be acknowledged; the redo stack must survive it.
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();

    await expect(redoButton(page)).toBeEnabled();
    await redoButton(page).click();
    await expectSelectedMode(page, "Face");

    // The acknowledgements added no entries of their own: one edit, one step back.
    await undoButton(page).click();
    await expectSelectedMode(page, "Center");
    await expect(undoButton(page)).toBeDisabled();
  });

  test("a new edit after an undo clears the redo stack", async ({ page }) => {
    await openEditor(page, fixture.clipId);

    await faceButton(page).click();
    await undoButton(page).click();
    await expect(redoButton(page)).toBeEnabled();

    await correctSaysWord(page);

    await expect(redoButton(page)).toBeDisabled();
  });
});
