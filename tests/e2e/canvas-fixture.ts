import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, type Page } from "@playwright/test";
import {
  AuthProvider,
  GeneratedClipStatus,
  Prisma,
  ProjectStatus,
  SourceOrigin,
  WorkspaceRole,
} from "@prisma/client";
import { prisma } from "../../src/lib/prisma";
import type { EditorState } from "../../src/lib/editor/types";

const execFileAsync = promisify(execFile);

export const CLIP_START_MS = 0;
export const CLIP_END_MS = 4000;

export type CanvasFixture = { userId: string; workspaceId: string; clipId: string };

export type FixtureWord = { word: string; startMs: number; endMs: number };

/** The words the canvas fixture seeds unless a spec supplies its own. */
export const CANVAS_FIXTURE_WORDS: FixtureWord[] = [
  { word: "Peace", startMs: 0, endMs: 600 },
  { word: "stays", startMs: 600, endMs: 1200 },
  { word: "with", startMs: 1200, endMs: 1800 },
  { word: "us", startMs: 1800, endMs: 2400 },
];

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

/** The 16kHz mono WAV the probe extracts for transcription, from the fixture's own source. */
async function extractFixtureAudio(sourcePath: string, outputPath: string) {
  await execFileAsync("ffmpeg", [
    "-y", "-i", sourcePath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", outputPath,
  ]);
}

/**
 * A clip whose first caption line covers the very start of the range, so the caption object is on
 * screen the moment the editor opens and every canvas gesture has something to act on.
 */
export async function createCanvasFixture(
  storage: { absolutePath: (key: string) => string; size: (key: string) => Promise<number> },
  options: {
    words?: FixtureWord[];
    /** Whether the probe's extracted audio exists. Off by default: most specs never look. */
    audio?: boolean;
    /** Record a source key that has no file behind it, for what the editor does without one. */
    brokenSource?: boolean;
  } = {},
): Promise<CanvasFixture> {
  const words = options.words ?? CANVAS_FIXTURE_WORDS;
  const fullText = words.map((word) => word.word).join(" ");
  const user = await prisma.user.create({
    data: { email: `${uniqueKey("canvas")}@example.com`, authProvider: AuthProvider.DEV },
  });
  const workspace = await prisma.workspace.create({
    data: {
      name: "Canvas Workspace",
      ownerId: user.id,
      minuteBalance: new Prisma.Decimal("60.00"),
    },
  });
  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: user.id, role: WorkspaceRole.OWNER },
  });

  const storageKey = `canvas/${workspace.id}/source.mp4`;
  await createTinySourceVideo(storage.absolutePath(storageKey));
  const audioKey = options.audio ? `canvas/${workspace.id}/source.wav` : null;
  if (audioKey) {
    await extractFixtureAudio(storage.absolutePath(storageKey), storage.absolutePath(audioKey));
  }

  const sourceVideo = await prisma.sourceVideo.create({
    data: {
      workspaceId: workspace.id,
      origin: SourceOrigin.UPLOAD,
      filename: "canvas-source.mp4",
      durationS: new Prisma.Decimal("6.00"),
      sizeBytes: BigInt(await storage.size(storageKey)),
      width: 1280,
      height: 720,
      fps: new Prisma.Decimal("30.000"),
      storageKey: options.brokenSource ? `canvas/${workspace.id}/missing.mp4` : storageKey,
      audioKey,
      language: "en",
    },
  });

  const project = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      sourceVideoId: sourceVideo.id,
      name: "Canvas Project",
      status: ProjectStatus.READY,
    },
  });

  const transcript = await prisma.transcript.create({
    data: {
      sourceVideoId: sourceVideo.id,
      language: "en",
      provider: "e2e-fixture",
      fullText,
    },
  });
  await prisma.transcriptSegment.create({
    data: {
      transcriptId: transcript.id,
      idx: 0,
      startMs: CLIP_START_MS,
      endMs: CLIP_END_MS,
      text: fullText,
      words: words.map((word) => ({
        word: word.word,
        startMs: word.startMs,
        endMs: word.endMs,
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
      title: "Peace Stays With Us",
      hookText: "Peace stays",
      summary: "A sermon moment used to exercise the editing canvas.",
      status: GeneratedClipStatus.SUGGESTED,
    },
  });

  return { userId: user.id, workspaceId: workspace.id, clipId: clip.id };
}

export async function destroyCanvasFixture(fixture: CanvasFixture | undefined) {
  if (fixture?.workspaceId) await prisma.workspace.delete({ where: { id: fixture.workspaceId } });
  if (fixture?.userId) await prisma.user.delete({ where: { id: fixture.userId } });
}

export const canvas = (page: Page) => page.getByTestId("editor-canvas");
/** Exact, because each resize handle is named "... of the Captions" and would match a substring. */
export const captionObject = (page: Page) =>
  page.getByRole("button", { name: "Captions", exact: true });
export const zoomReadout = (page: Page) => page.getByTestId("canvas-zoom");

export async function openCanvasEditor(page: Page, clipId: string) {
  await page.goto(`/app/clips/${clipId}/editor`);
  await expect(page.getByRole("heading", { name: "Peace Stays With Us" })).toBeVisible();
  await expect(canvas(page)).toBeVisible();
  // Scroll first. A box measured off screen sends every pointer and touch event outside the page,
  // which looks exactly like a gesture the component ignored.
  await canvas(page).scrollIntoViewIfNeeded();
  // The caption is only on screen while its line is; the clip opens at 0, inside the first line.
  await expect(captionObject(page)).toBeVisible();
}

/** The saved document, which is where a canvas gesture must and must not show up. */
export async function storedState(clipId: string): Promise<EditorState | null> {
  const edit = await prisma.clipEdit.findFirst({ where: { clipId }, orderBy: { version: "desc" } });
  return edit ? (edit.editorState as unknown as EditorState) : null;
}

export async function storedCaptionBox(clipId: string) {
  return (await storedState(clipId))?.captions.overrides.box ?? null;
}
