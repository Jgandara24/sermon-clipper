import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  GeneratedClipStatus,
  ProcessingJobState,
  RenderQcStatus,
  WorkspaceRole,
  MemberStatus,
} from "@prisma/client";
import { prisma } from "../../src/lib/prisma";
import { getStorageProvider } from "../../src/lib/storage";
import { signInAs, signOutTestSessions } from "./auth-session";

process.env.STORAGE_LOCAL_ROOT = path.join(process.cwd(), ".data", "e2e-storage");
process.env.WHISPER_MODEL_PATH = "";

/**
 * The operator review surfaces, from the browser.
 *
 * Two things are worth proving here rather than in an integration test: that the marker is what
 * opens the page (a church owner with every workspace permission is turned away), and that the
 * page shows the exact file's identity while showing nothing of the selector's opinion.
 */

const createdWorkspaceIds: string[] = [];
const createdUserIds: string[] = [];
let serial = 0;

type Fixture = {
  operatorId: string;
  churchOwnerId: string;
  scheduledPostId: string;
  clipTitle: string;
  clipHook: string;
  exportJobId: string;
  checksum: string;
};

async function createUser(label: string, isPlatformOperator: boolean) {
  serial += 1;
  const user = await prisma.user.create({
    data: {
      email: `operator-e2e-${label}-${serial}-${Date.now()}@example.com`,
      isPlatformOperator,
    },
  });
  createdUserIds.push(user.id);
  return user;
}

async function createChurchWorkspace(ownerId: string, name: string) {
  const workspace = await prisma.workspace.create({ data: { ownerId, name } });
  createdWorkspaceIds.push(workspace.id);
  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: ownerId, role: WorkspaceRole.OWNER, status: MemberStatus.ACTIVE },
  });
  return workspace;
}

