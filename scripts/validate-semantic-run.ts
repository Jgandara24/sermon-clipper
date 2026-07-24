/**
 * One-off validation harness for the semantic outline-first pipeline (PR #26): runs a REAL
 * full-length sermon through TRANSCRIBE (SRT override) + ANALYZE with the live Anthropic API
 * and the visual gate against the actual video file, then prints a structured report of the
 * outline, exclusions, clip distribution, scores, cost, and per-job timing.
 *
 * Usage:
 *   set -a; source .env; set +a
 *   ANTHROPIC_API_KEY=... npx tsx scripts/validate-semantic-run.ts <video.mp4> <captions.srt>
 *
 * Not wired into CI; safe to re-run (creates a fresh throwaway workspace each time).
 */
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  AuthProvider,
  LedgerKind,
  Prisma,
  ProcessingJobType,
  WorkspaceRole,
  SourceOrigin,
} from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { getStorageProvider } from "../src/lib/storage";
import { enqueueJob } from "../src/lib/jobs/queue";
import { runOnePendingJob } from "../src/lib/jobs/runner";
import { buildDefaultProcessingConfig } from "../src/lib/project-service";

function fmtClock(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

async function main() {
  const [videoPath, srtPath] = process.argv.slice(2);
  if (!videoPath || !srtPath) throw new Error("usage: validate-semantic-run.ts <video.mp4> <captions.srt>");
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required for a live validation run");

  const user = await prisma.user.create({
    data: {
      email: `validation-${Date.now()}@example.com`,
      authProvider: AuthProvider.DEV,
      name: "Semantic Validation",
    },
  });
  const workspace = await prisma.workspace.create({
    data: {
      name: "Semantic Validation Run",
      ownerId: user.id,
      minuteBalance: new Prisma.Decimal("240.00"),
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
      minutesDelta: new Prisma.Decimal("240.00"),
      balanceAfter: new Prisma.Decimal("240.00"),
      note: "validation grant",
    },
  });

  const storage = getStorageProvider();
  const stamp = Date.now();
  const videoKey = `validation/${stamp}/sermon.mp4`;
  const srtKey = `validation/${stamp}/sermon.srt`;
  await mkdir(path.dirname(storage.absolutePath(videoKey)), { recursive: true });
  await copyFile(videoPath, storage.absolutePath(videoKey));
  await copyFile(srtPath, storage.absolutePath(srtKey));

  const sourceVideo = await prisma.sourceVideo.create({
    data: {
      workspaceId: workspace.id,
      origin: SourceOrigin.UPLOAD,
      filename: path.basename(videoPath),
      durationS: new Prisma.Decimal("2820.00"),
      width: 854,
      height: 480,
      storageKey: videoKey,
      srtOverrideKey: srtKey,
      language: "en",
    },
  });
  const project = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: "Validation — real 47min sermon",
      sourceVideoId: sourceVideo.id,
      status: "QUEUED",
      processingConfig: buildDefaultProcessingConfig(1),
    },
  });

  await enqueueJob(prisma, {
    projectId: project.id,
    type: ProcessingJobType.TRANSCRIBE,
    idempotencyKey: `transcribe:${project.id}:validation`,
  });

  const wallStart = Date.now();
  for (let i = 0; i < 10; i += 1) {
    const t0 = Date.now();
    const ran = await runOnePendingJob();
    if (!ran) break;
    console.log(`[job ${i}] finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  const wallSeconds = (Date.now() - wallStart) / 1000;

  const jobs = await prisma.processingJob.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: "asc" },
  });
  const events = await prisma.operationalEvent.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "asc" },
  });
  const outline = await prisma.sermonOutline.findUnique({
    where: { projectId: project.id },
    include: { sections: { orderBy: { position: "asc" } } },
  });
  const clips = await prisma.generatedClip.findMany({
    where: { projectId: project.id },
    orderBy: { rank: "asc" },
    include: { score: true, section: true },
  });
  const segmentCount = await prisma.transcriptSegment.count({
    where: { transcript: { sourceVideoId: sourceVideo.id } },
  });

  console.log("\n========== VALIDATION REPORT ==========");
  console.log(`projectId: ${project.id}`);
  console.log(`total wall clock for all jobs: ${wallSeconds.toFixed(1)}s`);
  console.log(`transcript segments: ${segmentCount}`);

  console.log("\n--- jobs ---");
  for (const job of jobs) {
    const dur =
      job.startedAt && job.finishedAt
        ? `${((job.finishedAt.getTime() - job.startedAt.getTime()) / 1000).toFixed(1)}s`
        : "n/a";
    console.log(`${job.type}: ${job.state} attempt=${job.attempt} duration=${dur} error=${job.errorCode ?? "none"}`);
  }

  console.log("\n--- analysis event metadata ---");
  for (const event of events) {
    const meta = event.metadata as Record<string, unknown> | null;
    if (event.category === "analysis") {
      console.log(JSON.stringify({ eventType: event.eventType, metadata: meta }, null, 2));
    }
  }

  console.log("\n--- outline ---");
  if (!outline) {
    console.log("NO OUTLINE PERSISTED");
  } else {
    console.log(`status=${outline.status} confidence=${outline.confidence} model=${outline.modelVersion}`);
    console.log(`title: ${outline.generatedTitle}`);
    console.log(`mainIdea: ${outline.mainIdea}`);
    for (const section of outline.sections) {
      console.log(
        `  [${section.position}] ${section.type} ${fmtClock(section.startMs)}–${fmtClock(section.endMs)} ` +
          `conf=${section.confidence} "${section.heading}" — ${section.summary}`,
      );
    }
    console.log("exclusions:");
    for (const excl of outline.exclusions as Array<{ startMs: number; endMs: number; reason: string }>) {
      console.log(`  ${fmtClock(excl.startMs)}–${fmtClock(excl.endMs)} ${excl.reason}`);
    }
  }

  console.log("\n--- clips ---");
  for (const clip of clips) {
    const durS = ((clip.endMs - clip.startMs) / 1000).toFixed(0);
    console.log(
      `#${clip.rank} [${clip.score?.total ?? "?"}] ${fmtClock(clip.startMs)}–${fmtClock(clip.endMs)} (${durS}s) ` +
        `section=${clip.section ? `${clip.section.position}:${clip.section.heading}` : "none"}\n` +
        `    "${clip.title}" | hook: ${clip.hookText}\n    ${clip.summary}`,
    );
  }

  const bySection = new Map<string, number>();
  for (const clip of clips) {
    const key = clip.section ? `${clip.section.position}: ${clip.section.heading}` : "unsectioned";
    bySection.set(key, (bySection.get(key) ?? 0) + 1);
  }
  console.log("\n--- clip distribution by section ---");
  for (const [key, count] of [...bySection.entries()].sort()) console.log(`  ${key}: ${count}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
