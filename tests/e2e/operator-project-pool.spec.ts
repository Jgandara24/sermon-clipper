import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  EditorialExceptionState,
  GeneratedClipStatus,
  MemberStatus,
  ProcessingJobState,
  RenderQcStatus,
  SchedulePublishStatus,
  WorkspaceRole,
} from "@prisma/client";
import { ANALYSIS_RETAINED_CLIP_STATUS } from "../../src/lib/analysis/clip-status";
import { prisma } from "../../src/lib/prisma";
import { getStorageProvider } from "../../src/lib/storage";
import { openTranscriptionFallbackHold } from "../../src/lib/transcription/fallback-hold";
import { signInAs, signOutTestSessions } from "./auth-session";

process.env.STORAGE_LOCAL_ROOT = path.join(process.cwd(), ".data", "e2e-storage");

/**
 * A church's service, inspected by staff.
 *
 * What is worth proving from a browser: that the marker is what opens the page (a church owner
 * with every permission their workspace can grant is turned away), that media is signed for the
 * church rather than the operator, and that the page grants reading and nothing else — no control
 * to move a limit, and no sight of the Selector's opinion.
 */

const createdWorkspaceIds: string[] = [];
const createdUserIds: string[] = [];
let serial = 0;

type Fixture = {
  operatorId: string;
  churchOwnerId: string;
  churchWorkspaceId: string;
  projectId: string;
  filledSlotId: string;
  emptySlotId: string;
};

let fixture: Fixture;

function uniqueKey(label: string) {
  serial += 1;
  return `${label}-${serial}-${Date.now()}`;
}

function nextDate() {
  serial += 1;
  return new Date(Date.UTC(2048, 0, serial));
}

