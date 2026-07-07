import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import {
  AuthProvider,
  GeneratedClipStatus,
  LedgerKind,
  Prisma,
  ProjectStatus,
  SourceOrigin,
  WorkspaceRole,
} from "@prisma/client";
import { prisma } from "../../src/lib/prisma";
import { DEV_SESSION_COOKIE } from "../../src/lib/auth";
import { getStorageProvider } from "../../src/lib/storage";
import { runOnePendingExportJob } from "../../src/lib/exports/runner";
import { runOnePendingJob } from "../../src/lib/jobs/runner";

const execFileAsync = promisify(execFile);

process.env.STORAGE_LOCAL_ROOT = path.join(process.cwd(), ".data", "e2e-storage");
process.env.WHISPER_MODEL_PATH = "";

type Fixture = {
  userId: string;
  workspaceId: string;
  projectId: string;
  clipId: string;
};

function uniqueKey(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function createTinySourceVideo(outputPath: string, durationS = 5) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await execFileAsync("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=1280x720:rate=30:duration=${durationS}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${durationS}`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    outputPath,
  ]);
}

async function createUserWorkspaceFixture() {
  const user = await prisma.user.create({
    data: {
      email: `${uniqueKey("e2e-phase-67")}@example.com`,
      authProvider: AuthProvider.DEV,
      name: "E2E Volunteer",
    },
  });

  const workspace = await prisma.workspace.create({
    data: {
      name: "E2E Church",
      ownerId: user.id,
      minuteBalance: new Prisma.Decimal("60.00"),
      settings: { churchProfile: { timezone: "America/Chicago", serviceDay: "Sunday" } },
    },
  });

  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: user.id, role: WorkspaceRole.OWNER },
  });

  await prisma.usageLedger.create({
    data: {
      workspaceId: workspace.id,
      kind: LedgerKind.GRANT,
      minutesDelta: new Prisma.Decimal("60.00"),
      balanceAfter: new Prisma.Decimal("60.00"),
      note: "E2E balance",
    },
  });

  await prisma.brandTemplate.create({
    data: {
      workspaceId: workspace.id,
      name: "Sunday Sermon",
      churchName: "E2E Church",
      speakerName: "Pastor E2E",
      primaryColor: "#0f766e",
      accentColor: "#facc15",
      captionPresetId: "clean",
      lowerThird: { headline: "E2E Church", subhead: "Sunday message", showSpeaker: true },
      isDefault: true,
    },
  });

  return { userId: user.id, workspaceId: workspace.id };
}

async function createFixture(): Promise<Fixture> {
  const { userId, workspaceId } = await createUserWorkspaceFixture();
  const storage = getStorageProvider();
  const storageKey = `e2e/${workspaceId}/source.mp4`;
  await createTinySourceVideo(storage.absolutePath(storageKey));

  const sourceVideo = await prisma.sourceVideo.create({
    data: {
      workspaceId,
      origin: SourceOrigin.UPLOAD,
      filename: "e2e-source.mp4",
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
      workspaceId,
      sourceVideoId: sourceVideo.id,
      name: "E2E Sermon Project",
      status: ProjectStatus.READY,
      processingConfig: { genre: "sermon" },
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
      workspaceId,
      projectId: project.id,
      rank: 1,
      startMs: 0,
      endMs: 4000,
      title: "Peace Stays With Us",
      hookText: "Peace stays",
      summary: "A short sermon moment with scripture and pastoral application.",
      status: GeneratedClipStatus.SUGGESTED,
    },
  });

  await prisma.clipScore.create({
    data: {
      workspaceId,
      clipId: clip.id,
      total: 91,
      modelVersion: "e2e-fixture",
      excerpt: "John 14 says peace stays with us.",
      subscores: {
        biblical_usefulness: { score: 92, letter: "A-", note: "References John 14." },
        theological_clarity: { score: 90, letter: "A-", note: "Clear and self-contained." },
        pastoral_tone: { score: 91, letter: "A-", note: "Encouraging tone." },
        scripture_relevance: { score: 95, letter: "A", note: "Detected John 14." },
      },
    },
  });

  await prisma.scriptureReference.create({
    data: {
      workspaceId,
      projectId: project.id,
      clipId: clip.id,
      detectedText: "John 14",
      normalized: "John 14",
      book: "John",
      chapterStart: 14,
      confidence: new Prisma.Decimal("0.80"),
    },
  });

  return { userId, workspaceId, projectId: project.id, clipId: clip.id };
}

