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
import { signInAs, signOutTestSessions } from "./auth-session";
import { getStorageProvider } from "../../src/lib/storage";

const execFileAsync = promisify(execFile);

process.env.STORAGE_LOCAL_ROOT = path.join(process.cwd(), ".data", "e2e-storage");
process.env.WHISPER_MODEL_PATH = "";

type Fixture = { userId: string; workspaceId: string; clipId: string };

const CLIP_START_MS = 0;
const CLIP_END_MS = 4000;

function uniqueKey(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function createTinySourceVideo(outputPath: string) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await execFileAsync("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30:duration=6",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    outputPath,
  ]);
}

async function createFixture(): Promise<Fixture> {
  const user = await prisma.user.create({
    data: { email: `${uniqueKey("playback")}@example.com`, authProvider: AuthProvider.DEV },
  });
  const workspace = await prisma.workspace.create({
    data: {
      name: "Playback Workspace",
      ownerId: user.id,
      minuteBalance: new Prisma.Decimal("60.00"),
    },
  });
  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: user.id, role: WorkspaceRole.OWNER },
  });

  const storage = getStorageProvider();
  const storageKey = `playback/${workspace.id}/source.mp4`;
  await createTinySourceVideo(storage.absolutePath(storageKey));

  const sourceVideo = await prisma.sourceVideo.create({
    data: {
      workspaceId: workspace.id,
      origin: SourceOrigin.UPLOAD,
      filename: "playback-source.mp4",
      durationS: new Prisma.Decimal("6.00"),
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
      name: "Playback Project",
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
      startMs: CLIP_START_MS,
      endMs: CLIP_END_MS,
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
      startMs: CLIP_START_MS,
      endMs: CLIP_END_MS,
      title: "Peace Stays With Us",
      hookText: "Peace stays",
      summary: "A sermon moment used to exercise the transport.",
      status: GeneratedClipStatus.SUGGESTED,
    },
  });

  return { userId: user.id, workspaceId: workspace.id, clipId: clip.id };
}

const position = (page: Page) => page.getByTestId("playback-position");
const playhead = (page: Page) => page.getByRole("slider", { name: "Playhead" });
const centrePlay = (page: Page) => page.getByRole("button", { name: "Play", exact: true });
const transportPlay = (page: Page) => page.getByRole("button", { name: "Play clip" });
const transportPause = (page: Page) => page.getByRole("button", { name: "Pause" });

async function openEditor(page: Page, clipId: string) {
  await page.goto(`/app/clips/${clipId}/editor`);
  await expect(page.getByRole("heading", { name: "Peace Stays With Us" })).toBeVisible();
  await expect(position(page)).toBeVisible();
}

test.describe("Editor playback and transport", () => {
  let fixture: Fixture;

  test.beforeEach(async ({ context }) => {
    fixture = await createFixture();
    await signInAs(context, fixture.userId);
  });

  test.afterEach(async () => {
    await signOutTestSessions();
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

  test("Go to end seeks to the clip end instead of restarting the clip", async ({ page }) => {
    await openEditor(page, fixture.clipId);
    await expect(position(page)).toHaveText("0:00");

    await page.getByRole("button", { name: "Go to end" }).click();

    await expect(position(page)).toHaveText("0:04");
  });

  test("Go to start returns to the clip start", async ({ page }) => {
    await openEditor(page, fixture.clipId);
    await page.getByRole("button", { name: "Go to end" }).click();
    await expect(position(page)).toHaveText("0:04");

    await page.getByRole("button", { name: "Go to start" }).click();

    await expect(position(page)).toHaveText("0:00");
  });

  test("Forward 3 seconds steps, then clamps to the clip end", async ({ page }) => {
    await openEditor(page, fixture.clipId);

    await page.getByRole("button", { name: "Forward 3 seconds" }).click();
    await expect(position(page)).toHaveText("0:03");

    // A second step would run past the clip and into the rest of the service.
    await page.getByRole("button", { name: "Forward 3 seconds" }).click();
    await expect(position(page)).toHaveText("0:04");
  });

  test("Back 3 seconds steps, then clamps to the clip start", async ({ page }) => {
    await openEditor(page, fixture.clipId);
    await page.getByRole("button", { name: "Go to end" }).click();
    await expect(position(page)).toHaveText("0:04");

    await page.getByRole("button", { name: "Back 3 seconds" }).click();
    await expect(position(page)).toHaveText("0:01");

    await page.getByRole("button", { name: "Back 3 seconds" }).click();
    await expect(position(page)).toHaveText("0:00");
  });

  test("clicking the timeline moves the playhead to that time", async ({ page }) => {
    await openEditor(page, fixture.clipId);
    const before = await playhead(page).getAttribute("aria-valuenow");

    const track = page.getByRole("group", { name: "Clip trim timeline" });
    await track.scrollIntoViewIfNeeded();
    const box = (await track.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);

    await expect
      .poll(async () => playhead(page).getAttribute("aria-valuenow"))
      .not.toBe(before);
  });

  test("the playhead can be dragged along the timeline", async ({ page }) => {
    await openEditor(page, fixture.clipId);
    await page.getByRole("button", { name: "Go to start" }).click();

    const handle = playhead(page);
    // Measuring before scrolling reads a box that may be off screen, and the pointer events
    // then land outside the page entirely.
    await handle.scrollIntoViewIfNeeded();
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();

    await expect
      .poll(async () => Number(await handle.getAttribute("aria-valuenow")))
      .toBeGreaterThan(0);
  });

  test("dragging the playhead does not save a new version", async ({ page }) => {
    await openEditor(page, fixture.clipId);
    const versionsBefore = await prisma.clipEdit.count({ where: { clipId: fixture.clipId } });

    const handle = playhead(page);
    await handle.scrollIntoViewIfNeeded();
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => Number(await handle.getAttribute("aria-valuenow"))).toBeGreaterThan(0);

    // Scrubbing changes nothing about the document, so it must not invalidate an approval.
    expect(await prisma.clipEdit.count({ where: { clipId: fixture.clipId } })).toBe(versionsBefore);
  });

  test("the large play icon is hidden while the clip plays", async ({ page }) => {
    await openEditor(page, fixture.clipId);
    await expect(centrePlay(page)).toBeVisible();

    await transportPlay(page).click();

    await expect(centrePlay(page)).toBeHidden();
    await expect(transportPause(page)).toBeVisible();
  });

  test("clicking the video surface toggles play and pause", async ({ page }) => {
    await openEditor(page, fixture.clipId);
    const video = page.locator("video");

    await video.click({ position: { x: 20, y: 20 } });
    await expect(centrePlay(page)).toBeHidden();

    await video.click({ position: { x: 20, y: 20 } });
    await expect(centrePlay(page)).toBeVisible();
  });

  test("playback stops at the clip end and does not loop", async ({ page }) => {
    await openEditor(page, fixture.clipId);
    await page.getByRole("button", { name: "Forward 3 seconds" }).click();
    await expect(position(page)).toHaveText("0:03");

    await transportPlay(page).click();

    // It reaches the end and pauses there; it does not wrap round to 0:00 and keep going.
    await expect(centrePlay(page)).toBeVisible({ timeout: 20_000 });
    await expect(position(page)).toHaveText("0:04");
    expect(await page.locator("video").evaluate((el: HTMLVideoElement) => el.paused)).toBe(true);
  });
});
