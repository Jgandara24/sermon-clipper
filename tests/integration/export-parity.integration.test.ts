import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  AuthProvider,
  ExportPreset,
  GeneratedClipStatus,
  Prisma,
  PrismaClient,
  ProcessingJobState,
  ProjectStatus,
  RenderQcStatus,
  SourceOrigin,
  WorkspaceRole,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyCaptionTextOverrides, buildCaptionLines } from "@/lib/editor/caption-lines";
import { resolveCaptionStyle } from "@/lib/editor/caption-style";
import { applyTextCase } from "@/lib/editor/text-case";
import { readTitleBanner } from "@/lib/editor/title-banner";
import { buildDefaultEditorState, wordId, type EditorState } from "@/lib/editor/types";
import { applyEditorDeletions, flattenWords, wordsInRange } from "@/lib/editor/words";
import { mapToKeptTimeline } from "@/lib/export/kept-ranges";
import { renderClipExport } from "@/lib/export/render";
import { runExportJob } from "@/lib/exports/handler";
import { buildExportRenderPlan } from "@/lib/exports/render-plan";
import { getStorageProvider } from "@/lib/storage";

const execFileAsync = promisify(execFile);
const prisma = new PrismaClient();

/**
 * Slice 13's export-parity gate.
 *
 * One document, one real MP4, and every claim the editor makes about it checked against the file
 * that comes out: the trim, the caption words and their timing, the caption style and position,
 * the title's style, position and timing, and the audio gain. The ASS script and the frame are
 * both read, because they answer different questions — the script says what the burn-in was told
 * to draw, and the frame says what libass actually drew.
 *
 * Parity, not equality: the assertions here are written against the same pure functions
 * `video-preview.tsx` calls to draw the preview (`buildCaptionLines`, `resolveCaptionStyle`,
 * `readTitleBanner`) and against `buildExportRenderPlan`, which is what a real export renders.
 * A preview that changed without the export following would break these.
 */

const OUT_W = 1080;
const OUT_H = 1920;
const SOURCE_W = 1280;
const SOURCE_H = 720;
/** Whole seconds of source, each a flat colour, so a frame says which source second it came from. */
const SOURCE_SECONDS = 12;
const TRIM_START_MS = 2_000;
const TRIM_END_MS = 8_000;
const TITLE_START_MS = 2_500;
const TITLE_END_MS = 5_500;
const TITLE_TEXT = "PEACE STAYS";

let userId: string;
let workspaceId: string;
let clipId: string;
let sourceStorageKey: string;
let sourceVideoId: string;

