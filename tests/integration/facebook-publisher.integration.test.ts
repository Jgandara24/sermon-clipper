import {
  AuthProvider,
  GeneratedClipStatus,
  Prisma,
  PrismaClient,
  ProcessingJobState,
  WorkspaceRole,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publishDueScheduledPosts } from "@/lib/integrations/facebook-publisher";

/**
 * Tier 3 publish poller, end to end against a real database with an injected Facebook client
 * (the only fake — same trust boundary as the unit tests' injected fetch in facebook.test.ts):
 *
 * - A due, eligible, exported post is published exactly once and records a facebookPostId.
 * - A second poll over the same (now SUCCEEDED) row never calls the Facebook client again.
 * - A workspace without the go-live flag/page id is skipped, not published.
 * - A clip with no completed export is skipped, not published.
 * - A Facebook client failure marks the row FAILED with the error message, not silently lost.
 */

const prisma = new PrismaClient();
const originalToken = process.env.META_SYSTEM_USER_TOKEN;
const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;

beforeAll(() => {
  // Deliberately fake test-only token; never a real credential. Only its presence matters —
  // the publisher fails closed entirely when this is unset.
  process.env.META_SYSTEM_USER_TOKEN = "test-system-user-token-not-real";
  // The publisher also fails closed on unset/localhost app URLs (finding #9).
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
});

afterAll(async () => {
  if (originalToken === undefined) delete process.env.META_SYSTEM_USER_TOKEN;
  else process.env.META_SYSTEM_USER_TOKEN = originalToken;
  if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
});

const createdWorkspaceIds: string[] = [];
const createdUserIds: string[] = [];

function uniqueKey(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: createdWorkspaceIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

async function createWorkspace(
  label: string,
  settings: Record<string, unknown> = {},
) {
  const user = await prisma.user.create({
    data: { email: `${uniqueKey(label)}@example.com`, authProvider: AuthProvider.DEV },
  });
  createdUserIds.push(user.id);
  const workspace = await prisma.workspace.create({
    data: { name: label, ownerId: user.id, settings: settings as Prisma.InputJsonValue },
  });
  createdWorkspaceIds.push(workspace.id);
  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: user.id, role: WorkspaceRole.OWNER },
  });
  return workspace.id;
}

const eligibleSettings = {
  churchProfile: { timezone: "America/Chicago", serviceDay: "Sunday", sermonsPerWeek: 1, postsPerDay: 1 },
  facebookConnection: { pageId: "1128280933691493", autoPostEnabled: true },
};

