import {
  AuthProvider,
  GeneratedClipStatus,
  Prisma,
  PrismaClient,
  ProcessingJobState,
  RenderQcStatus,
  WorkspaceRole,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assessScheduledPostDelivery } from "@/lib/delivery/query";
import { FacebookApiAuthError, FacebookApiError } from "@/lib/integrations/facebook";
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
const originalPublishingEnabled = process.env.AUTOMATIC_PUBLISHING_ENABLED;

beforeAll(() => {
  // Deliberately fake test-only token; never a real credential. Only its presence matters —
  // the publisher fails closed entirely when this is unset.
  process.env.META_SYSTEM_USER_TOKEN = "test-system-user-token-not-real";
  process.env.AUTOMATIC_PUBLISHING_ENABLED = "true";
  // The publisher also fails closed on unset/localhost app URLs (finding #9).
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
});

afterAll(async () => {
  if (originalToken === undefined) delete process.env.META_SYSTEM_USER_TOKEN;
  else process.env.META_SYSTEM_USER_TOKEN = originalToken;
  if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
  if (originalPublishingEnabled === undefined) delete process.env.AUTOMATIC_PUBLISHING_ENABLED;
  else process.env.AUTOMATIC_PUBLISHING_ENABLED = originalPublishingEnabled;
});

const createdWorkspaceIds: string[] = [];
const createdUserIds: string[] = [];

