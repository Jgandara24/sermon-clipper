import {
  AuthProvider,
  PrismaClient,
  ProcessingJobState,
  ProcessingJobType,
  SchedulePublishStatus,
  SocialPlatform,
  SourceOrigin,
  WorkspaceRole,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAnalyzeJob } from "@/lib/jobs/handlers/analyze";

/**
 * CHARTER TESTS — these record what ANALYZE does *today*, defects included.
 *
 * Nothing here asserts desired behavior. Several cases pin down bugs the plan intends to fix
 * (Sunday spill in P1.8/P1.9, destructive reanalysis in P1.7, the unguarded cross-project date
 * collision in P0.15/P1.9). When those commits land they must *change* these assertions and say so
 * — that is the point. An assertion that quietly still passes after a fix means the fix missed.
 *
 * Provider note: with no ANTHROPIC_API_KEY (the CI condition) `getAnalysisProvider()` returns the
 * deterministic heuristic scorer, which is what makes these tests stable. P0.9 keeps that path
 * legal outside production.
 */

const prisma = new PrismaClient();

const SEGMENT_MS = 6_000;
const created: { workspaces: string[]; users: string[] } = { workspaces: [], users: [] };

function unique(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Builds enough spoken text that 20–90s windows are constructible across the whole recording. */
function segmentsFor(count: number) {
  return Array.from({ length: count }, (_, idx) => {
    const startMs = idx * SEGMENT_MS;
    const text =
      `This is point number ${idx + 1} of the message. ` +
      "God calls us to walk in a way the world does not expect, and that call reshapes how we live.";
    return {
      idx,
      startMs,
      endMs: startMs + SEGMENT_MS,
      text,
      words: [],
    };
  });
}

async function seedWorkspace() {
  const user = await prisma.user.create({
    data: { email: `${unique("charter")}@example.test`, authProvider: AuthProvider.DEV },
  });
  const workspace = await prisma.workspace.create({
    data: { name: unique("charter-ws"), owner: { connect: { id: user.id } } },
  });
  await prisma.workspaceMember.create({
    data: { userId: user.id, workspaceId: workspace.id, role: WorkspaceRole.OWNER },
  });
  created.users.push(user.id);
  created.workspaces.push(workspace.id);
  return workspace.id;
}

/**
 * Creates a project whose transcript spans `segmentCount * 6s`, then runs ANALYZE and returns the
 * job metadata plus the resulting clips and scheduled posts.
 */
async function analyzeProject(options: {
  workspaceId: string;
  segmentCount: number;
  sermonDate: Date | null;
  targetClipCount?: number;
}) {
  const { workspaceId, segmentCount, sermonDate } = options;
  const durationS = (segmentCount * SEGMENT_MS) / 1000;

  const sourceVideo = await prisma.sourceVideo.create({
    data: {
      workspaceId,
      origin: SourceOrigin.UPLOAD,
      filename: `${unique("charter")}.mp4`,
      storageKey: unique("charter-key"),
      durationS,
      width: 1280,
      height: 720,
      transcript: {
        create: {
          language: "en",
          provider: "charter-fixture",
          fullText: "charter fixture transcript",
          segments: { create: segmentsFor(segmentCount) },
        },
      },
    },
  });

  const project = await prisma.project.create({
    data: {
      workspaceId,
      name: unique("charter-project"),
      sourceVideoId: sourceVideo.id,
      sermonDate,
      processingConfig:
        options.targetClipCount === undefined ? {} : { targetClipCount: options.targetClipCount },
    },
  });

  const job = await prisma.processingJob.create({
    data: {
      projectId: project.id,
      type: ProcessingJobType.ANALYZE,
      state: ProcessingJobState.RUNNING,
      idempotencyKey: unique("charter-job"),
    },
  });

  const result = await runAnalyzeJob({ job, prisma } as Parameters<typeof runAnalyzeJob>[0]);

  const clips = await prisma.generatedClip.findMany({
    where: { projectId: project.id },
    orderBy: { rank: "asc" },
  });
  const posts = await prisma.scheduledPost.findMany({
    where: { clipId: { in: clips.map((c) => c.id) } },
    orderBy: { scheduledDate: "asc" },
  });

  return { projectId: project.id, metadata: result?.metadata as Record<string, unknown>, clips, posts };
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  for (const workspaceId of created.workspaces) {
    await prisma.scheduledPost.deleteMany({ where: { workspaceId } });
    await prisma.project.deleteMany({ where: { workspaceId } });
    await prisma.sourceVideo.deleteMany({ where: { workspaceId } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId } });
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  }
  await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  await prisma.$disconnect();
});

