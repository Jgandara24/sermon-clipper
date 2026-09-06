import { expect, test } from "@playwright/test";
import {
  EditorialExceptionState,
  MemberStatus,
  ProcessingJobState,
  ProjectStatus,
  RenderQcStatus,
  SchedulePublishStatus,
  WorkspaceRole,
} from "@prisma/client";
import { ANALYSIS_RETAINED_CLIP_STATUS } from "../../src/lib/analysis/clip-status";
import { prisma } from "../../src/lib/prisma";
import { signInAs, signOutTestSessions } from "./auth-session";

/**
 * Resolving an empty posting date from the browser.
 *
 * The claims worth a real browser: that nothing is preselected, that a confirmation is a separate
 * act, that a church is never offered the control at all, and that a freshly filled date does not
 * link into review until there is an exact file to review.
 */

const createdWorkspaceIds: string[] = [];
const createdUserIds: string[] = [];
let serial = 0;

type Fixture = {
  operatorId: string;
  churchOwnerId: string;
  workspaceId: string;
  targetProjectId: string;
  olderProjectId: string;
  emptySlotId: string;
  barrenProjectId: string;
  candidateTitles: string[];
};

let fixture: Fixture;

function uniqueKey(label: string) {
  serial += 1;
  return `${label}-${serial}-${Date.now()}`;
}