function uniqueKey(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

afterAll(async () => {
  // PublishAttempt.scheduledPost is onDelete: Restrict — a record that an external post may
  // exist must outlive a cascade, so it blocks the workspace delete. Nothing in src/ deletes a
  // workspace, so this is teardown's problem alone: clear the attempts first.
  await prisma.publishAttempt.deleteMany({
    where: { scheduledPost: { workspaceId: { in: createdWorkspaceIds } } },
  });
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

  // The clip's current cut. The bound export must be of exactly this version (P1.11).
  await prisma.clipEdit.create({
    data: { clipId: clip.id, version: 1, editorState: {}, savedBy: null },
  });

  let exportJobId: string | null = null;
  if (withExport) {
    const checksum = `sha256-${uniqueKey(label)}`;
    const exportedFile = await prisma.exportedFile.create({
      data: {
        storageKey: `exports/${workspaceId}/${uniqueKey(label)}.mp4`,
        bytes: BigInt(1024),
        width: 1080,
        height: 1920,
        checksum,
        downloadExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    const exportJob = await prisma.exportJob.create({
      data: {
        clipId: clip.id,
        workspaceId,
        state: ProcessingJobState.SUCCEEDED,
        idempotencyKey: uniqueKey(`export-${label}`),
        filename: `${label}.mp4`,
        outputFileId: exportedFile.id,
        editVersion: 1,
        qcStatus: RenderQcStatus.PASSED,
        // QC measured this exact file; delivery refuses if the two ever diverge.
        qcChecksum: checksum,
        finishedAt: new Date(),
      },
    });
    exportJobId = exportJob.id;
  }

  const scheduledPost = await prisma.scheduledPost.create({
    data: {
      workspaceId,
      projectId: project.id,
      clipId: clip.id,
      // The binding is the only route from a slot to a file. Without it nothing publishes, and
      // there is deliberately no fallback to the clip's newest successful export.
      exportJobId,
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
      // Publish mechanics, not the delivery rule: the real rule refuses every slot until
      // P2 records editorial reviews. The unstubbed rule is asserted on these same rows
      // in the last case of this file.
      assessDelivery: async () => ({ eligible: true as const }),
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
      // Publish mechanics, not the delivery rule: the real rule refuses every slot until
      // P2 records editorial reviews. The unstubbed rule is asserted on these same rows
      // in the last case of this file.
      assessDelivery: async () => ({ eligible: true as const }),
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
      // Publish mechanics, not the delivery rule: the real rule refuses every slot until
      // P2 records editorial reviews. The unstubbed rule is asserted on these same rows
      // in the last case of this file.
      assessDelivery: async () => ({ eligible: true as const }),
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
      // Publish mechanics, not the delivery rule: the real rule refuses every slot until
      // P2 records editorial reviews. The unstubbed rule is asserted on these same rows
      // in the last case of this file.
      assessDelivery: async () => ({ eligible: true as const }),
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
      // Publish mechanics, not the delivery rule: the real rule refuses every slot until
      // P2 records editorial reviews. The unstubbed rule is asserted on these same rows
      // in the last case of this file.
      assessDelivery: async () => ({ eligible: true as const }),
      resolvePageAccessToken: async () => "page-token-abc",
      publishScheduledVideo: async () => {
        // A definite refusal: nothing was created, so the backoff ladder is the right response.
        throw new FacebookApiAuthError(
          "Facebook API rejected the request (HTTP 403, Invalid OAuth access token).",
        );
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

  it("does not inspect or claim due rows while automatic publishing is disabled", async () => {
    const workspaceId = await createWorkspace("Publish Globally Disabled", eligibleSettings);
    const scheduledPostId = await createDueScheduledPost(workspaceId, "globally-disabled");
    const eventCountBefore = await prisma.operationalEvent.count({
      where: { eventType: "automatic_publishing_disabled" },
    });
    let metaCalls = 0;
    process.env.AUTOMATIC_PUBLISHING_ENABLED = "false";
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const summary = await publishDueScheduledPosts(prisma, {
          now: () => new Date("2026-07-20T12:00:00Z"),
          resolvePageAccessToken: async () => {
            metaCalls++;
            return "unused";
          },
          publishScheduledVideo: async () => {
            metaCalls++;
            return { facebookPostId: "unused" };
          },
        });
        expect(summary.postsScanned).toBe(0);
      }
    } finally {
      process.env.AUTOMATIC_PUBLISHING_ENABLED = "true";
    }

    expect(metaCalls).toBe(0);
    const untouched = await prisma.scheduledPost.findUniqueOrThrow({ where: { id: scheduledPostId } });
    expect(untouched.publishStatus).toBe("NOT_STARTED");
    expect(untouched.attemptCount).toBe(0);
    await expect(
      prisma.operationalEvent.count({ where: { eventType: "automatic_publishing_disabled" } }),
    ).resolves.toBe(eventCountBefore + 1);
  });
});

/**
 * The delivery rule against real rows, with nothing stubbed.
 *
 * The cases above inject an eligible verdict so they can reach the publish mechanics. These prove
 * that the injection hides nothing: the fixture is seeded eligible in every respect the database
 * can express — bound export, matching edit version, QC passed, checksum matching the stored file
 * — so the only thing standing between it and publication is the editorial review that P2 will
 * introduce. If a future change makes this publish, the fail-closed default has been lost.
 */
describe("delivery eligibility against a real database", () => {
  it("refuses a fully-seeded slot for exactly one reason: no editorial review yet", async () => {
    const workspaceId = await createWorkspace("Delivery Real", eligibleSettings);
    const scheduledPostId = await createDueScheduledPost(workspaceId, "delivery-real");

    const verdict = await assessScheduledPostDelivery(prisma, { scheduledPostId });
    expect(verdict).toEqual({ eligible: false, reason: "editorial_review_missing" });
  });

  it("refuses a slot bound to no export, and does not go looking for another one", async () => {
    const workspaceId = await createWorkspace("Delivery Unbound", eligibleSettings);
    const scheduledPostId = await createDueScheduledPost(workspaceId, "delivery-unbound", {
      withExport: false,
    });

    // A successful export for this clip exists in the database, but not bound to this slot.
    const post = await prisma.scheduledPost.findUniqueOrThrow({ where: { id: scheduledPostId } });
    const exportedFile = await prisma.exportedFile.create({
      data: {
        storageKey: `exports/${workspaceId}/stray.mp4`,
        bytes: BigInt(1024),
        width: 1080,
        height: 1920,
        checksum: "sha256-stray",
        downloadExpiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await prisma.exportJob.create({
      data: {
        clipId: post.clipId!,
        workspaceId,
        state: ProcessingJobState.SUCCEEDED,
        idempotencyKey: `stray-${Date.now()}`,
        filename: "stray.mp4",
        outputFileId: exportedFile.id,
        editVersion: 1,
        qcStatus: RenderQcStatus.PASSED,
        qcChecksum: "sha256-stray",
        finishedAt: new Date(),
      },
    });

    // It must not be found. The slot has no binding, so nothing is deliverable.
    const verdict = await assessScheduledPostDelivery(prisma, { scheduledPostId });
    expect(verdict).toEqual({ eligible: false, reason: "slot_export_missing" });
  });

  it("refuses once the clip is edited past the cut the bound export rendered", async () => {
    const workspaceId = await createWorkspace("Delivery Stale", eligibleSettings);
    const scheduledPostId = await createDueScheduledPost(workspaceId, "delivery-stale");
    const post = await prisma.scheduledPost.findUniqueOrThrow({ where: { id: scheduledPostId } });

    await prisma.clipEdit.create({
      data: { clipId: post.clipId!, version: 2, editorState: {}, savedBy: null },
    });

    const verdict = await assessScheduledPostDelivery(prisma, { scheduledPostId });
    expect(verdict).toEqual({ eligible: false, reason: "export_edit_version_stale" });
  });
});

/**
 * P1.12: claims, intent rows, and the rule that no clip's other export is ever reachable.
 */
describe("publish claims and intent", () => {
  it("no fallback to latest export", async () => {
    const workspaceId = await createWorkspace("No Fallback", eligibleSettings);
    const scheduledPostId = await createDueScheduledPost(workspaceId, "no-fallback");
    const post = await prisma.scheduledPost.findUniqueOrThrow({ where: { id: scheduledPostId } });
    const boundExportJobId = post.exportJobId;

    // A newer, perfectly good SUCCEEDED export of the very same clip, finished after the bound
    // one. The old code ordered by finishedAt desc and would have chosen exactly this.
    const newerFile = await prisma.exportedFile.create({
      data: {
        storageKey: `exports/${workspaceId}/newer.mp4`,
        bytes: BigInt(2048),
        width: 1080,
        height: 1920,
        checksum: "sha256-newer",
        downloadExpiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const newerExport = await prisma.exportJob.create({
      data: {
        clipId: post.clipId!,
        workspaceId,
        state: ProcessingJobState.SUCCEEDED,
        idempotencyKey: `newer-${Date.now()}`,
        filename: "newer.mp4",
        outputFileId: newerFile.id,
        editVersion: 1,
        qcStatus: RenderQcStatus.PASSED,
        qcChecksum: "sha256-newer",
        finishedAt: new Date(Date.now() + 60_000),
      },
    });

    const fileUrls: string[] = [];
    await publishDueScheduledPosts(prisma, {
      now: () => new Date("2026-07-20T15:00:00Z"),
      assessDelivery: async () => ({ eligible: true as const }),
      resolvePageAccessToken: async () => "page-token",
      publishScheduledVideo: async (input) => {
        fileUrls.push(input.fileUrl);
        return { facebookPostId: "fb-no-fallback" };
      },
    });

    // Other cases in this file leave due rows behind, so assert on the property that matters
    // rather than on how many posts this poll happened to pick up: the newer export is never the
    // one chosen, for this slot or any other.
    expect(fileUrls.some((url) => url.includes("newer.mp4"))).toBe(false);
    const attempt = await prisma.publishAttempt.findFirstOrThrow({
      where: { scheduledPostId },
    });
    expect(attempt.expectedExportJobId).toBe(boundExportJobId);
    expect(attempt.expectedExportJobId).not.toBe(newerExport.id);
  });

  it("records intent before the call and settles it as SUCCEEDED after", async () => {
    const workspaceId = await createWorkspace("Intent Settled", eligibleSettings);
    const scheduledPostId = await createDueScheduledPost(workspaceId, "intent-settled");

    await publishDueScheduledPosts(prisma, {
      now: () => new Date("2026-07-20T15:00:00Z"),
      assessDelivery: async () => ({ eligible: true as const }),
      resolvePageAccessToken: async () => "page-token",
      publishScheduledVideo: async () => {
        // Mid-call, the intent row already exists and is unsettled.
        const open = await prisma.publishAttempt.findFirstOrThrow({ where: { scheduledPostId } });
        expect(open.state).toBe("INTENT");
        return { facebookPostId: "fb-intent" };
      },
    });

    const settled = await prisma.publishAttempt.findFirstOrThrow({ where: { scheduledPostId } });
    expect(settled.state).toBe("SUCCEEDED");
    expect(settled.providerPostId).toBe("fb-intent");
  });

  it("blocks the slot and opens an exception when the outcome cannot be read", async () => {
    const workspaceId = await createWorkspace("Indeterminate", eligibleSettings);
    const scheduledPostId = await createDueScheduledPost(workspaceId, "indeterminate");

    const summary = await publishDueScheduledPosts(prisma, {
      now: () => new Date("2026-07-20T15:00:00Z"),
      assessDelivery: async () => ({ eligible: true as const }),
      resolvePageAccessToken: async () => "page-token",
      publishScheduledVideo: async () => {
        throw new FacebookApiError("Facebook API request failed (HTTP 503).", {
          indeterminate: true,
        });
      },
    });

    expect(summary.postsIndeterminate).toBe(1);
    const slot = await prisma.scheduledPost.findUniqueOrThrow({ where: { id: scheduledPostId } });
    expect(slot.publishStatus).toBe("BLOCKED");
    expect(slot.nextAttemptAt).toBeNull();

    const exception = await prisma.editorialException.findFirstOrThrow({
      where: { scheduledPostId, exceptionType: "indeterminate_publish_outcome" },
    });
    expect(exception.state).toBe("OPEN");

    const attempt = await prisma.publishAttempt.findFirstOrThrow({ where: { scheduledPostId } });
    expect(attempt.state).toBe("INDETERMINATE");
  });

  it("refuses the claim when the slot's clip changed after the decision", async () => {
    const workspaceId = await createWorkspace("Replacement Race", eligibleSettings);
    const scheduledPostId = await createDueScheduledPost(workspaceId, "race");
    let metaCalls = 0;

    await publishDueScheduledPosts(prisma, {
      now: () => new Date("2026-07-20T15:00:00Z"),
      // A reserve is swapped into the slot between the read and the claim.
      assessDelivery: async () => {
        await prisma.scheduledPost.update({
          where: { id: scheduledPostId },
          data: { clipId: null },
        });
        return { eligible: true as const };
      },
      resolvePageAccessToken: async () => "page-token",
      publishScheduledVideo: async () => {
        metaCalls++;
        return { facebookPostId: "fb-race" };
      },
    });

    expect(metaCalls).toBe(0);
    const slot = await prisma.scheduledPost.findUniqueOrThrow({ where: { id: scheduledPostId } });
    expect(slot.publishStatus).toBe("NOT_STARTED");
    expect(await prisma.publishAttempt.count({ where: { scheduledPostId } })).toBe(0);
  });
});

