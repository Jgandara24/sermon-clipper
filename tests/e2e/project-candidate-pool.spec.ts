import { expect, test } from "@playwright/test";
import {
  GeneratedClipStatus,
  MemberStatus,
  ProcessingJobState,
  RenderQcStatus,
  WorkspaceRole,
} from "@prisma/client";
import { prisma } from "../../src/lib/prisma";
import { signInAs, signOutTestSessions } from "./auth-session";

/**
 * The candidate pool as a church sees it.
 *
 * Two things are worth proving from a browser rather than from a unit test. That the page shows
 * the number of clips that *exist* — a church is never told a ceiling it cannot see or change
 * (plan §2.2, product-owner Decision 1). And that the Selector's opinion of a church's own sermon
 * reaches neither the HTML nor the API, though the score row is there in the database to leak.
 */

const createdWorkspaceIds: string[] = [];
const createdUserIds: string[] = [];
let serial = 0;

type Fixture = {
  ownerId: string;
  projectId: string;
  olderProjectId: string;
  scheduledClipId: string;
  borrowedClipId: string;
};

let fixture: Fixture;

function nextDate() {
  serial += 1;
  return new Date(Date.UTC(2046, 0, serial));
}

function uniqueKey(label: string) {
  serial += 1;
  return `${label}-${serial}-${Date.now()}`;
}

async function createClip(
  workspaceId: string,
  projectId: string,
  rank: number,
  options: { status?: GeneratedClipStatus; supersededAt?: Date } = {},
) {
  return prisma.generatedClip.create({
    data: {
      workspaceId,
      projectId,
      rank,
      startMs: rank * 60_000,
      endMs: rank * 60_000 + 42_000,
      title: `Pool candidate ${rank}`,
      hookText: `Hook for candidate ${rank}`,
      summary: `Summary for candidate ${rank}.`,
      status: options.status ?? GeneratedClipStatus.KEPT,
      supersededAt: options.supersededAt ?? null,
    },
  });
}

