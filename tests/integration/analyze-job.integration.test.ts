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
import { createAnalyzeJobHandler, runAnalyzeJob } from "@/lib/jobs/handlers/analyze";
import { JobFailureError } from "@/lib/jobs/types";

/**
 * CHARTER TESTS — these record what ANALYZE does *today*, defects included. P0.8 changed the
 * candidate-pool assertions from the old hard-coded ceiling to the accepted project snapshot.
 *
 * Nothing here asserts desired behavior. Several cases pin down bugs the plan intends to fix
 * (Sunday spill in P1.8/P1.9, destructive reanalysis in P1.7, the unguarded cross-project date
 * collision in P0.15/P1.9). When those commits land they must *change* these assertions and say so
 * — that is the point. An assertion that quietly still passes after a fix means the fix missed.
 *
 * Provider note: with no ANTHROPIC_API_KEY (the CI condition) `getAnalysisProvider()` returns the
 * deterministic heuristic scorer, which is what makes these tests stable. P0.9 keeps that path
 * legal outside production and requires an explicit emergency override in production.
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
  candidateLimit?: number;
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
      processingConfig: {
        ...(options.targetClipCount === undefined ? {} : { targetClipCount: options.targetClipCount }),
        ...(options.candidateLimit === undefined ? {} : { candidateLimit: options.candidateLimit }),
      },
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
  it("uses 18 as the legacy candidate limit", async () => {
    const workspaceId = await seedWorkspace();
    const { clips, metadata } = await analyzeProject({
      workspaceId,
      segmentCount: 400, // 40 minutes
      sermonDate: new Date("2026-03-04T00:00:00.000Z"), // a Wednesday
    });

    expect(clips.length).toBeLessThanOrEqual(18);
    expect(metadata.candidateLimit).toBe(18);
    expect(metadata.keptCount).toBe(clips.length);
  });

  it("honors a lower snapshotted candidate limit", async () => {
    const workspaceId = await seedWorkspace();
    const { clips, metadata } = await analyzeProject({
      workspaceId,
      segmentCount: 400,
      sermonDate: new Date("2026-03-04T00:00:00.000Z"),
      targetClipCount: 3,
      candidateLimit: 4,
    });

    expect(clips).toHaveLength(4);
    expect(metadata).toMatchObject({ candidateLimit: 4, keptCount: 4 });
  });

  it("raises a below-required snapshot to the scheduled count", async () => {
    const workspaceId = await seedWorkspace();
    const { clips, metadata } = await analyzeProject({
      workspaceId,
      segmentCount: 400,
      sermonDate: new Date("2026-03-04T00:00:00.000Z"),
      targetClipCount: 6,
      candidateLimit: 3,
    });

    expect(clips).toHaveLength(6);
    expect(metadata).toMatchObject({ candidateLimit: 6, targetClipCount: 6, keptCount: 6 });
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

    expect(metadata).toMatchObject({
      candidateLimit: 18,
      targetClipCount: 3,
      keptCount: clips.length,
    });
    expect(typeof metadata.candidateCount).toBe("number");
  });
});

describe("ANALYZE provider policy", () => {
  it("fails closed and records an event in production without a Claude key", async () => {
    const originalEnv = { ...process.env };
    process.env = { ...process.env, NODE_ENV: "production" };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANALYSIS_ALLOW_HEURISTIC;
    try {
      const workspaceId = await seedWorkspace();
      const sourceVideo = await prisma.sourceVideo.create({
        data: {
          workspaceId,
          origin: SourceOrigin.UPLOAD,
          filename: `${unique("provider-policy")}.mp4`,
          storageKey: unique("provider-policy-key"),
          durationS: 120,
          transcript: {
            create: {
              language: "en",
              provider: "charter-fixture",
              fullText: "provider policy fixture transcript",
              segments: { create: segmentsFor(20) },
            },
          },
        },
      });
      const project = await prisma.project.create({
        data: { workspaceId, name: unique("provider-policy"), sourceVideoId: sourceVideo.id },
      });
      const job = await prisma.processingJob.create({
        data: {
          projectId: project.id,
          type: ProcessingJobType.ANALYZE,
          state: ProcessingJobState.RUNNING,
          idempotencyKey: unique("provider-policy-job"),
        },
      });

      await expect(
        runAnalyzeJob({ job, prisma } as Parameters<typeof runAnalyzeJob>[0]),
      ).rejects.toMatchObject({ code: "ANALYZE_PROVIDER_UNAVAILABLE" } satisfies Partial<JobFailureError>);
      const event = await prisma.operationalEvent.findFirstOrThrow({
        where: { workspaceId, projectId: project.id, eventType: "analysis_provider_unavailable" },
      });
      expect(event.severity).toBe("error");
      expect(event.metadata).toMatchObject({ emergencyOverride: false });
    } finally {
      process.env = originalEnv;
    }
  });

  it("labels and warns for the production heuristic emergency override", async () => {
    const originalEnv = { ...process.env };
    process.env = {
      ...process.env,
      NODE_ENV: "production",
      ANALYSIS_ALLOW_HEURISTIC: "true",
    };
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const workspaceId = await seedWorkspace();
      const { metadata } = await analyzeProject({
        workspaceId,
        segmentCount: 20,
        sermonDate: new Date("2026-03-04T00:00:00.000Z"),
      });

      expect(metadata).toMatchObject({
        provider: "heuristic",
        providerKind: "heuristic",
        selectionReason: "production_emergency_override",
        emergencyOverride: true,
        modelVersions: ["heuristic-v1"],
      });
      const event = await prisma.operationalEvent.findFirstOrThrow({
        where: { workspaceId, eventType: "analysis_heuristic_emergency_override" },
      });
      expect(event.severity).toBe("warning");
      expect(event.metadata).toMatchObject({ emergencyOverride: true });
      const costEvent = await prisma.operationalEvent.findFirstOrThrow({
        where: { workspaceId, eventType: "processing_cost_fact", category: "cost" },
        orderBy: { createdAt: "desc" },
      });
      expect(costEvent.metadata).toMatchObject({
        stage: "analysis_scoring",
        provider: "heuristic",
        pricingStatus: "zero_cost",
        outcome: "succeeded",
      });
    } finally {
      process.env = originalEnv;
    }
  });

  it("fails closed and records an event when the production Claude call fails", async () => {
    const originalEnv = { ...process.env };
    process.env = { ...process.env, NODE_ENV: "production" };
    try {
      const workspaceId = await seedWorkspace();
      const sourceVideo = await prisma.sourceVideo.create({
        data: {
          workspaceId,
          origin: SourceOrigin.UPLOAD,
          filename: `${unique("provider-failure")}.mp4`,
          storageKey: unique("provider-failure-key"),
          durationS: 120,
          transcript: {
            create: {
              language: "en",
              provider: "charter-fixture",
              fullText: "provider failure fixture transcript",
              segments: { create: segmentsFor(20) },
            },
          },
        },
      });
      const project = await prisma.project.create({
        data: { workspaceId, name: unique("provider-failure"), sourceVideoId: sourceVideo.id },
      });
      const job = await prisma.processingJob.create({
        data: {
          projectId: project.id,
          type: ProcessingJobType.ANALYZE,
          state: ProcessingJobState.RUNNING,
          idempotencyKey: unique("provider-failure-job"),
        },
      });
      const handler = createAnalyzeJobHandler({
        selectProvider: async () => ({
          provider: {
            name: "claude-sonnet-5",
            isAvailable: async () => true,
            scoreCandidates: async () => {
              throw new Error("401 invalid x-api-key");
            },
          },
          providerKind: "claude",
          selectionReason: "claude_available",
          emergencyOverride: false,
        }),
      });

      await expect(handler({ job, prisma })).rejects.toMatchObject({ code: "ANALYZE_FAILED" });
      const event = await prisma.operationalEvent.findFirstOrThrow({
        where: { workspaceId, projectId: project.id, eventType: "analysis_provider_failed" },
      });
      expect(event.severity).toBe("error");
      expect(event.metadata).toMatchObject({ provider: "claude", emergencyOverride: false });
      const costEvent = await prisma.operationalEvent.findFirstOrThrow({
        where: { workspaceId, projectId: project.id, eventType: "processing_cost_fact" },
      });
      expect(costEvent.metadata).toMatchObject({
        stage: "analysis_classification",
        provider: "anthropic",
        pricingStatus: "unpriced",
        outcome: "failed",
      });
    } finally {
      process.env = originalEnv;
    }
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

describe("ANALYZE preflight — cross-project date collision", () => {
  it("keeps earlier rows and records every later-project collision without hiding analysis", async () => {
    const workspaceId = await seedWorkspace();
    const sermonDate = new Date("2026-03-04T00:00:00.000Z");

    const a = await analyzeProject({ workspaceId, segmentCount: 300, sermonDate, targetClipCount: 3 });
    const b = await analyzeProject({ workspaceId, segmentCount: 300, sermonDate, targetClipCount: 3 });

    expect(a.posts.length).toBeGreaterThan(0);
    expect(b.posts).toHaveLength(0);
    expect(b.clips.length).toBeGreaterThan(0);

    const laterProject = await prisma.project.findUniqueOrThrow({ where: { id: b.projectId } });
    expect(laterProject.status).toBe("READY");

    const all = await prisma.scheduledPost.findMany({
      where: { workspaceId, platform: SocialPlatform.FACEBOOK },
    });
    const byDate = new Map<string, number>();
    for (const post of all) {
      const key = post.scheduledDate.toISOString().slice(0, 10);
      byDate.set(key, (byDate.get(key) ?? 0) + 1);
    }
    expect([...byDate.values()].every((count) => count === 1)).toBe(true);

    const earlierProjectIds = new Set(
      await Promise.all(
        all.map(async (post) => {
          const clip = await prisma.generatedClip.findUnique({ where: { id: post.clipId ?? "" } });
          return clip?.projectId;
        }),
      ),
    );
    expect(earlierProjectIds).toEqual(new Set([a.projectId]));

    const events = await prisma.operationalEvent.findMany({
      where: { projectId: b.projectId, eventType: "scheduled_post_collision" },
    });
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.severity === "warning")).toBe(true);
    expect(events.map((event) => event.metadata)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          existingProjectId: a.projectId,
          laterProjectId: b.projectId,
        }),
      ]),
    );
  });
});