function uniqueKey(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * The colour of source second `n`.
 *
 * A ramp in red over a fixed blue, with no green at all: neighbouring seconds are twenty levels
 * apart, which no encode moves a pixel by, and nothing in the ramp comes near the teal the editor
 * draws its centre guide and selection handles in.
 */
function secondColour(second: number): { r: number; g: number; b: number } {
  return { r: 20 + second * 20, g: 0, b: 60 };
}

function hexOfSecond(second: number): string {
  const { r, g, b } = secondColour(second);
  return `0x${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** A source whose picture is a clock: one flat colour per second, plus a tone to carry audio. */
async function createColourClockSource(outputPath: string) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const workDir = await mkdtemp(path.join(os.tmpdir(), "parity-source-"));
  try {
    const parts: string[] = [];
    for (let second = 0; second < SOURCE_SECONDS; second += 1) {
      const partPath = path.join(workDir, `s-${second}.mp4`);
      await execFileAsync("ffmpeg", [
        "-y", "-v", "error",
        "-f", "lavfi",
        "-i", `color=c=${hexOfSecond(second)}:size=${SOURCE_W}x${SOURCE_H}:rate=30:duration=1`,
        "-f", "lavfi",
        "-i", "sine=frequency=440:duration=1",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "12",
        "-c:a", "aac", "-shortest",
        partPath,
      ]);
      parts.push(partPath);
    }
    const listPath = path.join(workDir, "concat.txt");
    await writeFile(listPath, parts.map((p) => `file '${p}'`).join("\n"));
    await execFileAsync("ffmpeg", [
      "-y", "-v", "error",
      "-f", "concat", "-safe", "0", "-i", listPath,
      "-c", "copy",
      outputPath,
    ]);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** Words spread across the whole source, so the trim decides which of them the clip carries. */
const WORDS = [
  { word: "Before", startMs: 500, endMs: 900 },
  { word: "the", startMs: 1_000, endMs: 1_200 },
  { word: "clip", startMs: 1_300, endMs: 1_800 },
  { word: "John", startMs: 2_100, endMs: 2_600 },
  { word: "fourteen", startMs: 2_700, endMs: 3_400 },
  { word: "says", startMs: 3_500, endMs: 4_000 },
  { word: "peace", startMs: 4_200, endMs: 4_800 },
  { word: "stays", startMs: 5_000, endMs: 5_600 },
  { word: "with", startMs: 5_800, endMs: 6_200 },
  { word: "us", startMs: 6_400, endMs: 6_900 },
  { word: "always", startMs: 7_000, endMs: 7_600 },
  { word: "after", startMs: 8_200, endMs: 8_800 },
  { word: "the", startMs: 9_000, endMs: 9_300 },
  { word: "clip", startMs: 9_400, endMs: 9_900 },
].map((word) => ({ ...word, confidence: 0.99, isFiller: false, deleted: false }));

const SEGMENT_ID_HOLDER = { id: "" };

/** The transcript in the shape both the editor helpers and the render plan read. */
function segments() {
  return [
    {
      id: SEGMENT_ID_HOLDER.id,
      startMs: 0,
      endMs: SOURCE_SECONDS * 1_000,
      words: WORDS,
    },
  ];
}

/**
 * The document under test: trimmed, on the Highlighter preset with two overrides, carrying a
 * title, and playing its original audio at half volume.
 *
 * No word deletes: P1.4 refuses an export whose document cuts words out of the middle, so a
 * document with one would never reach a renderer to be checked against.
 */
function parityDocument(sourceVideoId: string, originalVolume: number): EditorState {
  return {
    ...buildDefaultEditorState({
      sourceVideoId,
      startMs: TRIM_START_MS,
      endMs: TRIM_END_MS,
    }),
    captions: {
      presetId: "highlighter",
      overrides: { sizePx: 52, position: "bottom", highlightColor: "#FFE066" },
      textOverrides: [],
    },
    overlays: [
      {
        type: "title",
        id: "title",
        text: TITLE_TEXT,
        startMs: TITLE_START_MS,
        endMs: TITLE_END_MS,
        anchor: "top-safe",
        widthPct: 0.8,
        align: "center",
        textCase: "original",
        fontFamily: "DejaVu Sans",
        sizePx: 64,
        weight: 700,
        color: "#111111",
        backgroundColor: "#FFFFFF",
        border: { widthPx: 0, color: "#111111" },
        shadow: false,
      },
    ],
    audio: { originalVolume },
  };
}

function renderPlanFor(document: EditorState) {
  return buildExportRenderPlan({
    state: document,
    segments: segments(),
    sourceWidth: SOURCE_W,
    sourceHeight: SOURCE_H,
    outputWidth: OUT_W,
    outputHeight: OUT_H,
    brandTemplate: null,
  });
}

/** One export job on this clip, pinned to a saved document. Returns the job and the output key. */
async function exportDocument(document: EditorState, label: string) {
  const version = Math.floor(Math.random() * 1_000_000) + 1;
  await prisma.clipEdit.create({
    data: {
      clipId,
      version,
      editorState: document as unknown as Prisma.InputJsonValue,
    },
  });
  const job = await prisma.exportJob.create({
    data: {
      clipId,
      workspaceId,
      preset: ExportPreset.MP4_1080,
      state: ProcessingJobState.RUNNING,
      filename: `${label}.mp4`,
      idempotencyKey: uniqueKey(label),
      editVersion: version,
      attempt: 1,
      startedAt: new Date(),
    },
  });
  const exportedFileId = await runExportJob(prisma, job);
  const storage = getStorageProvider();
  const key = `exports/${workspaceId}/${job.id}.mp4`;
  return {
    jobId: job.id,
    exportedFileId,
    filePath: storage.absolutePath(key),
  };
}

type Probe = {
  width: number;
  height: number;
  durationS: number;
  hasAudio: boolean;
};

async function probe(filePath: string): Promise<Probe> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-print_format", "json",
    "-show_streams", "-show_format",
    filePath,
  ]);
  const parsed = JSON.parse(stdout) as {
    streams: Array<{ codec_type: string; width?: number; height?: number }>;
    format: { duration: string };
  };
  const video = parsed.streams.find((stream) => stream.codec_type === "video");
  return {
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    durationS: Number(parsed.format.duration),
    hasAudio: parsed.streams.some((stream) => stream.codec_type === "audio"),
  };
}

/** One frame of the output, as raw RGB. */
async function frameAt(filePath: string, atS: number): Promise<Buffer> {
  const { stdout } = await execFileAsync(
    "ffmpeg",
    [
      "-v", "error",
      "-ss", atS.toFixed(3),
      "-i", filePath,
      "-frames:v", "1",
      "-f", "rawvideo", "-pix_fmt", "rgb24",
      "-",
    ],
    { encoding: "buffer", maxBuffer: 1 << 28 },
  );
  return stdout as unknown as Buffer;
}

function pixelAt(frame: Buffer, x: number, y: number) {
  const offset = (y * OUT_W + x) * 3;
  return { r: frame[offset], g: frame[offset + 1], b: frame[offset + 2] };
}

/** The overall RMS level of a file's audio, in dBFS, as ffmpeg's astats reports it. */
async function rmsLevelDb(filePath: string): Promise<number> {
  const { stderr } = await execFileAsync(
    "ffmpeg",
    [
      "-v", "info",
      "-i", filePath,
      "-af", "astats=measure_perchannel=none:measure_overall=RMS_level",
      "-f", "null", "-",
    ],
    { maxBuffer: 1 << 26 },
  );
  const match = /RMS level dB:\s*(-?\d+(?:\.\d+)?)/.exec(stderr);
  if (!match) throw new Error(`astats reported no RMS level for ${path.basename(filePath)}`);
  return Number(match[1]);
}

async function sha256(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

type AssEvent = { start: string; end: string; style: string; text: string };

function assEvents(assContent: string): AssEvent[] {
  const events: AssEvent[] = [];
  for (const line of assContent.split(/\r?\n/)) {
    if (!line.startsWith("Dialogue:")) continue;
    const fields = line.slice("Dialogue:".length).split(",");
    events.push({
      start: fields[1].trim(),
      end: fields[2].trim(),
      style: fields[3].trim(),
      text: fields.slice(9).join(","),
    });
  }
  return events;
}

function assStyleLine(assContent: string, name: string): string[] {
  const line = assContent
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(`Style: ${name},`));
  if (!line) throw new Error(`no ${name} style in the generated script`);
  return line.slice("Style: ".length).split(",");
}

function assTimeToMs(time: string): number {
  const [hours, minutes, seconds] = time.split(":");
  return (
    Number(hours) * 3_600_000 + Number(minutes) * 60_000 + Math.round(Number(seconds) * 1_000)
  );
}

beforeAll(async () => {
  process.env.STORAGE_LOCAL_ROOT = path.join(process.cwd(), ".data", "export-parity-storage");

  const user = await prisma.user.create({
    data: { email: `${uniqueKey("parity")}@example.com`, authProvider: AuthProvider.DEV },
  });
  userId = user.id;

  const workspace = await prisma.workspace.create({
    data: { name: "Export parity", ownerId: user.id, minuteBalance: new Prisma.Decimal("60.00") },
  });
  workspaceId = workspace.id;
  await prisma.workspaceMember.create({
    data: { workspaceId, userId, role: WorkspaceRole.OWNER },
  });

  const storage = getStorageProvider();
  sourceStorageKey = `export-parity/${workspaceId}/clock.mp4`;
  await createColourClockSource(storage.absolutePath(sourceStorageKey));

  const sourceVideo = await prisma.sourceVideo.create({
    data: {
      workspaceId,
      origin: SourceOrigin.UPLOAD,
      filename: "clock.mp4",
      durationS: new Prisma.Decimal(SOURCE_SECONDS.toFixed(2)),
      sizeBytes: BigInt(await storage.size(sourceStorageKey)),
      width: SOURCE_W,
      height: SOURCE_H,
      fps: new Prisma.Decimal("30.000"),
      storageKey: sourceStorageKey,
      language: "en",
    },
  });

  const project = await prisma.project.create({
    data: {
      workspaceId,
      sourceVideoId: sourceVideo.id,
      name: "Export parity",
      status: ProjectStatus.READY,
    },
  });

  const transcript = await prisma.transcript.create({
    data: {
      sourceVideoId: sourceVideo.id,
      language: "en",
      provider: "integration-fixture",
      fullText: WORDS.map((word) => word.word).join(" "),
    },
  });
  const segment = await prisma.transcriptSegment.create({
    data: {
      transcriptId: transcript.id,
      idx: 0,
      startMs: 0,
      endMs: SOURCE_SECONDS * 1_000,
      text: WORDS.map((word) => word.word).join(" "),
      words: WORDS,
    },
  });
  SEGMENT_ID_HOLDER.id = segment.id;
  sourceVideoId = sourceVideo.id;

  const clip = await prisma.generatedClip.create({
    data: {
      workspaceId,
      projectId: project.id,
      rank: 1,
      startMs: TRIM_START_MS,
      endMs: TRIM_END_MS,
      title: "Peace Stays With Us",
      hookText: "Peace stays",
      summary: "A clip used to prove the exported file matches the document the editor shows.",
      status: GeneratedClipStatus.SUGGESTED,
    },
  });
  clipId = clip.id;
}, 300_000);

afterAll(async () => {
  if (workspaceId) await prisma.workspace.delete({ where: { id: workspaceId } });
  if (userId) await prisma.user.delete({ where: { id: userId } });
  if (process.env.STORAGE_LOCAL_ROOT) {
    await rm(process.env.STORAGE_LOCAL_ROOT, { recursive: true, force: true });
  }
  await prisma.$disconnect();
});

describe("one real export, checked against the document the editor shows", () => {
  let filePath: string;
  let jobId: string;
  let plan: ReturnType<typeof renderPlanFor>;
  let document: EditorState;

  beforeAll(async () => {
    document = parityDocument(sourceVideoId, 0.5);
    plan = renderPlanFor(document);
    const exported = await exportDocument(document, "parity");
    filePath = exported.filePath;
    jobId = exported.jobId;
  }, 300_000);

  it("is a 9:16 MP4 that decodes, carries audio, and passed render QC", async () => {
    const probed = await probe(filePath);

    expect(probed.width).toBe(OUT_W);
    expect(probed.height).toBe(OUT_H);
    expect(probed.width * 16).toBe(probed.height * 9);
    expect(probed.hasAudio).toBe(true);

    const job = await prisma.exportJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.qcStatus).toBe(RenderQcStatus.PASSED);
    const details = job.qcDetails as { checks: Array<{ name: string; passed: boolean }> };
    expect(details.checks.every((check) => check.passed)).toBe(true);
  }, 120_000);

  it("is as long as the trim, and no longer", async () => {
    const probed = await probe(filePath);

    // The document's own arithmetic, not a number copied into the test.
    expect(plan.outputDurationS).toBeCloseTo((TRIM_END_MS - TRIM_START_MS) / 1_000, 6);
    expect(plan.keptRanges).toEqual([{ startMs: TRIM_START_MS, endMs: TRIM_END_MS }]);
    expect(probed.durationS).toBeGreaterThan(plan.outputDurationS - 0.5);
    expect(probed.durationS).toBeLessThan(plan.outputDurationS + 0.5);
    // And shorter than the source it was cut from, which is the point of a trim.
    expect(probed.durationS).toBeLessThan(SOURCE_SECONDS - 1);
  }, 120_000);

  it("starts where the trim starts: every output second shows its own source second", async () => {
    // The source's picture is a clock. If the render began at zero, or drifted, the colour under
    // the caption would name a different source second than the trim asked for.
    for (let outputSecond = 0; outputSecond < (TRIM_END_MS - TRIM_START_MS) / 1_000; outputSecond += 1) {
      const frame = await frameAt(filePath, outputSecond + 0.5);
      // Top-left of the frame: above the title's safe-area anchor and far from the captions.
      const pixel = pixelAt(frame, 40, 40);
      const expected = secondColour(TRIM_START_MS / 1_000 + outputSecond);

      expect(Math.abs(pixel.r - expected.r)).toBeLessThanOrEqual(8);
      expect(Math.abs(pixel.g - expected.g)).toBeLessThanOrEqual(8);
      expect(Math.abs(pixel.b - expected.b)).toBeLessThanOrEqual(8);
    }
  }, 300_000);

  it("burns in exactly the words the trim kept, and none of the words it cut", () => {
    const kept = wordsInRange(
      flattenWords(segments()),
      document.source.startMs,
      document.source.endMs,
    );
    const keptWords = kept.map((word) => word.word);

    expect(keptWords).toEqual(["John", "fourteen", "says", "peace", "stays", "with", "us", "always"]);

    const captionText = assEvents(plan.assContent)
      .filter((event) => event.style === "Default")
      .map((event) => event.text)
      .join(" ");

    // The preset upper-cases, so the file spells the words the way the preview shows them. Read
    // through the same resolver rather than assuming either case.
    const style = resolveCaptionStyle(document.captions.presetId, document.captions.overrides);
    for (const word of keptWords) {
      expect(captionText).toContain(applyTextCase(word, style.textCase));
    }
    // The words on either side of the trim are in the transcript and must not be in the file.
    for (const word of ["Before", "after"]) {
      expect(captionText.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  it("times its captions on the output timeline, the way the preview does", () => {
    // The preview builds its lines with these two calls; so does the burn-in.
    const activeWords = applyEditorDeletions(
      wordsInRange(flattenWords(segments()), document.source.startMs, document.source.endMs),
      document,
    ).filter((word) => !word.effectiveDeleted);
    const previewLines = applyCaptionTextOverrides(
      buildCaptionLines(
        activeWords.map((word) => ({
          id: word.id,
          word: word.word,
          startMs: word.startMs,
          endMs: word.endMs,
        })),
      ),
      document.captions.textOverrides,
    );

    const captionEvents = assEvents(plan.assContent).filter((event) => event.style === "Default");
    expect(captionEvents.length).toBeGreaterThan(0);

    const expectedSpan = {
      startMs: mapToKeptTimeline(previewLines[0].startMs, plan.keptRanges),
      endMs: mapToKeptTimeline(previewLines[previewLines.length - 1].endMs, plan.keptRanges),
    };
    const actualSpan = {
      startMs: Math.min(...captionEvents.map((event) => assTimeToMs(event.start))),
      endMs: Math.max(...captionEvents.map((event) => assTimeToMs(event.end))),
    };

    // Centisecond resolution in ASS, so a rounded edge is the only difference allowed.
    expect(Math.abs(actualSpan.startMs - expectedSpan.startMs)).toBeLessThanOrEqual(10);
    expect(Math.abs(actualSpan.endMs - expectedSpan.endMs)).toBeLessThanOrEqual(10);

    // Every event sits inside the rendered file, not past its end.
    for (const event of captionEvents) {
      expect(assTimeToMs(event.start)).toBeGreaterThanOrEqual(0);
      expect(assTimeToMs(event.end)).toBeLessThanOrEqual(plan.outputDurationS * 1_000 + 10);
    }

    // The first caption starts at zero on the output timeline only if the first kept word does;
    // it does not here, and a burn-in that ignored the remap would put it at 2.1s instead.
    expect(expectedSpan.startMs).toBeLessThan(previewLines[0].startMs);
  });

  it("draws the caption in the style and at the position the document resolves to", () => {
    const style = resolveCaptionStyle(document.captions.presetId, document.captions.overrides);
    const [name, , fontSize, , , , , bold] = assStyleLine(plan.assContent, "Default");

    expect(name).toBe("Default");
    expect(Number(fontSize)).toBe(style.sizePx);
    expect(Number(fontSize)).toBe(52);
    expect(bold).toBe((style.weight ?? 400) >= 600 ? "-1" : "0");

    // Alignment field 19 of the style line: bottom-centre is 2. The document says "bottom".
    const alignment = assStyleLine(plan.assContent, "Default")[18];
    expect(style.position).toBe("bottom");
    expect(alignment).toBe("2");

    // The Highlighter preset lights the active word, and the document overrides its colour. The
    // override has to reach the file, or the preview and the burn-in light different colours.
    expect(style.highlightColor).toBe("#FFE066");
    expect(plan.assContent.toUpperCase()).toContain("H0066E0FF");
  });

  it("draws the title with the document's own style, position and timing", () => {
    const banner = readTitleBanner(document.overlays);
    if (!banner) throw new Error("the parity document carries a title");

    const [name, family, fontSize] = assStyleLine(plan.assContent, "Title");
    expect(name).toBe("Title");
    expect(family).toBe(banner.fontFamily);
    expect(Number(fontSize)).toBe(banner.sizePx);

    const titleEvents = assEvents(plan.assContent).filter((event) => event.style === "Title");
    expect(titleEvents.length).toBeGreaterThan(0);

    const expectedStartMs = mapToKeptTimeline(banner.startMs, plan.keptRanges);
    const expectedEndMs = mapToKeptTimeline(banner.endMs, plan.keptRanges);
    expect(expectedStartMs).toBe(TITLE_START_MS - TRIM_START_MS);
    expect(expectedEndMs).toBe(TITLE_END_MS - TRIM_START_MS);

    for (const event of titleEvents) {
      expect(assTimeToMs(event.start)).toBeGreaterThanOrEqual(expectedStartMs - 10);
      expect(assTimeToMs(event.end)).toBeLessThanOrEqual(expectedEndMs + 10);
    }
    // Its text is drawn, and it is anchored rather than left to flow.
    expect(titleEvents.some((event) => event.text.includes(TITLE_TEXT))).toBe(true);
    expect(titleEvents.every((event) => event.text.includes("\\pos("))).toBe(true);
  });

  it("shows the title while it is timed to be on screen, and nothing after it", async () => {
    const banner = readTitleBanner(document.overlays);
    if (!banner) throw new Error("the parity document carries a title");
    const onScreenAtS = (mapToKeptTimeline(banner.startMs, plan.keptRanges) + 500) / 1_000;
    const afterS = (mapToKeptTimeline(banner.endMs, plan.keptRanges) + 700) / 1_000;

    // The title's background is white, and nothing else in this render is.
    const whitePixels = (frame: Buffer) => {
      let count = 0;
      for (let y = 100; y < 700; y += 4) {
        for (let x = 0; x < OUT_W; x += 4) {
          const { r, g, b } = pixelAt(frame, x, y);
          if (r > 230 && g > 230 && b > 230) count += 1;
        }
      }
      return count;
    };

    expect(whitePixels(await frameAt(filePath, onScreenAtS))).toBeGreaterThan(100);
    expect(whitePixels(await frameAt(filePath, afterS))).toBe(0);
  }, 180_000);
});

/**
 * Audio volume is the newest thing in the document to reach both renderers, and the one with no
 * pixels to check. `audio.originalVolume` sets the preview's video element volume and, in the
 * export, a `volume` filter after loudnorm — so the claim to prove is arithmetic: half is half.
 */
describe("the document's original volume reaches the file", () => {
  let atFullVolume: string;
  let atHalfVolume: string;

  beforeAll(async () => {
    atFullVolume = (await exportDocument(parityDocument(sourceVideoId, 1), "volume-full")).filePath;
    atHalfVolume = (await exportDocument(parityDocument(sourceVideoId, 0.5), "volume-half")).filePath;
  }, 300_000);

  it("renders a 0.5 document quieter than a 1.0 one by exactly the ratio", async () => {
    const full = await rmsLevelDb(atFullVolume);
    const half = await rmsLevelDb(atHalfVolume);

    // A gain of 0.5 is -6.02dB. The gain is applied after loudnorm, so nothing normalises it away:
    // before that decision it would have been, and these two files would have measured the same.
    const expectedDrop = 20 * Math.log10(0.5);
    expect(half - full).toBeCloseTo(expectedDrop, 1);
  }, 180_000);

  it("renders a 1.0 document byte-for-byte as it rendered before the control existed", async () => {
    // "Before" is not a description: it is `originalVolume: undefined`, the argument shape that
    // predates the control, which buildExportAudioFilter turns into a bare loudnorm. A 1.0
    // document must take that same path, or every clip a church already approved re-renders.
    const plan = renderPlanFor(parityDocument(sourceVideoId, 1));
    const storage = getStorageProvider();
    const workDir = await mkdtemp(path.join(os.tmpdir(), "parity-before-"));
    try {
      const beforePath = path.join(workDir, "before.mp4");
      await renderClipExport({
        sourceFilePath: storage.absolutePath(sourceStorageKey),
        keptRanges: plan.keptRanges,
        cropPixels: plan.cropPixels,
        assFileContent: plan.assContent,
        outputPath: beforePath,
        outputWidth: OUT_W,
        outputHeight: OUT_H,
        originalVolume: undefined,
      });

      expect(await sha256(beforePath)).toBe(await sha256(atFullVolume));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }, 300_000);
});

/**
 * The editor draws selection handles, safe-zone guides and a centre guide over the video. None of
 * them can reach an export, because the burn-in is an ASS subtitle file and an ASS file has no
 * notion of them — but "cannot" is the kind of claim that stops being true quietly, so it is
 * checked from both ends: what the script was told to draw, and what came out of libass.
 */
describe("no editor chrome reaches the MP4", () => {
  let filePath: string;
  let plan: ReturnType<typeof renderPlanFor>;

  beforeAll(async () => {
    const document = parityDocument(sourceVideoId, 1);
    plan = renderPlanFor(document);
    filePath = (await exportDocument(document, "chrome")).filePath;
  }, 300_000);

  it("emits caption and title events, and no other kind", () => {
    const styles = new Set(assEvents(plan.assContent).map((event) => event.style));

    expect([...styles].sort()).toEqual(["Default", "Title"]);
  });

  it("declares no style the editor's guides could be drawn in", () => {
    const declared = plan.assContent
      .split(/\r?\n/)
      .filter((line) => line.startsWith("Style: "))
      .map((line) => line.slice("Style: ".length).split(",")[0]);

    // LowerThird is declared for every clip and drawn only when a brand template asks for it.
    expect(declared.sort()).toEqual(["Default", "LowerThird", "Title"]);
  });

  it("draws no guide colour anywhere in a frame", async () => {
    // The editor's centre guide and selection handles are teal-300 and teal-700. The source is a
    // red-over-blue ramp with no green in it at all, so either colour in the file came from
    // somewhere it should not have.
    //
    // This catches a filled shape — a handle, a tinted band. It does not catch a one-pixel line:
    // 4:2:0 chroma subsampling averages a thin line's colour into its neighbours and it lands
    // near-grey, measured. The two tests below are what catch those.
    const TEAL_300 = { r: 94, g: 234, b: 212 };
    const TEAL_700 = { r: 15, g: 118, b: 110 };
    const frame = await frameAt(filePath, 4.5);

    let nearTeal = 0;
    for (let y = 0; y < OUT_H; y += 1) {
      for (let x = 0; x < OUT_W; x += 1) {
        const pixel = pixelAt(frame, x, y);
        for (const teal of [TEAL_300, TEAL_700]) {
          const distance =
            Math.abs(pixel.r - teal.r) + Math.abs(pixel.g - teal.g) + Math.abs(pixel.b - teal.b);
          if (distance < 60) nearTeal += 1;
        }
      }
    }

    expect(nearTeal).toBe(0);
  }, 180_000);

  it("leaves the picture untouched everywhere the captions and title are not", async () => {
    // At 4.5s the title has been gone for a second and the captions sit on the bottom band, so
    // every pixel from the top of the frame down to the captions should still be the flat source
    // colour. A safe-zone rectangle, a centre guide, a selection box or a red band tint would all
    // land inside this region.
    const frame = await frameAt(filePath, 4.5);
    const expected = secondColour(TRIM_START_MS / 1_000 + 4);
    const strays: string[] = [];

    // Every pixel, not a sample of them: the safe-zone rectangle's edges are one pixel wide, and
    // a stride would step straight over them.
    for (let y = 20; y < 1_600 && strays.length < 8; y += 1) {
      for (let x = 0; x < OUT_W; x += 1) {
        const pixel = pixelAt(frame, x, y);
        const off =
          Math.abs(pixel.r - expected.r) > 10 ||
          Math.abs(pixel.g - expected.g) > 10 ||
          Math.abs(pixel.b - expected.b) > 10;
        if (off) {
          strays.push(`(${x},${y}) rgb(${pixel.r},${pixel.g},${pixel.b})`);
          break;
        }
      }
    }

    expect(strays).toEqual([]);
  }, 180_000);

  it("draws nothing down the centre column that its neighbours do not", async () => {
    // The centre guide is one pixel wide at the exact middle of the frame, so it would hide inside
    // any tolerance that looked at a region. This looks at the column itself.
    const frame = await frameAt(filePath, 4.5);
    const centre = OUT_W / 2;

    for (let y = 200; y < 1_500; y += 25) {
      const middle = pixelAt(frame, centre, y);
      const left = pixelAt(frame, centre - 6, y);
      const right = pixelAt(frame, centre + 6, y);

      expect(Math.abs(middle.r - left.r)).toBeLessThanOrEqual(4);
      expect(Math.abs(middle.g - left.g)).toBeLessThanOrEqual(4);
      expect(Math.abs(middle.b - left.b)).toBeLessThanOrEqual(4);
      expect(Math.abs(middle.r - right.r)).toBeLessThanOrEqual(4);
    }
  }, 180_000);
});