async function buildFixture(): Promise<Fixture> {
  const operator = await prisma.user.create({
    data: { email: `${uniqueKey("op")}@example.com`, isPlatformOperator: true },
  });
  const operatorWorkspace = await prisma.workspace.create({
    data: { ownerId: operator.id, name: "Pulpit Engine Staff" },
  });
  createdUserIds.push(operator.id);
  createdWorkspaceIds.push(operatorWorkspace.id);
  await prisma.workspaceMember.create({
    data: {
      workspaceId: operatorWorkspace.id,
      userId: operator.id,
      role: WorkspaceRole.OWNER,
      status: MemberStatus.ACTIVE,
    },
  });

  const churchOwner = await prisma.user.create({
    data: { email: `${uniqueKey("church")}@example.com` },
  });
  const church = await prisma.workspace.create({
    data: {
      ownerId: churchOwner.id,
      name: "Inspected Church",
      // A hidden override, so the staff-only limit facts have something to show.
      settings: { internalOperations: { candidateLimitOverride: 12 } },
    },
  });
  createdUserIds.push(churchOwner.id);
  createdWorkspaceIds.push(church.id);
  await prisma.workspaceMember.create({
    data: {
      workspaceId: church.id,
      userId: churchOwner.id,
      role: WorkspaceRole.OWNER,
      status: MemberStatus.ACTIVE,
    },
  });

  // A real object behind the key, so the signed URL can be fetched rather than merely inspected.
  const thumbnailKey = `${church.id}/thumbs/inspected.jpg`;
  const thumbnailPath = getStorageProvider().absolutePath(thumbnailKey);
  await mkdir(path.dirname(thumbnailPath), { recursive: true });
  await writeFile(thumbnailPath, Buffer.alloc(1024, 7));

  const video = await prisma.sourceVideo.create({
    data: {
      workspaceId: church.id,
      origin: "UPLOAD",
      filename: "inspected.mp4",
      storageKey: `src/${church.id}/inspected.mp4`,
      thumbnailKey,
      language: "en",
    },
  });

  const project = await prisma.project.create({
    data: {
      workspaceId: church.id,
      name: "Inspected Service",
      sourceVideoId: video.id,
      series: "Advent",
      speaker: "Pastor Ruiz",
      processingConfig: { targetClipCount: 6, candidateLimit: 12 },
    },
  });

  async function createClip(rank: number, status: GeneratedClipStatus = ANALYSIS_RETAINED_CLIP_STATUS) {
    return prisma.generatedClip.create({
      data: {
        workspaceId: church.id,
        projectId: project.id,
        rank,
        startMs: rank * 60_000,
        endMs: rank * 60_000 + 40_000,
        title: `Inspected candidate ${rank}`,
        hookText: `Hook ${rank}`,
        summary: `Summary ${rank}.`,
        status,
      },
    });
  }

  const scheduled = await createClip(1);
  const rejected = await createClip(2, GeneratedClipStatus.SUPERSEDED);
  await createClip(3);
  await createClip(4);

  // The machine's opinion exists, so the leak assertions prove a removal.
  await prisma.clipScore.create({
    data: {
      workspaceId: church.id,
      clipId: scheduled.id,
      total: 88,
      subscores: { hook: { score: 9, letter: "A", note: "Opens cleanly." } },
      modelVersion: "selector-operator-1",
      excerpt: "The line the Selector quoted.",
    },
  });

  const checksum = `sha256-${uniqueKey("insp")}`;
  const job = await prisma.exportJob.create({
    data: {
      workspaceId: church.id,
      clipId: scheduled.id,
      state: ProcessingJobState.SUCCEEDED,
      idempotencyKey: uniqueKey("insp-export"),
      filename: "inspected.mp4",
      editVersion: 1,
      qcStatus: RenderQcStatus.PASSED,
      qcChecksum: checksum,
    },
  });
  const filledSlot = await prisma.scheduledPost.create({
    data: {
      workspaceId: church.id,
      projectId: project.id,
      clipId: scheduled.id,
      exportJobId: job.id,
      scheduledDate: nextDate(),
    },
  });

  // What P2.7 leaves when a replacement finds no reserve: a date with nothing in it.
  const emptySlot = await prisma.scheduledPost.create({
    data: {
      workspaceId: church.id,
      projectId: project.id,
      clipId: null,
      scheduledDate: nextDate(),
      publishStatus: SchedulePublishStatus.UNFILLED,
    },
  });

  // Two lineage rows: one that promoted a reserve, one that found nothing.
  await prisma.clipReview.create({
    data: {
      workspaceId: church.id,
      projectIdSnapshot: project.id,
      scheduledPostIdSnapshot: filledSlot.id,
      clipIdSnapshot: rejected.id,
      clipRank: 2,
      clipStartMs: 120_000,
      clipEndMs: 160_000,
      exportJobIdSnapshot: job.id,
      editVersion: 1,
      checksum,
      decision: "REPLACE",
      replacementClipIdSnapshot: scheduled.id,
      replacementClipRank: 1,
      reviewerUserId: operator.id,
      note: "Audio drops out halfway.",
    },
  });
  await prisma.clipReview.create({
    data: {
      workspaceId: church.id,
      projectIdSnapshot: project.id,
      scheduledPostIdSnapshot: emptySlot.id,
      clipIdSnapshot: rejected.id,
      clipRank: 2,
      clipStartMs: 120_000,
      clipEndMs: 160_000,
      exportJobIdSnapshot: job.id,
      editVersion: 1,
      checksum,
      decision: "REPLACE",
      reviewerUserId: operator.id,
    },
  });

  await prisma.editorialException.create({
    data: {
      workspaceId: church.id,
      projectId: project.id,
      scheduledPostId: emptySlot.id,
      exceptionType: "reserve_pool_exhausted",
      state: EditorialExceptionState.OPEN,
      message: "This date has no clip left to give it.",
    },
  });
  await prisma.editorialException.create({
    data: {
      workspaceId: church.id,
      projectId: project.id,
      exceptionType: "render_qc_failed",
      state: EditorialExceptionState.RESOLVED,
      message: "A render failed quality control and was re-queued.",
      resolvedAt: new Date(),
      resolvedByUserId: operator.id,
      resolutionReason: "Re-rendered cleanly.",
    },
  });

  return {
    operatorId: operator.id,
    churchOwnerId: churchOwner.id,
    churchWorkspaceId: church.id,
    projectId: project.id,
    filledSlotId: filledSlot.id,
    emptySlotId: emptySlot.id,
  };
}

test.beforeAll(async () => {
  fixture = await buildFixture();
});

