import { expect, test } from "@playwright/test";
import {
  AuthProvider,
  Prisma,
  ProjectStatus,
  SchedulePublishStatus,
  WorkspaceRole,
} from "@prisma/client";
import { prisma } from "../../src/lib/prisma";
import { signInAs, signOutTestSessions } from "./auth-session";

/**
 * P1.10: which service a sermon is from is asked for, shown, and correctable — until clips from
 * it have gone out, at which point moving the sermon would leave those records describing a day
 * the project no longer claims.
 */

type Fixture = { userId: string; workspaceId: string; projectId: string };

function uniqueKey(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function createFixture(options: { published?: boolean } = {}): Promise<Fixture> {
  const user = await prisma.user.create({
    data: { email: `${uniqueKey("service-context")}@example.com`, authProvider: AuthProvider.EMAIL_OTP },
  });
  const workspace = await prisma.workspace.create({
    data: {
      name: "Service Context Workspace",
      ownerId: user.id,
      minuteBalance: new Prisma.Decimal("60.00"),
    },
  });
  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: user.id, role: WorkspaceRole.OWNER },
  });

  const project = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: "Service Context Project",
      status: ProjectStatus.READY,
      sermonDate: new Date("2026-07-19T00:00:00.000Z"),
      serviceSlot: "PRIMARY",
      processingConfig: { serviceOccurrence: "PRIMARY" },
    },
  });

  if (options.published) {
    await prisma.scheduledPost.create({
      data: {
        workspaceId: workspace.id,
        projectId: project.id,
        scheduledDate: new Date("2026-07-20T00:00:00.000Z"),
        publishStatus: SchedulePublishStatus.SUCCEEDED,
      },
    });
  }

  return { userId: user.id, workspaceId: workspace.id, projectId: project.id };
}

async function destroyFixture(fixture: Fixture | undefined) {
  if (fixture?.workspaceId) await prisma.workspace.delete({ where: { id: fixture.workspaceId } });
  if (fixture?.userId) await prisma.user.delete({ where: { id: fixture.userId } }).catch(() => undefined);
}

test.describe("project service context", () => {
  let fixture: Fixture | undefined;

  test.afterEach(async () => {
    await signOutTestSessions();
    await destroyFixture(fixture);
    fixture = undefined;
  });

  test("shows the recorded service and saves a correction", async ({ page, context }) => {
    fixture = await createFixture();
    await signInAs(context, fixture.userId);
    await page.goto(`/app/projects/${fixture.projectId}`);

    const date = page.getByLabel("Service date");
    await expect(date).toHaveValue("2026-07-19");
    await expect(page.getByLabel("Which service")).toHaveValue("PRIMARY");

    await date.fill("2026-07-22");
    await page.getByLabel("Which service").selectOption("SECONDARY");
    await page.getByRole("button", { name: "Save service details" }).click();
    // Wait for the action's redirect before reading anything back: without this the inputs still
    // hold the typed values and the database read races the transaction, so the test passes on
    // the UI and fails on the row — or worse, passes on both by accident.
    await page.waitForURL(/\?updated=service-context$/);

    await expect(page.getByLabel("Service date")).toHaveValue("2026-07-22");
    await expect(page.getByLabel("Which service")).toHaveValue("SECONDARY");

    const saved = await prisma.project.findUniqueOrThrow({ where: { id: fixture.projectId } });
    expect(saved.sermonDate?.toISOString().slice(0, 10)).toBe("2026-07-22");
    expect(saved.serviceSlot).toBe("SECONDARY");
  });

  test("offers no control once a clip from the sermon has posted", async ({ page, context }) => {
    fixture = await createFixture({ published: true });
    await signInAs(context, fixture.userId);
    await page.goto(`/app/projects/${fixture.projectId}`);

    await expect(page.getByLabel("Service date")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save service details" })).toHaveCount(0);
    await expect(page.getByText("This can no longer be changed")).toBeVisible();
  });
});