async function createDueScheduledPost(
  workspaceId: string,
  label: string,
  options: { withExport?: boolean; scheduledDate?: Date } = {},
) {
  const withExport = options.withExport ?? true;

  const project = await prisma.project.create({
    data: { workspaceId, name: `Facebook Publish ${label}` },
  });

  const clip = await prisma.generatedClip.create({
    data: {
      workspaceId,
      projectId: project.id,
      rank: 1,
      startMs: 0,
      endMs: 10_000,
      title: `Facebook publish clip ${label}`,
      hookText: "You need to hear this.",
      summary: "Clip seeded for facebook publisher tests.",
      status: GeneratedClipStatus.KEPT,
    },
  });

  if (withExport) {
    const exportedFile = await prisma.exportedFile.create({
      data: {
        storageKey: `exports/${workspaceId}/${uniqueKey(label)}.mp4`,
        bytes: BigInt(1024),
        width: 1080,
        height: 1920,
        checksum: "test-checksum",
        downloadExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    await prisma.exportJob.create({
      data: {
        clipId: clip.id,
        workspaceId,
        state: ProcessingJobState.SUCCEEDED,
        idempotencyKey: uniqueKey(`export-${label}`),
        filename: `${label}.mp4`,
        outputFileId: exportedFile.id,
        finishedAt: new Date(),
      },
    });
  }

  const scheduledPost = await prisma.scheduledPost.create({
    data: {
      workspaceId,
      clipId: clip.id,
      scheduledDate: options.scheduledDate ?? new Date("2026-07-19T00:00:00Z"),
    },
  });

  return scheduledPost.id;
}

describe("publishDueScheduledPosts", () => {
  it("publishes a due, eligible, exported post exactly once", async () => {
    const workspaceId = await createWorkspace("Publish Success", eligibleSettings);
    const scheduledPostId = await createDueScheduledPost(workspaceId, "success");

    let resolveCalls = 0;
    let publishCalls = 0;
    const summary = await publishDueScheduledPosts(prisma, {
      now: () => new Date("2026-07-20T12:00:00Z"),
      resolvePageAccessToken: async () => {
        resolveCalls++;
        return "page-token-abc";
      },
      publishScheduledVideo: async () => {
        publishCalls++;
        return { facebookPostId: "fb-video-123" };
      },
    });

    expect(summary.postsPublished).toBe(1);
    expect(resolveCalls).toBe(1);
    expect(publishCalls).toBe(1);

    const updated = await prisma.scheduledPost.findUniqueOrThrow({ where: { id: scheduledPostId } });
    expect(updated.publishStatus).toBe("SUCCEEDED");
    expect(updated.facebookPostId).toBe("fb-video-123");
    expect(updated.publishedAt).not.toBeNull();

    // Second poll must not touch an already-SUCCEEDED row.
    const secondSummary = await publishDueScheduledPosts(prisma, {
      now: () => new Date("2026-07-21T12:00:00Z"),
      resolvePageAccessToken: async () => {
        resolveCalls++;
        return "page-token-abc";
      },
      publishScheduledVideo: async () => {
        publishCalls++;
        return { facebookPostId: "fb-video-should-not-happen" };
      },
    });
    expect(secondSummary.postsPublished).toBe(0);
    expect(resolveCalls).toBe(1);
    expect(publishCalls).toBe(1);
  });

  it("skips a workspace that hasn't gone live (no page id / flag off)", async () => {
    const workspaceId = await createWorkspace("Publish Not Eligible", {
      churchProfile: eligibleSettings.churchProfile,
      facebookConnection: { pageId: null, autoPostEnabled: false },
    });
    await createDueScheduledPost(workspaceId, "not-eligible");

    let calls = 0;
    const summary = await publishDueScheduledPosts(prisma, {
      now: () => new Date("2026-07-20T12:00:00Z"),
      resolvePageAccessToken: async () => {
        calls++;
        return "unused";
      },
      publishScheduledVideo: async () => {
        calls++;
        return { facebookPostId: "unused" };
      },
    });

    expect(summary.postsSkippedNotEligible).toBeGreaterThanOrEqual(1);
    expect(calls).toBe(0);
  });

  it("skips a clip that has no completed export yet", async () => {
    const workspaceId = await createWorkspace("Publish Not Exported", eligibleSettings);
    const scheduledPostId = await createDueScheduledPost(workspaceId, "not-exported", {
      withExport: false,
    });

    let calls = 0;
    const summary = await publishDueScheduledPosts(prisma, {
      now: () => new Date("2026-07-20T12:00:00Z"),
      resolvePageAccessToken: async () => {
        calls++;
        return "unused";
      },
      publishScheduledVideo: async () => {
        calls++;
        return { facebookPostId: "unused" };
      },
    });

    expect(summary.postsSkippedNotExported).toBeGreaterThanOrEqual(1);
    expect(calls).toBe(0);

    const untouched = await prisma.scheduledPost.findUniqueOrThrow({ where: { id: scheduledPostId } });
    expect(untouched.publishStatus).toBe("NOT_STARTED");
  });

  it("re-queues a failed row with backoff, and fails terminally once attempts are exhausted", async () => {
    const workspaceId = await createWorkspace("Publish Failure", eligibleSettings);
    const scheduledPostId = await createDueScheduledPost(workspaceId, "failure");

    const failingDeps = {
      now: () => new Date("2026-07-20T12:00:00Z"),
      resolvePageAccessToken: async () => "page-token-abc",
      publishScheduledVideo: async () => {
        throw new Error("Facebook API rejected the request (HTTP 403, Invalid OAuth access token).");
      },
    };

    const summary = await publishDueScheduledPosts(prisma, failingDeps);
    expect(summary.postsFailed).toBeGreaterThanOrEqual(1);

    // First failure is transient: back to NOT_STARTED with a future nextAttemptAt.
    const retried = await prisma.scheduledPost.findUniqueOrThrow({ where: { id: scheduledPostId } });
    expect(retried.publishStatus).toBe("NOT_STARTED");
    expect(retried.attemptCount).toBe(1);
    expect(retried.lastErrorMessage).toContain("Invalid OAuth access token");
    expect(retried.nextAttemptAt?.getTime()).toBeGreaterThan(new Date("2026-07-20T12:00:00Z").getTime());

    // A poll before nextAttemptAt must not pick the row up again (attemptCount unchanged).
    await publishDueScheduledPosts(prisma, failingDeps);
    const untouched = await prisma.scheduledPost.findUniqueOrThrow({ where: { id: scheduledPostId } });
    expect(untouched.attemptCount).toBe(1);
    expect(untouched.publishStatus).toBe("NOT_STARTED");

    // Exhausted attempts fail terminally.
    await prisma.scheduledPost.update({
      where: { id: scheduledPostId },
      data: { attemptCount: 4, nextAttemptAt: null },
    });
    await publishDueScheduledPosts(prisma, failingDeps);
    const failed = await prisma.scheduledPost.findUniqueOrThrow({ where: { id: scheduledPostId } });
    expect(failed.publishStatus).toBe("FAILED");
    expect(failed.attemptCount).toBe(5);
  });

  it("no-ops entirely when META_SYSTEM_USER_TOKEN is unset", async () => {
    const saved = process.env.META_SYSTEM_USER_TOKEN;
    delete process.env.META_SYSTEM_USER_TOKEN;

    const workspaceId = await createWorkspace("Publish Unconfigured", eligibleSettings);
    await createDueScheduledPost(workspaceId, "unconfigured");

    const summary = await publishDueScheduledPosts(prisma, {
      now: () => new Date("2026-07-20T12:00:00Z"),
    });

    expect(summary.postsScanned).toBe(0);
    process.env.META_SYSTEM_USER_TOKEN = saved;
  });
});