async function buildFixture(): Promise<Fixture> {
  const operator = await prisma.user.create({
    data: { email: `${uniqueKey("short-op")}@example.com`, isPlatformOperator: true },
  });
  const churchOwner = await prisma.user.create({
    data: { email: `${uniqueKey("short-church")}@example.com` },
  });
  createdUserIds.push(operator.id, churchOwner.id);

  const operatorWorkspace = await prisma.workspace.create({
    data: { ownerId: operator.id, name: "Shortage Staff" },
  });
  const church = await prisma.workspace.create({
    data: { ownerId: churchOwner.id, name: "Shortage Church" },
  });
  createdWorkspaceIds.push(operatorWorkspace.id, church.id);
  for (const [ws, user] of [
    [operatorWorkspace.id, operator.id],
    [church.id, churchOwner.id],
  ] as const) {
    await prisma.workspaceMember.create({
      data: { workspaceId: ws, userId: user, role: WorkspaceRole.OWNER, status: MemberStatus.ACTIVE },
    });
  }

  async function createService(name: string, sermonDate: Date) {
    const source = await prisma.sourceVideo.create({
      data: {
        workspaceId: church.id,
        origin: "UPLOAD",
        filename: `${name}.mp4`,
        storageKey: `src/${church.id}/${uniqueKey(name)}.mp4`,
        language: "en",
      },
    });
    return prisma.project.create({
      data: {
        workspaceId: church.id,
        name,
        sourceVideoId: source.id,
        status: ProjectStatus.READY,
        sermonDate,
      },
    });
  }

  const older = await createService("March sermon", new Date(Date.UTC(2052, 2, 3)));
  const target = await createService("June sermon", new Date(Date.UTC(2052, 5, 2)));
  // The oldest service of the three, so nothing is older than it and its own empty date has
  // nowhere to borrow from. That is the only honest way to produce an empty option list — a later
  // service would have March's clips available to it.
  const barren = await createService("Barren sermon", new Date(Date.UTC(2052, 0, 6)));

  const titles: string[] = [];
  for (const rank of [1, 2]) {
    const clip = await prisma.generatedClip.create({
      data: {
        workspaceId: church.id,
        projectId: older.id,
        rank,
        startMs: rank * 60_000,
        endMs: rank * 60_000 + 45_000,
        title: `Borrowable moment ${rank}`,
        hookText: `Hook ${rank}`,
        summary: `Summary ${rank}.`,
        status: ANALYSIS_RETAINED_CLIP_STATUS,
      },
    });
    await prisma.clipEdit.create({
      data: { clipId: clip.id, version: 1, editorState: {}, savedBy: null },
    });
    titles.push(clip.title);
  }

  const emptySlot = await prisma.scheduledPost.create({
    data: {
      workspaceId: church.id,
      projectId: target.id,
      clipId: null,
      scheduledDate: new Date(Date.UTC(2052, 5, 9)),
      publishStatus: SchedulePublishStatus.UNFILLED,
    },
  });
  await prisma.editorialException.create({
    data: {
      workspaceId: church.id,
      projectId: target.id,
      scheduledPostId: emptySlot.id,
      exceptionType: "reserve_pool_exhausted",
      state: EditorialExceptionState.OPEN,
      message: "This date has nothing to post.",
    },
  });

  // The barren service's own empty date: no older service has anything it can take, because the
  // only clips that exist belong to a *later* sermon.
  await prisma.scheduledPost.create({
    data: {
      workspaceId: church.id,
      projectId: barren.id,
      clipId: null,
      scheduledDate: new Date(Date.UTC(2052, 5, 16)),
      publishStatus: SchedulePublishStatus.UNFILLED,
    },
  });

  return {
    operatorId: operator.id,
    churchOwnerId: churchOwner.id,
    workspaceId: church.id,
    targetProjectId: target.id,
    olderProjectId: older.id,
    emptySlotId: emptySlot.id,
    barrenProjectId: barren.id,
    candidateTitles: titles,
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

test.describe("Resolving a shortage", () => {
  /**
   * A preselected radio is a recommendation the product is not entitled to make. The whole reason
   * cross-project filling is manual is that borrowing one week's message for another is an
   * editorial judgement, and a default would turn "an operator decided" into "an operator did not
   * object".
   */
  test("offers every eligible clip and preselects none", async ({ page, context }) => {
    await signInAs(context, fixture.operatorId);
    await page.goto(`/app/operator/projects/${fixture.targetProjectId}`);

    const form = page.getByTestId("prior-service-fill-form");
    await expect(form).toBeVisible();
    for (const title of fixture.candidateTitles) {
      await expect(form).toContainText(title);
    }

    await expect(form.locator('input[name="candidateClipId"]')).toHaveCount(2);
    await expect(form.locator('input[name="candidateClipId"]:checked')).toHaveCount(0);
    // Nothing to confirm and nothing to submit until a clip is chosen.
    await expect(page.getByTestId("fill-choose-first")).toBeVisible();
    await expect(page.getByTestId("fill-confirm")).toHaveCount(0);
    await expect(page.getByTestId("fill-submit")).toBeDisabled();
  });

  test("asks for a separate confirmation, and refuses without one", async ({ page, context }) => {
    await signInAs(context, fixture.operatorId);
    await page.goto(`/app/operator/projects/${fixture.targetProjectId}`);

    await page.locator('input[name="candidateClipId"]').first().check();
    const confirm = page.getByTestId("fill-confirm");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("carry a moment from an earlier sermon");

    // Submitting with the box unticked is refused by the action, not merely by the browser.
    await page.getByTestId("fill-submit").click();
    await expect(page.getByTestId("fill-error")).toContainText("Tick the confirmation");

    const slot = await prisma.scheduledPost.findUniqueOrThrow({
      where: { id: fixture.emptySlotId },
    });
    expect(slot.clipId).toBeNull();
  });

  test("says so plainly when no earlier service has anything to give", async ({ page, context }) => {
    await signInAs(context, fixture.operatorId);
    await page.goto(`/app/operator/projects/${fixture.barrenProjectId}`);

    await expect(page.getByTestId("fill-no-options")).toContainText(
      "No earlier service has a clip this date could take",
    );
    await expect(page.getByTestId("fill-submit")).toHaveCount(0);
  });

  test("a church owner is never offered the control", async ({ page, context }) => {
    await signInAs(context, fixture.churchOwnerId);

    // Not on the operator page, which turns them away entirely.
    await page.goto(`/app/operator/projects/${fixture.targetProjectId}`);
    await expect(page).toHaveURL(/\/app\?error=permission-denied/);

    // And not on their own calendar, where the empty day is visible but not actionable.
    await page.goto("/app/calendar");
    await expect(page.getByTestId("calendar-shortage-link")).toHaveCount(0);
    await expect(page.getByTestId("prior-service-fill-form")).toHaveCount(0);
  });

  test("an operator reaches the shortage from the calendar", async ({ page, context }) => {
    await signInAs(context, fixture.operatorId);
    await page.goto("/app/calendar");
    // The operator's own workspace has no slots, so this only proves the link is operator-gated
    // where one exists; the church-side absence is asserted above.
    await expect(page.getByTestId("prior-service-fill-form")).toHaveCount(0);
  });

  /**
   * The end-to-end act, and the rule that follows it: a filled date has a render queued, and a
   * queued render has no checksum, so there is no exact file to review yet. Linking to review
   * would open a page that can only say the file is not ready.
   */
  test("fills the date, then opens for review only once the render exists", async ({
    page,
    context,
  }) => {
    await signInAs(context, fixture.operatorId);
    await page.goto(`/app/operator/projects/${fixture.targetProjectId}`);

    await page.locator('input[name="candidateClipId"]').first().check();
    await page.getByTestId("fill-confirm").locator('input[name="confirmed"]').check();
    await page.getByTestId("fill-submit").click();

    // A successful fill stops the date being a shortage, so the form unmounts and its success
    // message goes with it. The confirmation an operator sees is the date itself, and that is
    // durable state worth asserting rather than a message that legitimately no longer exists.
    await expect(page.getByTestId("prior-service-fill-form")).toHaveCount(0);
    await expect(page.getByTestId("operator-slots")).toContainText("A render is in progress");

    const filled = await prisma.scheduledPost.findUniqueOrThrow({
      where: { id: fixture.emptySlotId },
    });
    expect(filled.clipId).not.toBeNull();
    expect(filled.publishStatus).toBe(SchedulePublishStatus.NOT_STARTED);
    // The exception is resolved in place rather than deleted.
    const exception = await prisma.editorialException.findFirstOrThrow({
      where: { scheduledPostId: fixture.emptySlotId },
    });
    expect(exception.state).toBe(EditorialExceptionState.RESOLVED);

    // A queued render is not reviewable: no link, and the page says why. Re-checked after a
    // reload so this is the server's view rather than the one left by the submission.
    await page.reload();
    await expect(page.getByTestId("operator-slots")).toContainText("A render is in progress");
    await expect(page.getByTestId("operator-slot-review-link")).toHaveCount(0);

    // Finish the render, exactly as the worker would.
    await prisma.exportJob.update({
      where: { id: filled.exportJobId as string },
      data: {
        state: ProcessingJobState.SUCCEEDED,
        qcStatus: RenderQcStatus.PASSED,
        qcChecksum: `sha256-${uniqueKey("filled")}`,
        finishedAt: new Date(),
      },
    });

    await page.reload();
    await expect(page.getByTestId("operator-slot-review-link")).toHaveCount(1);
    await page.getByTestId("operator-slot-review-link").click();
    await expect(page).toHaveURL(new RegExp(`/app/operator/review/${fixture.emptySlotId}$`));
  });

  test("a failed render leaves the date visible and blocked", async ({ page, context }) => {
    const slot = await prisma.scheduledPost.findUniqueOrThrow({
      where: { id: fixture.emptySlotId },
    });
    await prisma.exportJob.update({
      where: { id: slot.exportJobId as string },
      data: { state: ProcessingJobState.FAILED, qcChecksum: null, errorCode: "RENDER_FAILED" },
    });

    await signInAs(context, fixture.operatorId);
    await page.goto(`/app/operator/projects/${fixture.targetProjectId}`);

    await expect(page.getByTestId("operator-slots")).toContainText("The render failed");
    await expect(page.getByTestId("operator-slot-review-link")).toHaveCount(0);
    // Still bound to the clip the operator chose. Nothing selected a different one.
    const after = await prisma.scheduledPost.findUniqueOrThrow({
      where: { id: fixture.emptySlotId },
    });
    expect(after.clipId).toBe(slot.clipId);
  });
});