describe("ANALYZE charter — candidate pool", () => {
  it("keeps at most CANDIDATE_POOL_SIZE clips from a long service", async () => {
    const workspaceId = await seedWorkspace();
    const { clips, metadata } = await analyzeProject({
      workspaceId,
      segmentCount: 400, // 40 minutes
      sermonDate: new Date("2026-03-04T00:00:00.000Z"), // a Wednesday
    });

    expect(clips.length).toBeLessThanOrEqual(18);
    expect(metadata.keptCount).toBe(clips.length);
  });

  it("returns a thin pool rather than padding when the source is short", async () => {
    const workspaceId = await seedWorkspace();
    const { clips } = await analyzeProject({
      workspaceId,
      segmentCount: 8, // 48 seconds — at most one or two viable windows
      sermonDate: new Date("2026-03-04T00:00:00.000Z"),
    });

    expect(clips.length).toBeLessThan(6);
  });

  it("reports requested and retained counts in job metadata", async () => {
    const workspaceId = await seedWorkspace();
    const { metadata, clips } = await analyzeProject({
      workspaceId,
      segmentCount: 120,
      sermonDate: new Date("2026-03-04T00:00:00.000Z"),
      targetClipCount: 3,
    });

    expect(metadata).toMatchObject({ targetClipCount: 3, keptCount: clips.length });
    expect(typeof metadata.candidateCount).toBe("number");
  });
});

describe("ANALYZE charter — slot arming", () => {
  it("arms exactly targetClipCount slots and leaves the rest as reserve", async () => {
    const workspaceId = await seedWorkspace();
    const { clips, posts } = await analyzeProject({
      workspaceId,
      segmentCount: 300,
      sermonDate: new Date("2026-03-04T00:00:00.000Z"),
      targetClipCount: 3,
    });

    expect(clips.length).toBeGreaterThan(3);
    expect(posts).toHaveLength(3);

    const armedClipIds = new Set(posts.map((p) => p.clipId));
    for (const clip of clips.slice(0, 3)) expect(armedClipIds.has(clip.id)).toBe(true);
    for (const clip of clips.slice(3)) expect(armedClipIds.has(clip.id)).toBe(false);
  });

  it("arms nothing when the project has no sermon date", async () => {
    const workspaceId = await seedWorkspace();
    const { clips, posts } = await analyzeProject({
      workspaceId,
      segmentCount: 300,
      sermonDate: null,
      targetClipCount: 3,
    });

    expect(clips.length).toBeGreaterThan(0);
    expect(posts).toHaveLength(0);
  });

  // DEFECT UNDER CHARTER — fixed by P1.8/P1.9.
  // Posting dates are sermonDate + rank days with no weekday awareness, so a Wednesday service
  // schedules onto the following Sunday. docs/BUSINESS_OVERVIEW.md promises Sunday is never used.
  it("currently schedules onto Sunday, violating the no-Sunday rule", async () => {
    const workspaceId = await seedWorkspace();
    const { posts } = await analyzeProject({
      workspaceId,
      segmentCount: 300,
      sermonDate: new Date("2026-03-04T00:00:00.000Z"), // Wednesday
      targetClipCount: 6,
    });

    const weekdays = posts.map((p) => p.scheduledDate.getUTCDay());
    expect(weekdays).toContain(0); // Sunday
  });

  it("currently spaces slots one day apart by rank", async () => {
    const workspaceId = await seedWorkspace();
    const sermonDate = new Date("2026-03-04T00:00:00.000Z");
    const { posts } = await analyzeProject({
      workspaceId,
      segmentCount: 300,
      sermonDate,
      targetClipCount: 3,
    });

    const dayOffsets = posts.map(
      (p) => Math.round((p.scheduledDate.getTime() - sermonDate.getTime()) / 86_400_000),
    );
    expect(dayOffsets).toEqual([1, 2, 3]);
  });
});

