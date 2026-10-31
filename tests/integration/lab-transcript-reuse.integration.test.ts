import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { runTranscribeJob } from "@/lib/jobs/handlers/transcribe";
import * as transcriptionProviders from "@/lib/transcription";
import { getStorageProvider } from "@/lib/storage";

// Lab option A (2026-10-20): a lab project copies the transcript of an earlier lab source of the
// same video, so a lab round pays for no transcription. It also runs option B for real: about 2,600
// lines with their words, written in batched queries inside the 5-second transaction.
const prisma = new PrismaClient();
const cleanup: { workspaceId: string; userId: string }[] = [];
const URL = "https://www.youtube.com/watch?v=OuXJo09MZWk";
const LINES = 2_600;
beforeAll(async () => { await prisma.$connect(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => {
  for (const row of cleanup) {
    await prisma.workspace.delete({ where: { id: row.workspaceId } });
    await prisma.user.delete({ where: { id: row.userId } });
  }
  await prisma.$disconnect();
});

const wordsOf = (i: number) => Array.from({ length: 12 }, (_, w) => ({
  word: `word${w}`, startMs: i * 2_000 + w * 150, endMs: i * 2_000 + w * 150 + 140, confidence: 0.97, isFiller: false, deleted: false,
}));

async function seed(target: { originUrl: string; durationS: number }) {
  const user = await prisma.user.create({ data: { email: `lab-reuse-${randomUUID()}@example.test`, authProvider: "DEV" } });
  const workspace = await prisma.workspace.create({ data: { ownerId: user.id, name: "Lab reuse fixture" } });
  cleanup.push({ workspaceId: workspace.id, userId: user.id });
  const from = await prisma.sourceVideo.create({ data: { workspaceId: workspace.id, origin: "URL", originUrl: URL, durationS: 5_116.76, audioKey: `from-${randomUUID()}.wav` } });
  const transcript = await prisma.transcript.create({ data: {
    sourceVideoId: from.id, language: "en", provider: "elevenlabs_scribe_v2", fullText: "Grace.",
  } });
  await prisma.transcriptSegment.createMany({ data: Array.from({ length: LINES }, (_, i) => ({
    transcriptId: transcript.id, idx: i, startMs: i * 2_000, endMs: i * 2_000 + 1_900, text: `Line ${i}.`, words: wordsOf(i),
  })) });
  const source = await prisma.sourceVideo.create({ data: { workspaceId: workspace.id, origin: "URL", ...target, audioKey: `to-${randomUUID()}.wav` } });
  const project = await prisma.project.create({ data: {
    workspaceId: workspace.id, sourceVideoId: source.id, name: "Lab reuse", status: "READY",
    processingConfig: { genre: "sermon", labTranscriptReuse: { fromSourceVideoId: from.id } },
  } });
  const job = await prisma.processingJob.create({ data: {
    projectId: project.id, type: "TRANSCRIBE", state: "RUNNING", attempt: 1, idempotencyKey: randomUUID(),
  } });
  // No provider and no audio download may run.
  const providers = vi.spyOn(transcriptionProviders, "resolveTranscriptionProviders").mockImplementation(() => {
    throw new Error("the provider must not be called");
  });
  const download = vi.spyOn(getStorageProvider(), "downloadToFile");
  return { from, source, project, job, providers, download };
}

it("copies the transcript of the earlier source and queues analysis, with no paid call", async () => {
  vi.stubEnv("LAB_TRANSCRIPT_REUSE_ENABLED", "true");
  const fixture = await seed({ originUrl: URL, durationS: 5_116.8 });
  const startedAt = Date.now();
  await runTranscribeJob({ job: fixture.job, prisma });
  console.log(`TRANSCRIBE copied ${LINES} lines in ${Date.now() - startedAt} ms`);

  const copy = await prisma.transcript.findUniqueOrThrow({
    where: { sourceVideoId: fixture.source.id }, include: { segments: { orderBy: { idx: "asc" } } },
  });
  expect(copy.provider).toBe("elevenlabs_scribe_v2");
  expect(copy.segments).toHaveLength(LINES);
  expect(copy.segments.map((s) => s.idx)).toEqual(Array.from({ length: LINES }, (_, i) => i));
  expect(copy.segments[1_234]).toMatchObject({ startMs: 2_468_000, endMs: 2_469_900, text: "Line 1234.", words: wordsOf(1_234) });
  expect(fixture.providers).not.toHaveBeenCalled();
  expect(fixture.download).not.toHaveBeenCalled();
  expect(await prisma.processingJob.count({ where: { projectId: fixture.project.id, type: "ANALYZE" } })).toBe(1);
  const events = await prisma.operationalEvent.findMany({ where: { projectId: fixture.project.id } });
  expect(events.find((e) => e.eventType === "lab_transcript_reused")?.metadata).toMatchObject({ fromSourceVideoId: fixture.from.id, segments: LINES });
  expect(events.some((e) => (e.metadata as { stage?: string } | null)?.stage === "transcription")).toBe(false);
}, 30_000);

it("refuses a different video, and writes nothing", async () => {
  vi.stubEnv("LAB_TRANSCRIPT_REUSE_ENABLED", "true");
  const fixture = await seed({ originUrl: "https://www.youtube.com/watch?v=5cVMudHn2iw", durationS: 5_116.8 });
  await expect(runTranscribeJob({ job: fixture.job, prisma })).rejects.toThrow(/same video/);
  expect(await prisma.transcript.count({ where: { sourceVideoId: fixture.source.id } })).toBe(0);
  expect(fixture.providers).not.toHaveBeenCalled();
}, 30_000);

it("transcribes as usual when the lab switch is off", async () => {
  const fixture = await seed({ originUrl: URL, durationS: 5_116.8 });
  vi.spyOn(getStorageProvider(), "size").mockResolvedValue(0);
  fixture.download.mockResolvedValue(undefined);
  await expect(runTranscribeJob({ job: fixture.job, prisma })).rejects.toThrow();
  expect(fixture.providers).toHaveBeenCalled();
}, 30_000);
