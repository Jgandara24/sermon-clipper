import {
  AuthProvider,
  ClipApprovalState,
  PrismaClient,
  ProcessingJobState,
  ProcessingJobType,
  SchedulePublishStatus,
  SocialPlatform,
  SourceOrigin,
  WorkspaceRole,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REANALYSIS_BLOCKED } from "@/lib/analysis/reanalysis-policy";
import { createAnalyzeJobHandler, runAnalyzeJob } from "@/lib/jobs/handlers/analyze";
import { JobFailureError } from "@/lib/jobs/types";

/**
 * CHARTER TESTS — these record what ANALYZE does *today*, defects included. P0.8 changed the
 * candidate-pool assertions from the old hard-coded ceiling to the accepted project snapshot.
 *
 * Nothing here asserts desired behavior *unless a fix has landed and inverted it*. Sunday spill was
 * inverted by P1.9 and destructive reanalysis by P1.7; both now assert the fixed rule. The
 * cross-project date collision
 * case was inverted by P0.15 and now asserts the app-level guard; the remaining concurrency race
 * belongs to P1.9. When the owning commits land they must *change* these assertions and say so
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
  serviceOccurrence?: "PRIMARY" | "SECONDARY" | "UNMATCHED";
  handler?: typeof runAnalyzeJob;
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
        ...(options.serviceOccurrence === undefined
          ? {}
          : { serviceOccurrence: options.serviceOccurrence }),
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

  const run = options.handler ?? runAnalyzeJob;
  const result = await run({ job, prisma } as Parameters<typeof runAnalyzeJob>[0]);

  const clips = await prisma.generatedClip.findMany({
    where: { projectId: project.id },
    orderBy: { rank: "asc" },
  });
  // By project, not by clip: an UNFILLED slot has no clip and must still be visible here.
  const posts = await prisma.scheduledPost.findMany({
    where: { projectId: project.id },
    orderBy: { scheduledDate: "asc" },
  });

  return { projectId: project.id, metadata: result?.metadata as Record<string, unknown>, clips, posts };
}

beforeAll(async () => {
  // P1.9 ships AUTOMATIC_SCHEDULE_ARMING_ENABLED false. These cases describe what arming does,
  // so the file turns it on; the one case that asserts the off state unsets it and restores it.
  process.env.AUTOMATIC_SCHEDULE_ARMING_ENABLED = "true";
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
      sermonDate: new Date("2027-03-03T00:00:00.000Z"), // a Wednesday
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
      sermonDate: new Date("2027-03-03T00:00:00.000Z"),
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
      sermonDate: new Date("2027-03-03T00:00:00.000Z"),
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
      sermonDate: new Date("2027-03-03T00:00:00.000Z"),
    });

    expect(clips.length).toBeLessThan(6);
  });

  it("reports requested and retained counts in job metadata", async () => {
    const workspaceId = await seedWorkspace();
    const { metadata, clips } = await analyzeProject({
      workspaceId,
      segmentCount: 120,
      sermonDate: new Date("2027-03-03T00:00:00.000Z"),
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
        sermonDate: new Date("2027-03-03T00:00:00.000Z"),
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
      sermonDate: new Date("2027-03-03T00:00:00.000Z"),
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

  // INVERTED BY P1.9 (2026-09-05). The charter recorded that posting dates were sermonDate + rank
  // days with no weekday awareness, so a Wednesday service scheduled onto the following Sunday,
  // against the promise in docs/BUSINESS_OVERVIEW.md. The allocator now skips Sunday.
  it("never schedules onto Sunday, and skips it rather than dropping the day", async () => {
    const workspaceId = await seedWorkspace();
    const sermonDate = new Date("2027-03-03T00:00:00.000Z"); // Wednesday
    const { posts } = await analyzeProject({
      workspaceId,
      segmentCount: 300,
      sermonDate,
      targetClipCount: 6,
    });

    expect(posts).toHaveLength(6);
    expect(posts.map((p) => p.scheduledDate.getUTCDay())).not.toContain(0);
    // Thu Fri Sat, Sunday 2027-03-07 skipped, Mon Tue Wed. Six days are still delivered.
    expect(posts.map((p) => p.scheduledDate.toISOString().slice(0, 10))).toEqual([
      "2027-03-04",
      "2027-03-05",
      "2027-03-06",
      "2027-03-08",
      "2027-03-09",
      "2027-03-10",
    ]);
  });

  it("arms nothing at all while the arming switch is off, and says so", async () => {
    const workspaceId = await seedWorkspace();
    delete process.env.AUTOMATIC_SCHEDULE_ARMING_ENABLED;
    try {
      const { clips, posts, projectId } = await analyzeProject({
        workspaceId,
        segmentCount: 300,
        sermonDate: new Date("2027-03-03T00:00:00.000Z"),
        targetClipCount: 3,
      });

      // The candidates survive; only the calendar rows are withheld.
      expect(clips.length).toBeGreaterThan(0);
      expect(posts).toHaveLength(0);

      const disabled = await prisma.operationalEvent.findFirst({
        where: { projectId, eventType: "schedule_arming_disabled" },
      });
      expect(disabled).not.toBeNull();
      expect(disabled?.metadata).toMatchObject({ plannedSlots: 3 });
    } finally {
      process.env.AUTOMATIC_SCHEDULE_ARMING_ENABLED = "true";
    }
  });

  it("marks a date that already passed MISSED and does not shift the ranks behind it", async () => {
    const workspaceId = await seedWorkspace();
    // Long past, so every allocated date is behind "now".
    const { posts } = await analyzeProject({
      workspaceId,
      segmentCount: 300,
      sermonDate: new Date("2020-03-04T00:00:00.000Z"),
      targetClipCount: 3,
    });

    expect(posts).toHaveLength(3);
    expect(posts.every((p) => p.publishStatus === SchedulePublishStatus.MISSED)).toBe(true);
    expect(posts.map((p) => p.scheduledDate.toISOString().slice(0, 10))).toEqual([
      "2020-03-05",
      "2020-03-06",
      "2020-03-07",
    ]);
  });

  it("leaves an unmatched service as reserve, scheduling none of it", async () => {
    const workspaceId = await seedWorkspace();
    const { clips, posts } = await analyzeProject({
      workspaceId,
      segmentCount: 300,
      sermonDate: new Date("2027-03-03T00:00:00.000Z"),
      targetClipCount: 3,
      serviceOccurrence: "UNMATCHED",
    });

    expect(clips.length).toBeGreaterThan(0);
    expect(posts).toHaveLength(0);
  });

  it("arms an UNFILLED slot with an open exception when the pool is thinner than the week", async () => {
    const workspaceId = await seedWorkspace();
    // 48 seconds of source: at most one or two viable windows, well short of a six-day week.
    const { clips, posts, projectId } = await analyzeProject({
      workspaceId,
      segmentCount: 8,
      sermonDate: new Date("2027-03-03T00:00:00.000Z"),
      targetClipCount: 6,
    });

    expect(clips.length).toBeLessThan(6);
    const unfilled = posts.filter((p) => p.publishStatus === SchedulePublishStatus.UNFILLED);
    expect(unfilled.length).toBe(6 - clips.length);
    for (const slot of unfilled) expect(slot.clipId).toBeNull();
    // Every row carries its owning project, clip or no clip.
    for (const slot of posts) expect(slot.projectId).toBe(projectId);

    const exceptions = await prisma.editorialException.findMany({
      where: { projectId, exceptionType: "unfilled_schedule_slot" },
    });
    expect(exceptions).toHaveLength(unfilled.length);
    expect(exceptions.every((e) => e.state === "OPEN")).toBe(true);
  });

  it("sets the source retention date to fourteen days after the last armed post", async () => {
    const workspaceId = await seedWorkspace();
    const { projectId } = await analyzeProject({
      workspaceId,
      segmentCount: 300,
      sermonDate: new Date("2027-03-03T00:00:00.000Z"),
      targetClipCount: 3,
    });

    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    // Slots are Thu 03-04, Fri 03-05, Sat 03-06; the last one plus fourteen days.
    expect(project.expiresAt?.toISOString().slice(0, 10)).toBe("2027-03-20");
  });
});

describe("ANALYZE — re-analysis after durable work", () => {
  // INVERTED BY P1.7 (2026-09-05). The charter recorded that a second run deleted every clip,
  // taking edits, approvals and exports with it, and left a published slot detached. A rebuild
  // is now refused once any of that exists, and it changes nothing when it refuses. An untouched
  // project still rebuilds, which is the only case the old behaviour was ever right about.

  /** Everything a rebuild would touch, so a refusal can be shown to have touched none of it. */
  async function snapshot(projectId: string) {
    const [clips, posts, references, project] = await Promise.all([
      prisma.generatedClip.findMany({ where: { projectId }, orderBy: { rank: "asc" } }),
      prisma.scheduledPost.findMany({
        where: { OR: [{ projectId }, { clip: { projectId } }] },
        orderBy: { scheduledDate: "asc" },
      }),
      prisma.scriptureReference.findMany({ where: { projectId }, orderBy: { id: "asc" } }),
      prisma.project.findUniqueOrThrow({ where: { id: projectId } }),
    ]);
    return { clips, posts, references, status: project.status };
  }

  async function rerun(projectId: string, label: string) {
    const job = await prisma.processingJob.create({
      data: {
        projectId,
        type: ProcessingJobType.ANALYZE,
        state: ProcessingJobState.RUNNING,
        idempotencyKey: unique(label),
      },
    });
    return runAnalyzeJob({ job, prisma } as Parameters<typeof runAnalyzeJob>[0]);
  }

  async function seedFirstRun() {
    const workspaceId = await seedWorkspace();
    const first = await analyzeProject({
      workspaceId,
      segmentCount: 300,
      sermonDate: new Date("2027-03-03T00:00:00.000Z"),
      targetClipCount: 3,
    });
    expect(first.clips.length).toBeGreaterThan(0);
    return { workspaceId, first };
  }

  it("still rebuilds a project nobody has touched", async () => {
    const { first } = await seedFirstRun();
    const originalClipIds = first.clips.map((c) => c.id);

    await rerun(first.projectId, "rerun-untouched");

    const survivors = await prisma.generatedClip.findMany({ where: { id: { in: originalClipIds } } });
    expect(survivors).toHaveLength(0);
    const rebuilt = await prisma.generatedClip.findMany({ where: { projectId: first.projectId } });
    expect(rebuilt.length).toBeGreaterThan(0);
  });

  it("refuses once a person has saved an edit, and changes nothing", async () => {
    const { first } = await seedFirstRun();
    // Version 2: the machine writes version 1 itself, and that one does not count.
    await prisma.clipEdit.create({
      data: { clipId: first.clips[0].id, version: 2, editorState: { version: 2 } },
    });
    const before = await snapshot(first.projectId);

    await expect(rerun(first.projectId, "rerun-edited")).rejects.toMatchObject({
      code: REANALYSIS_BLOCKED,
      retryable: false,
      preservesProject: true,
    });

    expect(await snapshot(first.projectId)).toEqual(before);
  });

  it("refuses once a clip has an export job", async () => {
    const { workspaceId, first } = await seedFirstRun();
    await prisma.exportJob.create({
      data: {
        clipId: first.clips[0].id,
        workspaceId,
        filename: "sermon.mp4",
        idempotencyKey: unique("export"),
        editVersion: 1,
      },
    });
    const before = await snapshot(first.projectId);

    await expect(rerun(first.projectId, "rerun-exported")).rejects.toMatchObject({
      code: REANALYSIS_BLOCKED,
    });
    expect(await snapshot(first.projectId)).toEqual(before);
  });

  it("refuses once a clip has an approval record, in any state", async () => {
    const { workspaceId, first } = await seedFirstRun();
    await prisma.clipApproval.create({
      data: {
        workspaceId,
        clipId: first.clips[0].id,
        state: ClipApprovalState.DRAFT,
        reviewToken: unique("review-token"),
        reviewTokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    const before = await snapshot(first.projectId);

    await expect(rerun(first.projectId, "rerun-approval")).rejects.toMatchObject({
      code: REANALYSIS_BLOCKED,
    });
    expect(await snapshot(first.projectId)).toEqual(before);
  });

  it("refuses once a slot has published, and the slot keeps its clip", async () => {
    const { first } = await seedFirstRun();
    const published = first.posts[0];
    await prisma.scheduledPost.update({
      where: { id: published.id },
      data: { publishStatus: SchedulePublishStatus.SUCCEEDED, facebookPostId: "charter-post" },
    });
    const before = await snapshot(first.projectId);

    await expect(rerun(first.projectId, "rerun-published")).rejects.toMatchObject({
      code: REANALYSIS_BLOCKED,
    });

    const still = await prisma.scheduledPost.findUniqueOrThrow({ where: { id: published.id } });
    expect(still.publishStatus).toBe(SchedulePublishStatus.SUCCEEDED);
    // The charter's "detached history" — clipId null — no longer happens: the clip is still there.
    expect(still.clipId).toBe(published.clipId);
    expect(await snapshot(first.projectId)).toEqual(before);
  });

  it("refuses once a slot is in flight, before a claim could be orphaned", async () => {
    const { first } = await seedFirstRun();
    await prisma.scheduledPost.update({
      where: { id: first.posts[0].id },
      data: { publishStatus: SchedulePublishStatus.IN_PROGRESS },
    });

    await expect(rerun(first.projectId, "rerun-in-flight")).rejects.toMatchObject({
      code: REANALYSIS_BLOCKED,
    });
  });
});

describe("ANALYZE preflight — cross-project date collision", () => {
  it("keeps earlier rows and records every later-project collision without hiding analysis", async () => {
    const workspaceId = await seedWorkspace();
    const sermonDate = new Date("2027-03-03T00:00:00.000Z");

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

describe("ANALYZE cost-fact recording", () => {
  it("keeps a successful analysis when cost-fact recording fails, with a visible warning", async () => {
    const workspaceId = await seedWorkspace();
    const handler = createAnalyzeJobHandler({
      recordCostFact: async () => {
        throw new Error("cost facts table unavailable");
      },
    });

    const { projectId, metadata, clips } = await analyzeProject({
      workspaceId,
      segmentCount: 20,
      sermonDate: null,
      handler,
    });

    expect(clips.length).toBeGreaterThan(0);
    expect(metadata.keptCount).toBe(clips.length);

    const warning = await prisma.operationalEvent.findFirstOrThrow({
      where: { workspaceId, projectId, eventType: "cost_fact_record_failed" },
    });
    expect(warning.severity).toBe("warning");
    // The failed write recorded nothing — no partial or duplicate cost facts.
    await expect(
      prisma.operationalEvent.count({
        where: { workspaceId, projectId, eventType: "processing_cost_fact" },
      }),
    ).resolves.toBe(0);
  });

  it("records exactly one cost fact for a normal heuristic run", async () => {
    const workspaceId = await seedWorkspace();
    const { projectId } = await analyzeProject({
      workspaceId,
      segmentCount: 20,
      sermonDate: null,
    });

    await expect(
      prisma.operationalEvent.count({
        where: { workspaceId, projectId, eventType: "processing_cost_fact" },
      }),
    ).resolves.toBe(1);
  });
});