async function runPendingProcessingJobs(max = 8) {
  for (let i = 0; i < max; i += 1) {
    const processed = await runOnePendingJob();
    if (!processed) break;
  }
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test.describe("Phase 6/7 browser workflow", () => {
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

  test("applies brand, approves, exports, and downloads a vertical MP4", async ({ page }) => {
    await page.goto(`/app/projects/${fixture.projectId}`);
    await expect(page.getByRole("heading", { name: "Suggested clips" })).toBeVisible();
    await expect(page.getByText("John 14")).toBeVisible();

    await page.getByLabel("Edit this clip").click();
    await expect(page.getByRole("heading", { name: "Peace Stays With Us" })).toBeVisible();
    await page.getByRole("button", { name: "says" }).click();
    await page.getByRole("button", { name: /Sunday Sermon/ }).click();
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await expect(page.getByText(/Send this clip for approval before exporting/i)).toBeVisible();

    await page.goto(`/app/projects/${fixture.projectId}`);
    await page.getByLabel("Send this clip for approval").click();
    await expect(page.getByText(/Approval:/)).toBeVisible();
    await page.getByRole("link", { name: "Open phone review link" }).click();
    await expect(page.getByRole("heading", { name: "Peace Stays With Us" })).toBeVisible();
    await page.getByLabel("Your name").fill("Pastor Reviewer");
    await page.getByRole("button", { name: "Approve clip" }).click();
    await expect(page.getByText("Review saved.")).toBeVisible();
    await expect(page.getByText(/approved/i)).toBeVisible();

    await page.goto(`/app/clips/${fixture.clipId}/editor`);
    const exportButton = page.getByRole("button", { name: "Export 9:16 MP4" });
    await expect(exportButton).toBeEnabled();
    await exportButton.click();
    await expect(page.getByText("Queued for export…")).toBeVisible();

    await expect
      .poll(async () => {
        const job = await prisma.exportJob.findFirst({
          where: { clipId: fixture.clipId },
          orderBy: { createdAt: "desc" },
        });
        return job?.id ?? null;
      })
      .not.toBeNull();

    const processed = await runOnePendingExportJob();
    expect(processed).toBe(true);

    const downloadLink = page.getByRole("link", { name: "Download MP4" });
    await expect(downloadLink).toBeVisible({ timeout: 15_000 });
    const downloadPromise = page.waitForEvent("download");
    await downloadLink.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.mp4$/);
    const downloadedPath = await download.path();
    expect(downloadedPath).toBeTruthy();
  });
});

test.describe("Phase 6/7 upload-to-ranked-clips workflow", () => {
  let fixture: Pick<Fixture, "userId" | "workspaceId">;

  test.beforeEach(async ({ context }) => {
    fixture = await createUserWorkspaceFixture();
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

  test("uploads a sermon and generates ranked scripture-aware clips", async ({ page }) => {
    const videoPath = path.join(process.env.STORAGE_LOCAL_ROOT!, "inputs", `${uniqueKey("upload")}.mp4`);
    await createTinySourceVideo(videoPath, 25);

    await page.goto("/app");
    await page.locator("#video-file").setInputFiles(videoPath);
    await page.locator("#upload-name").fill("Uploaded Sermon E2E");
    await page.getByPlaceholder("Series").first().fill("Peace Series");
    await page.getByPlaceholder("Speaker").first().fill("Pastor E2E");
    await page.getByRole("button", { name: "Upload & process" }).click();
    await expect(page).toHaveURL(/\/app\/projects\/[0-9a-f-]+/);
    await expect(page.getByRole("heading", { name: "Uploaded Sermon E2E" })).toBeVisible();

    await runPendingProcessingJobs();
    await page.reload();
    await expect(page.getByText(/Local speech-to-text is not configured/i)).toBeVisible();

    const srt = `1
00:00:00,000 --> 00:00:25,000
John 14 says peace stays with us because Jesus tells the church not to let their hearts be troubled. This is a complete sermon moment about hope, prayer, grace, and pastoral comfort for anxious people.
`;

    await page.locator('input[type="file"][accept=".srt"]').setInputFiles({
      name: "uploaded-sermon.srt",
      mimeType: "application/x-subrip",
      buffer: Buffer.from(srt),
    });

    await expect(page.getByText(/srt_upload/i)).toBeVisible({ timeout: 10_000 });
    await runPendingProcessingJobs();
    await page.reload();

    await expect(page.getByRole("heading", { name: "Suggested clips" })).toBeVisible();
    await expect(page.getByText("Rank 1")).toBeVisible();
    await expect(page.getByText("John 14").first()).toBeVisible();

    await page.getByRole("button", { name: "Show score breakdown" }).click();
    await expect(page.getByText(/biblical usefulness/i)).toBeVisible();
    await expect(page.getByText(/theological clarity/i)).toBeVisible();
    await expect(page.getByText(/pastoral tone/i)).toBeVisible();
    await expect(page.getByText(/scripture relevance/i)).toBeVisible();
  });
});
