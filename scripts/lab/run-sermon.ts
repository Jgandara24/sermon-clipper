/**
 * Phase 1 lab, Step 2: run one sermon from a YouTube link through the existing pipeline
 * (FINALIZE -> PROBE -> TRANSCRIBE -> ANALYZE) in the lab workspace, then print what the picker
 * chose. Needs the lab worker running in another terminal: `npm run lab:worker`.
 *
 *   npm run lab:run -- --url "https://www.youtube.com/watch?v=..." --name "Lab 1 - Normal Sunday" [--date 2026-10-12] [--wait]
 *     [--reuse-transcript-from <earlier lab project id>]
 *
 * --reuse-transcript-from copies the transcript of an earlier lab project of the same video, so
 * TRANSCRIBE calls no paid provider (src/lib/transcription/lab-transcript-reuse.ts).
 *
 * Creates exactly one project and one FINALIZE job, the same way the app does when a church
 * pastes a link. Publishes nothing. Arms no posting slots (the flags stay off in the lab).
 */
import { type Prisma, PrismaClient, ProcessingJobState, ProjectStatus } from "@prisma/client";
import { RETAINED_CLIP_STATUSES } from "@/lib/analysis/clip-status";
import { createDraftProjectForWorkspace } from "@/lib/project-service";
import { LabTranscriptReuseError, withLabTranscriptReuse } from "@/lib/transcription/lab-transcript-reuse";
import {
  assertLabEnvironment,
  formatClock,
  LAB_DEMO_EMAIL,
  LAB_WORKSPACE_NAME,
  LabEnvironmentError,
  readArgs,
  sleep,
} from "./lab-guard";

const TERMINAL_JOB_STATES = new Set<ProcessingJobState>([
  ProcessingJobState.SUCCEEDED,
  ProcessingJobState.FAILED,
  ProcessingJobState.CANCELED,
  ProcessingJobState.EXPIRED,
]);

async function main() {
  const args = readArgs(process.argv.slice(2));
  const url = args.get("url");
  const name = args.get("name");
  if (typeof url !== "string" || typeof name !== "string") {
    console.error('Usage: npm run lab:run -- --url "<youtube url>" --name "<project name>" [--date YYYY-MM-DD] [--wait] [--timeout-min 90] [--reuse-transcript-from <project id>]');
    process.exit(2);
  }
  const dateArg = args.get("date");
  const publishedAt = typeof dateArg === "string" ? new Date(`${dateArg}T12:00:00Z`) : undefined;
  if (publishedAt && Number.isNaN(publishedAt.getTime())) {
    console.error(`--date must look like 2026-10-12, got "${dateArg}".`);
    process.exit(2);
  }
  const wait = args.get("wait") === true;
  const timeoutMinArg = args.get("timeout-min");
  const timeoutMs = (typeof timeoutMinArg === "string" ? Number(timeoutMinArg) : 90) * 60_000;

  assertLabEnvironment({ requireAnthropicKey: true });

  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUnique({ where: { email: LAB_DEMO_EMAIL } });
    if (!user) throw new LabEnvironmentError(`The lab user ${LAB_DEMO_EMAIL} is missing. Run: npm run db:seed`);
    const workspace = await prisma.workspace.findFirst({ where: { ownerId: user.id, name: LAB_WORKSPACE_NAME } });
    if (!workspace) throw new LabEnvironmentError(`The lab workspace "${LAB_WORKSPACE_NAME}" is missing. Run: npm run db:seed`);

    const reuseFrom = args.get("reuse-transcript-from");
    let earlier: Parameters<typeof withLabTranscriptReuse>[2] & { name: string } | null = null;
    if (typeof reuseFrom === "string") {
      const found = await prisma.project.findFirst({
        where: { id: reuseFrom, workspaceId: workspace.id },
        include: { sourceVideo: { select: { originUrl: true, transcript: { select: { id: true } } } } },
      });
      if (!found) throw new LabEnvironmentError(`--reuse-transcript-from: the lab workspace has no project ${reuseFrom}.`);
      earlier = {
        projectId: found.id,
        name: found.name,
        sourceVideoId: found.sourceVideoId,
        originUrl: found.sourceVideo?.originUrl ?? null,
        hasTranscript: Boolean(found.sourceVideo?.transcript),
      };
      // Checked before the project exists, so a refused copy creates nothing.
      withLabTranscriptReuse({}, url, earlier);
    }

    const project = await createDraftProjectForWorkspace(
      prisma,
      workspace.id,
      { name, sourceUrl: url, publishedAt },
      user.id,
    );
    if (earlier) {
      // FINALIZE and PROBE run first, so TRANSCRIBE reads this config minutes after it is saved.
      await prisma.project.update({
        where: { id: project.id },
        data: { processingConfig: withLabTranscriptReuse(project.processingConfig, url, earlier) as Prisma.InputJsonValue },
      });
    }
    console.log(`Project created: ${project.id}`);
    console.log(`Name: ${project.name}`);
    console.log(`Source: ${url}`);
    console.log("One FINALIZE job is queued. The lab worker picks it up (npm run lab:worker).");
    if (earlier) {
      console.log(`TRANSCRIBE copies the transcript of "${earlier.name}", with no paid call (LAB_TRANSCRIPT_REUSE_ENABLED, set by lab:worker).`);
    }

    if (!wait) {
      console.log(`\nTo watch it: npm run lab:run -- --watch ${project.id}`);
      return;
    }
    await watchProject(prisma, project.id, timeoutMs);
  } finally {
    await prisma.$disconnect();
  }
}