async function buildFixture(): Promise<Fixture> {
  const owner = await prisma.user.create({
    data: { email: `${uniqueKey("pool-owner")}@example.com` },
  });
  createdUserIds.push(owner.id);
  const workspace = await prisma.workspace.create({
    data: { ownerId: owner.id, name: "Pool Church" },
  });
  createdWorkspaceIds.push(workspace.id);
  await prisma.workspaceMember.create({
    data: {
      workspaceId: workspace.id,
      userId: owner.id,
      role: WorkspaceRole.OWNER,
      status: MemberStatus.ACTIVE,
    },
  });

  const video = await prisma.sourceVideo.create({
    data: {
      workspaceId: workspace.id,
      origin: "UPLOAD",
      filename: "pool.mp4",
      storageKey: `src/${workspace.id}/pool.mp4`,
      language: "en",
    },
  });

  const older = await prisma.project.create({
    data: { workspaceId: workspace.id, name: "Earlier service", sourceVideoId: video.id },
  });
  const project = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: "This service",
      sourceVideoId: video.id,
      // A frozen ceiling of 18 that the page must never mention.
      processingConfig: { targetClipCount: 6, candidateLimit: 18 },
    },
  });

  // Rank 1 is scheduled and rendered; 2 and 4 are reserves; 3 is retired; 5 was hidden.
  const scheduled = await createClip(workspace.id, project.id, 1);
  await createClip(workspace.id, project.id, 2);
  await createClip(workspace.id, project.id, 3, { supersededAt: new Date() });
  await createClip(workspace.id, project.id, 4);
  await createClip(workspace.id, project.id, 5, { status: GeneratedClipStatus.HIDDEN });

  // The Selector's opinion exists in the database, so the leak assertions prove a removal.
  await prisma.clipScore.create({
    data: {
      workspaceId: workspace.id,
      clipId: scheduled.id,
      total: 93,
      subscores: { hook: { score: 9, letter: "A", note: "Lands immediately." } },
      modelVersion: "selector-e2e-1",
      excerpt: "The sentence the Selector leaned on.",
    },
  });

  const checksum = `sha256-${uniqueKey("pool")}`;
  const job = await prisma.exportJob.create({
    data: {
      workspaceId: workspace.id,
      clipId: scheduled.id,
      state: ProcessingJobState.SUCCEEDED,
      idempotencyKey: uniqueKey("pool-export"),
      filename: "scheduled.mp4",
      editVersion: 1,
      qcStatus: RenderQcStatus.PASSED,
      qcChecksum: checksum,
    },
  });
  await prisma.scheduledPost.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      clipId: scheduled.id,
      exportJobId: job.id,
      scheduledDate: nextDate(),
    },
  });

  // A second date of this service, filled by a clip from the earlier one.
  const borrowed = await createClip(workspace.id, older.id, 2);
  await prisma.scheduledPost.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      clipId: borrowed.id,
      scheduledDate: nextDate(),
    },
  });

  return {
    ownerId: owner.id,
    projectId: project.id,
    olderProjectId: older.id,
    scheduledClipId: scheduled.id,
    borrowedClipId: borrowed.id,
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

test.describe("the candidate pool a church sees", () => {
  test("counts the clips that exist, and never a configured ceiling", async ({ page, context }) => {
    await signInAs(context, fixture.ownerId);
    await page.goto(`/app/projects/${fixture.projectId}`);

    // Five candidates belong to this service. The borrowed fill is shown but is not one of them.
    await expect(page.getByTestId("candidate-pool-count")).toHaveText(
      "5 ranked clips from this service.",
    );

    const html = await page.content();
    expect(html).not.toContain("up to 18");
    expect(html).not.toContain("of 18");
    expect(html).not.toContain("18 clips");
  });

  test("sorts candidates into going out, in reserve, and set aside", async ({ page, context }) => {
    await signInAs(context, fixture.ownerId);
    await page.goto(`/app/projects/${fixture.projectId}`);

    const scheduled = page.getByTestId("candidate-section-scheduled");
    await expect(scheduled).toContainText("Pool candidate 1");
    await expect(scheduled.getByTestId("candidate-state-SCHEDULED")).toBeVisible();

    // Rank order is the selector's and survives every section boundary: 2 then 4. Card titles
    // are h4 under the section's own h3, so this reads the cards and not the heading above them.
    const reserves = page.getByTestId("candidate-section-reserves");
    const reserveTitles = await reserves.locator("h4").allTextContents();
    expect(reserveTitles).toEqual(["Pool candidate 2", "Pool candidate 4"]);

    // A reserve has no final render, and the page says why rather than reporting a fault.
    await expect(reserves).toContainText("Preview only");
    await expect(reserves).not.toContainText("failed");

    const retired = page.getByTestId("candidate-section-retired");
    await expect(retired.getByTestId("candidate-state-SUPERSEDED")).toBeVisible();
    await expect(retired.getByTestId("candidate-state-HIDDEN")).toBeVisible();
  });

  /**
   * The distinction P3.1 exists to keep. The borrowed clip fills this service's second date, and
   * calling it a replacement would tell the church this sermon produced one.
   */
  test("labels a clip from an earlier service distinctly", async ({ page, context }) => {
    await signInAs(context, fixture.ownerId);
    await page.goto(`/app/projects/${fixture.projectId}`);

    const scheduled = page.getByTestId("candidate-section-scheduled");
    await expect(scheduled.getByTestId("candidate-state-PRIOR_SERVICE_FILL")).toBeVisible();
    await expect(scheduled.getByTestId("candidate-state-SELECTED_REPLACEMENT")).toHaveCount(0);
  });

  test("keeps rank when a replacement takes a date", async ({ page, context }) => {
    // Retire rank 1 and give its date to rank 4, exactly as P2.7 leaves things.
    const slot = await prisma.scheduledPost.findFirstOrThrow({
      where: { clipId: fixture.scheduledClipId },
    });
    const promoted = await prisma.generatedClip.findFirstOrThrow({
      where: { projectId: fixture.projectId, rank: 4 },
    });
    await prisma.$transaction([
      prisma.scheduledPost.update({
        where: { id: slot.id },
        data: { clipId: promoted.id, exportJobId: null },
      }),
      prisma.generatedClip.update({
        where: { id: fixture.scheduledClipId },
        data: { supersededAt: new Date(), status: GeneratedClipStatus.SUPERSEDED },
      }),
      prisma.clipReview.create({
        data: {
          workspaceId: (await prisma.project.findFirstOrThrow({ where: { id: fixture.projectId } }))
            .workspaceId,
          projectIdSnapshot: fixture.projectId,
          scheduledPostIdSnapshot: slot.id,
          clipIdSnapshot: fixture.scheduledClipId,
          clipRank: 1,
          clipStartMs: 60_000,
          clipEndMs: 102_000,
          exportJobIdSnapshot: slot.exportJobId as string,
          editVersion: 1,
          checksum: "sha256-superseded",
          decision: "REPLACE",
          replacementClipIdSnapshot: promoted.id,
        },
      }),
    ]);

    await signInAs(context, fixture.ownerId);
    await page.goto(`/app/projects/${fixture.projectId}`);

    const scheduled = page.getByTestId("candidate-section-scheduled");
    await expect(scheduled.getByTestId("candidate-state-SELECTED_REPLACEMENT")).toBeVisible();
    // Promotion does not renumber: the replacement is still rank 4.
    await expect(scheduled).toContainText("Rank 4");
    await expect(page.getByTestId("candidate-section-retired")).toContainText("Pool candidate 1");
    // And the pool is still five clips; a replacement moves one, it does not remove one.
    await expect(page.getByTestId("candidate-pool-count")).toHaveText(
      "5 ranked clips from this service.",
    );
  });

  test("shows nothing of what the selector thought, in the page or the API", async ({
    page,
    context,
  }) => {
    await signInAs(context, fixture.ownerId);
    await page.goto(`/app/projects/${fixture.projectId}`);

    // Distinctive strings are checked against the raw HTML, where they could hide in an
    // attribute as easily as in the body.
    const html = await page.content();
    for (const forbidden of ["selector-e2e-1", "The sentence the Selector leaned on"]) {
      expect(html).not.toContain(forbidden);
    }

    // Two score digits can also appear inside chunk hashes or the account email's timestamp.
    // Check the visible numeric value, not a substring of an unrelated longer number.
    const visible = await page.locator("body").innerText();
    expect(visible).not.toMatch(/(^|\D)93(\D|$)/);
    expect(visible).not.toContain("Score");
    await expect(page.getByText("score breakdown")).toHaveCount(0);

    const api = await page.request.get(`/api/projects/${fixture.projectId}/clips`);
    expect(api.status()).toBe(200);
    const body = await api.text();
    expect(body).toContain("Pool candidate");
    for (const forbidden of [
      "score",
      "subscores",
      "modelVersion",
      "excerpt",
      "rationale",
      "candidateLimit",
      "hiddenOverride",
      "masterDefault",
      "hardMaximum",
    ]) {
      expect(body).not.toContain(forbidden);
    }
  });
});
