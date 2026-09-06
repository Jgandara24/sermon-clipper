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
 * Moving a missed post from the browser.
 *
 * What is worth a real browser: that the control exists only for staff, that a Sunday and a past
 * date are refused by the server rather than only by the input, and that a successful move leaves
 * the rest of the week exactly where it was.
 */

const createdWorkspaceIds: string[] = [];
const createdUserIds: string[] = [];
let serial = 0;

type Fixture = {
  operatorId: string;
  churchOwnerId: string;
  projectId: string;
  missedSlotId: string;
  laterSlotId: string;
  laterSlotDate: string;
};

let fixture: Fixture;

function uniqueKey(label: string) {
  serial += 1;
  return `${label}-${serial}-${Date.now()}`;
}

async function buildFixture(): Promise<Fixture> {
  const operator = await prisma.user.create({
    data: { email: `${uniqueKey("res-op")}@example.com`, isPlatformOperator: true },
  });
  const churchOwner = await prisma.user.create({
    data: { email: `${uniqueKey("res-church")}@example.com` },
  });
  createdUserIds.push(operator.id, churchOwner.id);

  const staff = await prisma.workspace.create({
    data: { ownerId: operator.id, name: "Reschedule Staff" },
  });
  const church = await prisma.workspace.create({
    data: {
      ownerId: churchOwner.id,
      name: "Reschedule Church",
      settings: {
        churchProfile: {
          timezone: "America/Chicago",
          serviceDay: "Sunday",
          sermonsPerWeek: 1,
          postsPerDay: 1,
        },
      },
    },
  });
  createdWorkspaceIds.push(staff.id, church.id);
  for (const [ws, user] of [
    [staff.id, operator.id],
    [church.id, churchOwner.id],
  ] as const) {
    await prisma.workspaceMember.create({
      data: { workspaceId: ws, userId: user, role: WorkspaceRole.OWNER, status: MemberStatus.ACTIVE },
    });
  }

  const video = await prisma.sourceVideo.create({
    data: {
      workspaceId: church.id,
      origin: "UPLOAD",
      filename: "res.mp4",
      storageKey: `src/${church.id}/${uniqueKey("res")}.mp4`,
      language: "en",
    },
  });
  const project = await prisma.project.create({
    data: {
      workspaceId: church.id,
      name: "Reschedule service",
      sourceVideoId: video.id,
      status: ProjectStatus.READY,
      sermonDate: new Date(Date.UTC(2061, 0, 2)),
    },
  });

  async function createSlot(rank: number, date: Date, publishStatus: SchedulePublishStatus) {
    const clip = await prisma.generatedClip.create({
      data: {
        workspaceId: church.id,
        projectId: project.id,
        rank,
        startMs: rank * 60_000,
        endMs: rank * 60_000 + 30_000,
        title: `Reschedule clip ${rank}`,
        summary: `Summary ${rank}.`,
        status: ANALYSIS_RETAINED_CLIP_STATUS,
      },
    });
    const job = await prisma.exportJob.create({
      data: {
        workspaceId: church.id,
        clipId: clip.id,
        state: ProcessingJobState.SUCCEEDED,
        idempotencyKey: uniqueKey(`res-export-${rank}`),
        filename: `res-${rank}.mp4`,
        editVersion: 1,
        qcStatus: RenderQcStatus.PASSED,
        qcChecksum: `sha256-${uniqueKey(`res${rank}`)}`,
      },
    });
    return prisma.scheduledPost.create({
      data: {
        workspaceId: church.id,
        projectId: project.id,
        clipId: clip.id,
        exportJobId: job.id,
        scheduledDate: date,
        publishStatus,
      },
    });
  }

  const missed = await createSlot(1, new Date(Date.UTC(2061, 0, 5)), SchedulePublishStatus.MISSED);
  // A later post that must not move when the missed one does.
  const laterDate = new Date(Date.UTC(2061, 0, 7));
  const later = await createSlot(2, laterDate, SchedulePublishStatus.NOT_STARTED);

  await prisma.editorialException.create({
    data: {
      workspaceId: church.id,
      projectId: project.id,
      scheduledPostId: missed.id,
      exceptionType: "posting_date_missed",
      state: EditorialExceptionState.OPEN,
      message: "This date passed without publishing.",
    },
  });

  return {
    operatorId: operator.id,
    churchOwnerId: churchOwner.id,
    projectId: project.id,
    missedSlotId: missed.id,
    laterSlotId: later.id,
    laterSlotDate: laterDate.toISOString(),
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

test.describe("Rescheduling a missed post", () => {
  test("offers the control on the missed date, and nowhere else", async ({ page, context }) => {
    await signInAs(context, fixture.operatorId);
    await page.goto(`/app/operator/projects/${fixture.projectId}`);

    // Two dates on this service; only the missed one carries the form.
    await expect(page.getByTestId("operator-slot-missed")).toHaveCount(1);
    await expect(page.getByTestId("reschedule-missed-form")).toHaveCount(1);
    // Nothing is gated on client state: the form is complete and submittable before React has
    // hydrated, and the server is what refuses a missing date or a missing confirmation.
    await expect(page.getByTestId("reschedule-confirm")).toBeVisible();
    await expect(page.getByTestId("reschedule-submit")).toBeEnabled();
  });

  test("a church owner is never offered it", async ({ page, context }) => {
    await signInAs(context, fixture.churchOwnerId);
    await page.goto(`/app/operator/projects/${fixture.projectId}`);
    await expect(page).toHaveURL(/\/app\?error=permission-denied/);

    await page.goto("/app/calendar");
    await expect(page.getByTestId("reschedule-missed-form")).toHaveCount(0);
  });

  /**
   * The input will happily accept a Sunday; the server is what refuses it. Same for a date that
   * has passed — a browser's `min` attribute is a convenience, not a rule.
   */
  test("refuses a Sunday, from the server", async ({ page, context }) => {
    await signInAs(context, fixture.operatorId);
    await page.goto(`/app/operator/projects/${fixture.projectId}`);

    // 2061-06-05 is a Sunday.
    await page.getByTestId("reschedule-date").fill("2061-06-05");
    await page.getByTestId("reschedule-confirm").locator('input[name="confirmed"]').check();
    await page.getByTestId("reschedule-submit").click();

    await expect(page.getByTestId("reschedule-error")).toContainText("Sunday never receives a post");
    const slot = await prisma.scheduledPost.findUniqueOrThrow({
      where: { id: fixture.missedSlotId },
    });
    expect(slot.publishStatus).toBe(SchedulePublishStatus.MISSED);
  });

  test("refuses a date that has already passed", async ({ page, context }) => {
    await signInAs(context, fixture.operatorId);
    await page.goto(`/app/operator/projects/${fixture.projectId}`);

    await page.getByTestId("reschedule-date").fill("2020-03-04");
    await page.getByTestId("reschedule-confirm").locator('input[name="confirmed"]').check();
    await page.getByTestId("reschedule-submit").click();

    await expect(page.getByTestId("reschedule-error")).toContainText("already passed");
  });

  test("refuses without the confirmation", async ({ page, context }) => {
    await signInAs(context, fixture.operatorId);
    await page.goto(`/app/operator/projects/${fixture.projectId}`);

    await page.getByTestId("reschedule-date").fill("2061-06-02");
    await page.getByTestId("reschedule-submit").click();

    await expect(page.getByTestId("reschedule-error")).toContainText("Tick the confirmation");
  });

  /**
   * The whole point of Decision O: a missed post moves, and the rest of the week does not follow
   * it. Nothing shifts up to cover the gap and nothing shifts down to make room.
   */
  test("moves the missed post and leaves the rest of the week alone", async ({ page, context }) => {
    await signInAs(context, fixture.operatorId);
    await page.goto(`/app/operator/projects/${fixture.projectId}`);

    // 2061-06-02 is a Thursday.
    await page.getByTestId("reschedule-date").fill("2061-06-02");
    await page.getByTestId("reschedule-confirm").locator('input[name="confirmed"]').check();
    await page.getByTestId("reschedule-submit").click();

    // A successful move stops the date being missed, so the row's form unmounts and its success
    // message goes with it. The durable confirmation is the date itself, asserted below and again
    // after a reload.
    await expect(page.getByTestId("operator-slot-missed")).toHaveCount(0);

    const moved = await prisma.scheduledPost.findUniqueOrThrow({
      where: { id: fixture.missedSlotId },
    });
    expect(moved.scheduledDate.toISOString().slice(0, 10)).toBe("2061-06-02");
    expect(moved.publishStatus).toBe(SchedulePublishStatus.NOT_STARTED);

    // The later post is exactly where it was.
    const later = await prisma.scheduledPost.findUniqueOrThrow({
      where: { id: fixture.laterSlotId },
    });
    expect(later.scheduledDate.toISOString()).toBe(fixture.laterSlotDate);
    expect(later.publishStatus).toBe(SchedulePublishStatus.NOT_STARTED);

    // The exception is resolved in place, and the form is gone because the date is not missed.
    const exception = await prisma.editorialException.findFirstOrThrow({
      where: { scheduledPostId: fixture.missedSlotId },
    });
    expect(exception.state).toBe(EditorialExceptionState.RESOLVED);

    await page.reload();
    await expect(page.getByTestId("operator-slot-missed")).toHaveCount(0);
  });
});