test.afterAll(async () => {
  await signOutTestSessions();
  await prisma.publishAttempt.deleteMany({
    where: { scheduledPost: { workspaceId: { in: createdWorkspaceIds } } },
  });
  await prisma.workspace.deleteMany({ where: { id: { in: createdWorkspaceIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

test.describe("Operator service inspection", () => {
  test("notifies staff about fallback across churches and clears only when the hold is resolved", async ({ page, context }) => {
    await signInAs(context, fixture.operatorId);
    const before = await context.request.get("/api/operator/transcription-alerts");
    expect(before.status()).toBe(200);
    expect(before.headers()["cache-control"]).toContain("no-store");
    const baseline = (await before.json()).data.count;

    await page.clock.install();
    await page.goto("/app/operator/review");
    await expect(page.getByTestId("operator-transcription-alerts").getByRole("link", { name: "Inspected Church · Inspected Service" })).toHaveCount(0);

    try {
      for (const jobId of ["first-attempt", "retry"]) {
        await openTranscriptionFallbackHold(prisma, {
          workspaceId: fixture.churchWorkspaceId,
          projectId: fixture.projectId,
          jobId,
          primaryProvider: "scribe",
          usedProvider: "whisper_cpp",
          reason: "failed",
        });
      }
      await page.clock.fastForward(60_001);
      const banner = page.getByTestId("operator-transcription-alert");
      await expect(banner).toContainText(`Backup transcription needs review: ${baseline + 1}`);

      // The link reloads the list even when staff already have the review page open.
      await banner.getByRole("link", { name: "View affected services" }).click();
      const alerts = page.getByTestId("operator-transcription-alerts");
      await expect(alerts.getByRole("link", { name: "Inspected Church · Inspected Service" })).toHaveCount(1);
      await expect(alerts.getByRole("link", { name: "Inspected Church · Inspected Service" })).toHaveAttribute("href", `/app/operator/projects/${fixture.projectId}`);

      // A stalled connection must time out, retain the warning, and allow the next check.
      await page.route("**/api/operator/transcription-alerts", () => {});
      const stalled = page.waitForRequest("**/api/operator/transcription-alerts");
      await page.clock.fastForward(60_001);
      await stalled;
      await page.clock.fastForward(15_001);
      await expect(banner).toContainText("could not check for new transcription alerts");
      await expect(banner).toContainText(`Backup transcription needs review: ${baseline + 1}`);
      await page.unroute("**/api/operator/transcription-alerts");
      await page.clock.fastForward(60_001);
      await expect(banner).not.toContainText("could not check for new transcription alerts");

      // A failed refresh retains the existing warning, and reports that the check failed.
      await page.route("**/api/operator/transcription-alerts", (route) => route.fulfill({ status: 503 }));
      await page.clock.fastForward(60_001);
      await expect(banner).toContainText(`Backup transcription needs review: ${baseline + 1}`);
      await expect(banner).toContainText("could not check for new transcription alerts");
      await page.unroute("**/api/operator/transcription-alerts");

      await prisma.editorialException.updateMany({
        where: { projectId: fixture.projectId, exceptionType: "transcription_provider_fallback" },
        data: { state: "RESOLVED", resolvedAt: new Date() },
      });
      await page.clock.fastForward(60_001);
      if (baseline === 0) await expect(banner).toHaveCount(0);
      else await expect(banner).toContainText(`Backup transcription needs review: ${baseline}`);
      await page.reload();
      await expect(page.getByTestId("operator-transcription-alerts").getByRole("link", { name: "Inspected Church · Inspected Service" })).toHaveCount(0);
    } finally {
      await prisma.editorialException.deleteMany({
        where: { projectId: fixture.projectId, exceptionType: "transcription_provider_fallback" },
      });
    }
  });

  test("keeps the master account alert endpoint private", async ({ page, context }) => {
    expect((await context.request.get("/api/operator/transcription-alerts")).status()).toBe(401);
    await signInAs(context, fixture.churchOwnerId);
    expect((await context.request.get("/api/operator/transcription-alerts")).status()).toBe(403);
    await page.goto("/app");
    await expect(page.getByTestId("operator-transcription-alert")).toHaveCount(0);
  });

  test("an operator reads another church's whole pool, dates included", async ({
    page,
    context,
  }) => {
    await signInAs(context, fixture.operatorId);
    await page.goto(`/app/operator/projects/${fixture.projectId}`);

    await expect(page.getByRole("heading", { name: "Inspected Service" })).toBeVisible();
    await expect(page.getByText("Inspected Church")).toBeVisible();

    // Every retained candidate, including the superseded one.
    const candidates = page.getByTestId("operator-candidates");
    for (const rank of [1, 2, 3, 4]) {
      await expect(candidates).toContainText(`Inspected candidate ${rank}`);
    }
    await expect(page.getByTestId("operator-pool-count")).toHaveText("4 retained");

    // Both dates, and the empty one called out — it has no candidate row of its own.
    await expect(page.getByTestId("operator-slot-filled")).toHaveCount(1);
    await expect(page.getByTestId("operator-slot-empty")).toHaveCount(1);
    await expect(page.getByTestId("operator-slots")).toContainText("No clip in this date");
  });

  test("a church owner is turned away from another workspace's service", async ({
    page,
    context,
  }) => {
    // The owner holds every permission their own workspace can grant. None of them is this one.
    await signInAs(context, fixture.churchOwnerId);
    await page.goto(`/app/operator/projects/${fixture.projectId}`);

    await expect(page).toHaveURL(/\/app\?error=permission-denied/);
    await expect(page.getByTestId("operator-candidates")).toHaveCount(0);
  });

  /**
   * `createSignedMediaUrl` is workspace-scoped HMAC and refuses to mint a URL for a workspace the
   * key does not live under, so an operator's own id would throw rather than produce a link that
   * 403s at playback. The id in the URL must be the church's.
   */
  test("signs media for the church that owns it, not for the operator", async ({
    page,
    context,
  }) => {
    await signInAs(context, fixture.operatorId);
    await page.goto(`/app/operator/projects/${fixture.projectId}`);

    const src = await page.getByTestId("operator-project-thumbnail").getAttribute("src");
    expect(src).toContain(`workspaceId=${fixture.churchWorkspaceId}`);

    // And it actually serves, rather than being a well-formed link that is refused.
    const response = await page.request.get(src as string);
    expect(response.status()).toBeLessThan(400);
  });

  test("shows how each date came to hold what it holds", async ({ page, context }) => {
    await signInAs(context, fixture.operatorId);
    await page.goto(`/app/operator/projects/${fixture.projectId}`);

    const lineage = page.getByTestId("operator-lineage");
    await expect(lineage).toContainText("rank 1 took its date");
    await expect(lineage).toContainText("Audio drops out halfway.");
    // The replacement that found nothing is lineage too — the most important kind.
    await expect(lineage).toContainText("nothing was available to take its date");
  });

  test("lists open exceptions above resolved ones", async ({ page, context }) => {
    await signInAs(context, fixture.operatorId);
    await page.goto(`/app/operator/projects/${fixture.projectId}`);

    await expect(page.getByTestId("operator-exception-OPEN")).toContainText(
      "This date has no clip left to give it.",
    );
    await expect(page.getByTestId("operator-exception-RESOLVED")).toContainText(
      "Re-rendered cleanly.",
    );
  });

  /**
   * The marker opens reading across workspaces and nothing else. The limits are shown because
   * "why is this pool 4 and not 18" is otherwise unanswerable, but there is no control to move
   * one — `npm run set:candidate-limit-override` is the only door, and it records who used it.
   */
  test("shows the internal limits and offers no way to change them", async ({ page, context }) => {
    await signInAs(context, fixture.operatorId);
    await page.goto(`/app/operator/projects/${fixture.projectId}`);

    const limits = page.getByTestId("operator-pool-limits");
    await expect(limits).toContainText("Hard maximum");
    await expect(limits).toContainText("12");

    await expect(limits.locator("input")).toHaveCount(0);
    await expect(limits.locator("select")).toHaveCount(0);
    await expect(limits.locator("button")).toHaveCount(0);
    await expect(limits.locator("form")).toHaveCount(0);
  });

  test("shows nothing of what the selector thought", async ({ page, context }) => {
    await signInAs(context, fixture.operatorId);
    await page.goto(`/app/operator/projects/${fixture.projectId}`);

    const html = await page.content();
    for (const forbidden of ["selector-operator-1", "The line the Selector quoted", "subscores"]) {
      expect(html).not.toContain(forbidden);
    }
    // The total is two digits, and this page is full of ids, timestamps and durations that
    // contain any given pair. The label is what a leak would actually look like.
    const visible = await page.locator("body").innerText();
    expect(visible).not.toContain("Score");
    expect(visible).not.toContain("score breakdown");
  });

  test("is reachable from the review queue and from one date's review", async ({
    page,
    context,
  }) => {
    await signInAs(context, fixture.operatorId);

    await page.goto(`/app/operator/review/${fixture.filledSlotId}`);
    await page.getByTestId("operator-project-link").click();
    await expect(page).toHaveURL(new RegExp(`/app/operator/projects/${fixture.projectId}$`));

    await page.goto("/app/operator/review");
    await page.getByRole("link", { name: "Inspected Service" }).first().click();
    await expect(page).toHaveURL(new RegExp(`/app/operator/projects/${fixture.projectId}$`));
  });
});