async function buildFixture(): Promise<Fixture> {
  const operator = await createUser("operator", true);
  const churchOwner = await createUser("church-owner", false);

  // The operator needs a workspace of their own only because /app's layout requires one; it is
  // never the workspace whose work they review.
  await createChurchWorkspace(operator.id, "Operator's own workspace");
  const church = await createChurchWorkspace(churchOwner.id, "Reviewed Church");

  const project = await prisma.project.create({
    data: { workspaceId: church.id, name: "Sunday Service" },
  });
  const clip = await prisma.generatedClip.create({
    data: {
      workspaceId: church.id,
      projectId: project.id,
      rank: 1,
      startMs: 0,
      endMs: 60_000,
      title: "Peace stays with us",
      hookText: "What peace actually costs",
      summary: "E2E fixture.",
      status: GeneratedClipStatus.KEPT,
    },
  });
  // The selector's opinion exists, and must not appear on the page.
  await prisma.clipScore.create({
    data: {
      workspaceId: church.id,
      clipId: clip.id,
      total: 91,
      subscores: { hook: 5 },
      modelVersion: "selector-e2e",
      excerpt: "SELECTOR-RATIONALE-MARKER",
    },
  });

  // A row on its own is not a file. Without bytes on disk the signed link returns 404, which
  // would let the scoping assertion below pass for the wrong reason — the point of that check is
  // that the link *works*, not merely that it is shaped correctly.
  const storageKey = `${church.id}/exports/e2e-review.mp4`;
  const absolutePath = getStorageProvider().absolutePath(storageKey);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, Buffer.alloc(2048, 1));

  const outputFile = await prisma.exportedFile.create({
    data: {
      storageKey,
      bytes: BigInt(2048),
      width: 1080,
      height: 1920,
      checksum: "sha256:e2e-review",
      downloadExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  const exportJob = await prisma.exportJob.create({
    data: {
      workspaceId: church.id,
      clipId: clip.id,
      state: ProcessingJobState.SUCCEEDED,
      idempotencyKey: `operator-e2e-${Date.now()}`,
      filename: "e2e-review.mp4",
      editVersion: 2,
      qcStatus: RenderQcStatus.PASSED,
      qcCheckedAt: new Date(),
      qcChecksum: "sha256:e2e-review",
      outputFileId: outputFile.id,
    },
  });
  const slot = await prisma.scheduledPost.create({
    data: {
      workspaceId: church.id,
      projectId: project.id,
      clipId: clip.id,
      exportJobId: exportJob.id,
      scheduledDate: new Date(Date.UTC(2040, 0, 7)),
    },
  });

  return {
    operatorId: operator.id,
    churchOwnerId: churchOwner.id,
    scheduledPostId: slot.id,
    clipTitle: clip.title,
    clipHook: clip.hookText as string,
    exportJobId: exportJob.id,
    checksum: "sha256:e2e-review",
  };
}

/** A second sermon, for the one test that destroys what it touches. */
async function buildReplaceableSlot() {
  const church = await prisma.scheduledPost.findUniqueOrThrow({
    where: { id: fixture.scheduledPostId },
    select: { workspaceId: true },
  });
  const project = await prisma.project.create({
    data: { workspaceId: church.workspaceId, name: `Replaceable ${Date.now()}` },
  });
  const rejected = await prisma.generatedClip.create({
    data: {
      workspaceId: church.workspaceId,
      projectId: project.id,
      rank: 1,
      startMs: 0,
      endMs: 60_000,
      title: "The clip being replaced",
      summary: "E2E replace fixture.",
      status: GeneratedClipStatus.KEPT,
    },
  });
  const reserve = await prisma.generatedClip.create({
    data: {
      workspaceId: church.workspaceId,
      projectId: project.id,
      rank: 2,
      startMs: 0,
      endMs: 45_000,
      title: "The reserve clip",
      summary: "E2E reserve.",
      status: GeneratedClipStatus.KEPT,
    },
  });
  const exportJob = await prisma.exportJob.create({
    data: {
      workspaceId: church.workspaceId,
      clipId: rejected.id,
      state: ProcessingJobState.SUCCEEDED,
      idempotencyKey: `e2e-replace-${Date.now()}`,
      filename: "replaceable.mp4",
      editVersion: 0,
      qcStatus: RenderQcStatus.PASSED,
      qcCheckedAt: new Date(),
      qcChecksum: `sha256:replaceable-${Date.now()}`,
    },
  });
  const slot = await prisma.scheduledPost.create({
    data: {
      workspaceId: church.workspaceId,
      projectId: project.id,
      clipId: rejected.id,
      exportJobId: exportJob.id,
      scheduledDate: new Date(Date.UTC(2040, 1, 4)),
    },
  });
  return { scheduledPostId: slot.id, rejectedClipId: rejected.id, reserve };
}

let fixture: Fixture;

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

test.describe("Operator review queue", () => {
  test("an operator sees another church's slot, and the nav item that leads to it", async ({
    page,
    context,
  }) => {
    await signInAs(context, fixture.operatorId);
    await page.goto("/app/operator/review");

    await expect(page.getByRole("heading", { name: "Review queue" })).toBeVisible();
    await expect(page.getByTestId("review-queue")).toContainText("Reviewed Church");
    await expect(page.getByTestId("review-queue")).toContainText(fixture.clipTitle);

    await expect(page.getByRole("link", { name: "Review queue" })).toBeVisible();
  });

  test("a church owner is turned away, and never offered the nav item", async ({
    page,
    context,
  }) => {
    // The owner holds every permission their workspace can grant. None of them is this one.
    await signInAs(context, fixture.churchOwnerId);
    await page.goto("/app/operator/review");

    await expect(page).toHaveURL(/\/app\?error=permission-denied/);
    await expect(page.getByRole("link", { name: "Review queue" })).toHaveCount(0);
  });

  test("a church owner cannot reach a detail page by typing its address", async ({
    page,
    context,
  }) => {
    await signInAs(context, fixture.churchOwnerId);
    await page.goto(`/app/operator/review/${fixture.scheduledPostId}`);

    await expect(page).toHaveURL(/\/app\?error=permission-denied/);
    await expect(page.getByTestId("review-identity")).toHaveCount(0);
  });
});

test.describe("The exact file under review", () => {
  test.beforeEach(async ({ context }) => {
    await signInAs(context, fixture.operatorId);
  });

  test("plays the bound export, signed for the church that owns it", async ({ page }) => {
    await page.goto(`/app/operator/review/${fixture.scheduledPostId}`);

    const player = page.getByTestId("review-player");
    await expect(player).toBeVisible();

    const src = await player.getAttribute("src");
    expect(src).toContain("/api/media/signed");
    // The reviewed church's workspace, not the operator's own. Signing with the operator's id
    // would produce a link the media route refuses.
    const reviewedWorkspace = await prisma.scheduledPost.findUniqueOrThrow({
      where: { id: fixture.scheduledPostId },
      select: { workspaceId: true },
    });
    expect(src).toContain(`workspaceId=${reviewedWorkspace.workspaceId}`);

    // And the link actually works, rather than merely looking right.
    const response = await page.request.get(src as string);
    expect(response.status()).toBeLessThan(400);
  });

  test("names the four facts the decision will be recorded against", async ({ page }) => {
    await page.goto(`/app/operator/review/${fixture.scheduledPostId}`);

    const identity = page.getByTestId("review-identity");
    await expect(identity).toContainText(fixture.exportJobId);
    await expect(identity).toContainText(fixture.checksum);
    await expect(identity).toContainText("2");
    await expect(page.getByTestId("review-qc")).toContainText("PASSED");
  });

  test("shows the title and hook as fields under review", async ({ page }) => {
    await page.goto(`/app/operator/review/${fixture.scheduledPostId}`);

    await expect(page.getByTestId("review-title")).toHaveText(fixture.clipTitle);
    await expect(page.getByTestId("review-hook")).toHaveText(fixture.clipHook);
    await expect(page.getByText("Machine-generated, under review")).toBeVisible();
  });

  test("records an ACCEPT against the exact file, and shows it in the history", async ({ page }) => {
    await page.goto(`/app/operator/review/${fixture.scheduledPostId}`);

    const decisionForm = page.getByTestId("review-decision-form");
    await decisionForm.getByLabel("Decision note").fill("Lands cleanly.");
    await page.getByTestId("review-accept").click();

    await expect(decisionForm.getByTestId("review-success")).toContainText("Accepted");
    await expect(page.getByTestId("review-history")).toContainText("ACCEPT");

    const stored = await prisma.clipReview.findFirstOrThrow({
      where: { scheduledPostIdSnapshot: fixture.scheduledPostId },
      orderBy: { createdAt: "desc" },
    });
    // Recorded against the file that was on screen, not against whatever is newest.
    expect(stored.exportJobIdSnapshot).toBe(fixture.exportJobId);
    expect(stored.checksum).toBe(fixture.checksum);
    expect(stored.editVersion).toBe(2);
    expect(stored.note).toBe("Lands cleanly.");
  });

  test("records a REVISE carrying several findings at once", async ({ page }) => {
    await page.goto(`/app/operator/review/${fixture.scheduledPostId}`);

    const decisionForm = page.getByTestId("review-decision-form");
    await decisionForm.getByLabel("Finding 1 category").selectOption("BOUNDARY");
    await decisionForm.getByLabel("Finding 1 note").fill("Starts a sentence early.");
    await decisionForm.getByLabel("Finding 1 start").fill("0");
    await decisionForm.getByLabel("Finding 1 end").fill("1500");

    await decisionForm.getByRole("button", { name: "Add another finding" }).click();
    await decisionForm.getByLabel("Finding 2 category").selectOption("CAPTION");
    await decisionForm.getByLabel("Finding 2 note").fill("Caption sits over the chin.");

    await page.getByTestId("review-revise").click();

    await expect(decisionForm.getByTestId("review-success")).toContainText("Revision requested");

    const review = await prisma.clipReview.findFirstOrThrow({
      where: { scheduledPostIdSnapshot: fixture.scheduledPostId, decision: "REVISE" },
      include: { feedback: true },
      orderBy: { createdAt: "desc" },
    });
    expect(review.feedback).toHaveLength(2);
    // Both are fixable by re-editing, which is what a REVISE promises.
    expect(review.feedback.every((row) => row.actionability === "REVISABLE")).toBe(true);
  });

  test("refuses a REVISE whose finding needs a different clip, and saves nothing", async ({
    page,
  }) => {
    const before = await prisma.clipReview.count({
      where: { scheduledPostIdSnapshot: fixture.scheduledPostId },
    });

    await page.goto(`/app/operator/review/${fixture.scheduledPostId}`);
    const decisionForm = page.getByTestId("review-decision-form");
    await decisionForm.getByLabel("Finding 1 category").selectOption("CONTENT");
    await decisionForm.getByLabel("Finding 1 note").fill("The point never lands.");
    await page.getByTestId("review-revise").click();

    await expect(decisionForm.getByTestId("review-error")).toContainText(
      "replacement rather than a revision",
    );
    expect(
      await prisma.clipReview.count({ where: { scheduledPostIdSnapshot: fixture.scheduledPostId } }),
    ).toBe(before);
  });

  test("replaces the clip with the sermon's next reserve, in one transaction", async ({ page }) => {
    // Its own sermon. A replacement supersedes a clip and rebinds the slot to a reserve whose
    // render has not finished, so the shared fixture would not survive it — and the tests after
    // this one would fail for reasons that have nothing to do with them.
    const own = await buildReplaceableSlot();
    const reserve = own.reserve;

    await page.goto(`/app/operator/review/${own.scheduledPostId}`);
    const decisionForm = page.getByTestId("review-decision-form");
    await decisionForm.getByLabel("Finding 1 category").selectOption("CONTENT");
    await decisionForm.getByLabel("Finding 1 note").fill("The point never lands.");
    await page.getByTestId("review-replace").click();

    // The decision form is gone, because the promoted reserve's render has not finished and there
    // is nothing to decide about yet. That is the honest state, so the page says so rather than
    // leaving the operator wondering whether the replacement worked.
    await expect(page.getByTestId("review-undecidable")).toContainText("render has not finished");
    await expect(page.getByTestId("review-history")).toContainText("REPLACE");
    await expect(page.getByTestId("review-title")).toHaveText("The reserve clip");

    // The slot holds the reserve and the reserve's own priority render, on the same date.
    const after = await prisma.scheduledPost.findUniqueOrThrow({
      where: { id: own.scheduledPostId },
      include: { exportJob: true },
    });
    expect(after.clipId).toBe(reserve.id);
    expect(after.exportJob?.clipId).toBe(reserve.id);
    expect(after.exportJob?.priority).toBeGreaterThan(0);
    expect(after.publishStatus).toBe("NOT_STARTED");

    // The rejected clip is superseded, and the decision names both.
    const review = await prisma.clipReview.findFirstOrThrow({
      where: { scheduledPostIdSnapshot: own.scheduledPostId, decision: "REPLACE" },
      orderBy: { createdAt: "desc" },
    });
    expect(review.replacementClipIdSnapshot).toBe(reserve.id);
    expect(review.clipIdSnapshot).toBe(own.rejectedClipId);
    await expect(
      prisma.generatedClip.findUniqueOrThrow({ where: { id: own.rejectedClipId } }),
    ).resolves.toMatchObject({ status: GeneratedClipStatus.SUPERSEDED });
  });

  test("adds a finding to a decision that already exists", async ({ page }) => {
    await page.goto(`/app/operator/review/${fixture.scheduledPostId}`);
    await page.getByTestId("review-accept").click();
    await expect(page.getByTestId("review-decision-form").getByTestId("review-success")).toBeVisible();

    const review = await prisma.clipReview.findFirstOrThrow({
      where: { scheduledPostIdSnapshot: fixture.scheduledPostId },
      orderBy: { createdAt: "desc" },
    });

    await page.reload();
    await page.getByText("Add a finding to this decision").first().click();
    const laterForm = page.getByTestId("review-add-feedback-form").first();
    await laterForm.getByLabel("Finding 1 note").fill("Noticed on a rewatch.");
    await laterForm.getByTestId("review-add-feedback").click();

    await expect(laterForm.getByTestId("review-success")).toContainText("Added 1 finding");

    // The decision itself did not move. Only findings were appended to it.
    const after = await prisma.clipReview.findUniqueOrThrow({
      where: { id: review.id },
      include: { feedback: true },
    });
    expect(after.decision).toBe(review.decision);
    expect(after.feedback.length).toBeGreaterThan(0);
  });

  test("shows nothing of what the selector thought", async ({ page }) => {
    await page.goto(`/app/operator/review/${fixture.scheduledPostId}`);
    await expect(page.getByTestId("review-identity")).toBeVisible();

    // A reviewer who has seen the machine's confidence is no longer independent of it (S14).
    const body = await page.locator("body").innerText();
    expect(body).not.toContain("SELECTOR-RATIONALE-MARKER");
    expect(body).not.toContain("selector-e2e");
    expect(body).not.toContain("subscores");

    // Including in the RSC payload, which a hidden element would still carry.
    const html = await page.content();
    expect(html).not.toContain("SELECTOR-RATIONALE-MARKER");
    expect(html).not.toContain("selector-e2e");
  });
});