describe("ANALYZE charter — re-analysis is destructive", () => {
  // DEFECT UNDER CHARTER — fixed by P1.7. Re-running ANALYZE deletes every existing clip for the
  // project, taking any review, approval, or export linkage with it. P1.7 must refuse instead.
  it("deletes prior clips and their unpublished slots on a second run", async () => {
    const workspaceId = await seedWorkspace();
    const first = await analyzeProject({
      workspaceId,
      segmentCount: 300,
      sermonDate: new Date("2026-03-04T00:00:00.000Z"),
      targetClipCount: 3,
    });
    expect(first.clips.length).toBeGreaterThan(0);
    const originalClipIds = first.clips.map((c) => c.id);

    const job = await prisma.processingJob.create({
      data: {
        projectId: first.projectId,
        type: ProcessingJobType.ANALYZE,
        state: ProcessingJobState.RUNNING,
        idempotencyKey: unique("charter-rerun"),
      },
    });
    await runAnalyzeJob({ job, prisma } as Parameters<typeof runAnalyzeJob>[0]);

    const survivors = await prisma.generatedClip.findMany({ where: { id: { in: originalClipIds } } });
    expect(survivors).toHaveLength(0);

    const rebuilt = await prisma.generatedClip.findMany({ where: { projectId: first.projectId } });
    expect(rebuilt.length).toBeGreaterThan(0);
  });

  it("preserves a slot that has already published", async () => {
    const workspaceId = await seedWorkspace();
    const first = await analyzeProject({
      workspaceId,
      segmentCount: 300,
      sermonDate: new Date("2026-03-04T00:00:00.000Z"),
      targetClipCount: 3,
    });

    const published = first.posts[0];
    await prisma.scheduledPost.update({
      where: { id: published.id },
      data: { publishStatus: SchedulePublishStatus.SUCCEEDED, facebookPostId: "charter-post" },
    });

    const job = await prisma.processingJob.create({
      data: {
        projectId: first.projectId,
        type: ProcessingJobType.ANALYZE,
        state: ProcessingJobState.RUNNING,
        idempotencyKey: unique("charter-rerun2"),
      },
    });
    await runAnalyzeJob({ job, prisma } as Parameters<typeof runAnalyzeJob>[0]);

    const still = await prisma.scheduledPost.findUnique({ where: { id: published.id } });
    expect(still).not.toBeNull();
    expect(still?.publishStatus).toBe(SchedulePublishStatus.SUCCEEDED);
    // The clip it pointed at is gone, so the row is now detached history.
    expect(still?.clipId).toBeNull();
  });
});

describe("ANALYZE charter — cross-project date collision", () => {
  // DEFECT UNDER CHARTER — no unique constraint exists on (workspaceId, scheduledDate), so two
  // projects in one workspace can arm the same date. P0.17 adds the constraint and P1.9 the
  // collision handling; today the second project silently double-books.
  it("currently allows two projects to arm the same workspace date", async () => {
    const workspaceId = await seedWorkspace();
    const sermonDate = new Date("2026-03-04T00:00:00.000Z");

    const a = await analyzeProject({ workspaceId, segmentCount: 300, sermonDate, targetClipCount: 3 });
    const b = await analyzeProject({ workspaceId, segmentCount: 300, sermonDate, targetClipCount: 3 });

    expect(a.posts.length).toBeGreaterThan(0);
    expect(b.posts.length).toBeGreaterThan(0);

    const all = await prisma.scheduledPost.findMany({
      where: { workspaceId, platform: SocialPlatform.FACEBOOK },
    });
    const byDate = new Map<string, number>();
    for (const post of all) {
      const key = post.scheduledDate.toISOString().slice(0, 10);
      byDate.set(key, (byDate.get(key) ?? 0) + 1);
    }
    expect([...byDate.values()].some((count) => count > 1)).toBe(true);
  });
});
