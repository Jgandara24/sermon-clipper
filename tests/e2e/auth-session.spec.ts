import { expect, test } from "@playwright/test";
import { AuthProvider, Prisma, WorkspaceRole } from "@prisma/client";
import { prisma } from "../../src/lib/prisma";
import { signInAs, signOutTestSessions } from "./auth-session";

/**
 * The suite's own sign-in, put under test.
 *
 * Every other spec reaches an authenticated page through the same helper, so if the helper only
 * works against one kind of server the whole suite quietly inherits that limit. These three cases
 * are the ones a production server actually enforces: a live session opens the application, and an
 * expired or revoked one does not.
 */

type Fixture = { userId: string; workspaceId: string };

function uniqueKey(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function createFixture(): Promise<Fixture> {
  const user = await prisma.user.create({
    data: { email: `${uniqueKey("session")}@example.com`, authProvider: AuthProvider.EMAIL_OTP },
  });
  const workspace = await prisma.workspace.create({
    data: {
      name: "Session Workspace",
      ownerId: user.id,
      minuteBalance: new Prisma.Decimal("60.00"),
    },
  });
  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: user.id, role: WorkspaceRole.OWNER },
  });

  return { userId: user.id, workspaceId: workspace.id };
}

async function destroyFixture(fixture: Fixture | undefined) {
  if (fixture?.workspaceId) await prisma.workspace.delete({ where: { id: fixture.workspaceId } });
  if (fixture?.userId) await prisma.user.delete({ where: { id: fixture.userId } });
}

const dashboardHeading = "Sermon projects";
const loginHeading = "Sermon Clipper";

test.describe("End-to-end sign-in", () => {
  let fixture: Fixture;

  test.beforeEach(async () => {
    fixture = await createFixture();
  });

  test.afterEach(async () => {
    await signOutTestSessions();
    await destroyFixture(fixture);
  });

  test("a signed-in browser context opens the dashboard", async ({ context, page }) => {
    await signInAs(context, fixture.userId);

    await page.goto("/app");

    await expect(page.getByRole("heading", { name: dashboardHeading, exact: true })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/app");
  });

  test("an expired session does not open the dashboard", async ({ context, page }) => {
    await signInAs(context, fixture.userId, { expiresAt: new Date(Date.now() - 60_000) });

    await page.goto("/app");

    await expect(page.getByRole("heading", { name: loginHeading, exact: true })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/login");
  });

  test("a revoked session does not open the dashboard", async ({ context, page }) => {
    await signInAs(context, fixture.userId, { revokedAt: new Date() });

    await page.goto("/app");

    await expect(page.getByRole("heading", { name: loginHeading, exact: true })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/login");
  });
});