async function watchOnly() {
  const args = readArgs(process.argv.slice(2));
  const projectId = args.get("watch");
  if (typeof projectId !== "string") return false;
  assertLabEnvironment({ requireAnthropicKey: false });
  const timeoutMinArg = args.get("timeout-min");
  const timeoutMs = (typeof timeoutMinArg === "string" ? Number(timeoutMinArg) : 90) * 60_000;
  const prisma = new PrismaClient();
  try {
    await watchProject(prisma, projectId, timeoutMs);
  } finally {
    await prisma.$disconnect();
  }
  return true;
}

async function watchProject(prisma: PrismaClient, projectId: string, timeoutMs: number) {
  const startedAt = Date.now();
  const seen = new Map<string, string>();
  console.log("\nWatching the jobs. Press Ctrl+C to stop watching; the worker keeps going.\n");
  let lastChangeAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: { processingJobs: { orderBy: { createdAt: "asc" } } },
    });
    if (!project) throw new LabEnvironmentError(`Project ${projectId} was not found in the lab database.`);

    for (const job of project.processingJobs) {
      const line = `${job.type.padEnd(10)} ${job.state.padEnd(9)} ${String(job.progress).padStart(3)}%` +
        (job.errorCode ? `  ${job.errorCode}: ${job.errorMessageUser ?? ""}` : "");
      if (seen.get(job.id) !== line) {
        seen.set(job.id, line);
        lastChangeAt = Date.now();
        console.log(`${new Date().toLocaleTimeString()}  ${line}`);
      }
    }

    const failedForGood = project.processingJobs.find(
      (job) => job.state === ProcessingJobState.FAILED && job.attempt >= job.maxAttempts,
    );
    const anyOpen = project.processingJobs.some((job) => !TERMINAL_JOB_STATES.has(job.state));

    if (project.status === ProjectStatus.READY) {
      console.log(`\nDone in ${formatClock(Date.now() - startedAt)}. The project is READY.`);
      await printClips(prisma, projectId);
      return;
    }
    if (project.status === ProjectStatus.FAILED || (failedForGood && !anyOpen)) {
      console.log("\nThe run stopped. A job failed and will not retry. See the line above with the error.");
      return;
    }
    if (Date.now() - lastChangeAt > 120_000 && project.processingJobs.every((job) => job.state === ProcessingJobState.QUEUED)) {
      console.log("Nothing has moved for 2 minutes. Is the lab worker running? In another terminal: npm run lab:worker");
      lastChangeAt = Date.now();
    }
    await sleep(5_000);
  }
  console.log("\nStopped watching: the time limit passed. The worker may still be running.");
}

async function printClips(prisma: PrismaClient, projectId: string) {
  const clips = await prisma.generatedClip.findMany({
    where: { projectId, status: { in: [...RETAINED_CLIP_STATUSES] } },
    orderBy: { rank: "asc" },
    include: { score: true },
  });
  const models = new Set(clips.map((clip) => clip.score?.modelVersion ?? "no score"));
  console.log(`\n${clips.length} clips kept. Picker: ${[...models].join(", ")}`);
  if ([...models].some((model) => model.toLowerCase().includes("heuristic"))) {
    console.log("WARNING: the heuristic fallback picked these clips, not the real model. Check ANTHROPIC_API_KEY.");
  }
  console.log("\nRank  Start     End       Length  Title");
  for (const clip of clips) {
    const marker = clip.rank <= 6 ? "*" : " ";
    console.log(
      `${marker}${String(clip.rank).padStart(3)}  ${formatClock(clip.startMs).padEnd(9)} ${formatClock(clip.endMs).padEnd(9)} ` +
        `${formatClock(clip.endMs - clip.startMs).padEnd(7)} ${clip.title}`,
    );
  }
  console.log("\n* = the 6 first picks. Next: npm run lab:review -- --project " + projectId);
}

(async () => {
  try {
    if (await watchOnly()) return;
    await main();
  } catch (error) {
    if (error instanceof LabEnvironmentError || error instanceof LabTranscriptReuseError) {
      console.error(`\nStopped: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
})();
