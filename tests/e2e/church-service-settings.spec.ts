import { expect, test } from "@playwright/test";
import { MemberStatus, WorkspaceRole } from "@prisma/client";
import { prisma } from "../../src/lib/prisma";
import { signInAs, signOutTestSessions } from "./auth-session";

/**
 * What a church is offered about its own week, and what it is not told.
 *
 * Two claims worth a browser: that three services appears and cannot be picked, and that nothing
 * on this page mentions the candidate limit — a staff control a church can neither see nor change.
 */

const createdWorkspaceIds: string[] = [];
const createdUserIds: string[] = [];
let serial = 0;

let ownerId: string;

function uniqueKey(label: string) {
  serial += 1;
  return `${label}-${serial}-${Date.now()}`;
}

test.beforeAll(async () => {
  const owner = await prisma.user.create({
    data: { email: `${uniqueKey("settings-owner")}@example.com` },
  });
  createdUserIds.push(owner.id);
  ownerId = owner.id;

  const workspace = await prisma.workspace.create({
    data: {
      ownerId: owner.id,
      name: "Settings Church",
      settings: {
        churchProfile: {
          timezone: "America/Chicago",
          serviceDay: "Sunday",
          sermonsPerWeek: 1,
          secondServiceDay: "Wednesday",
          postsPerDay: 1,
        },
        // A hidden staff override exists on this workspace. The church must still see no sign of
        // it — that is the point of seeding one.
        internalOperations: { candidateLimitOverride: 9 },
      },
    },
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
});

test.afterAll(async () => {
  await signOutTestSessions();
  await prisma.workspace.deleteMany({ where: { id: { in: createdWorkspaceIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

test.describe("Church service settings", () => {
  test("offers three services, disabled, alongside the two that work", async ({
    page,
    context,
  }) => {
    await signInAs(context, ownerId);
    await page.goto("/app/settings");

    const select = page.locator("#sermonsPerWeek");
    await expect(select).toBeVisible();
    await expect(select.locator("option")).toHaveCount(3);

    const third = select.locator('option[value="3"]');
    await expect(third).toHaveText(/Coming later/);
    await expect(third).toBeDisabled();
    // The two real ones are selectable.
    await expect(select.locator('option[value="1"]')).toBeEnabled();
    await expect(select.locator('option[value="2"]')).toBeEnabled();
  });

  test("still saves one and two", async ({ page, context }) => {
    await signInAs(context, ownerId);
    await page.goto("/app/settings");

    await page.locator("#sermonsPerWeek").selectOption("2");
    await page.getByRole("button", { name: /save/i }).first().click();
    await page.waitForLoadState("networkidle");

    const workspace = await prisma.workspace.findFirstOrThrow({
      where: { id: { in: createdWorkspaceIds } },
    });
    expect((workspace.settings as { churchProfile: { sermonsPerWeek: number } }).churchProfile
      .sermonsPerWeek).toBe(2);

    await page.goto("/app/settings");
    await page.locator("#sermonsPerWeek").selectOption("1");
    await page.getByRole("button", { name: /save/i }).first().click();
    await page.waitForLoadState("networkidle");

    const back = await prisma.workspace.findFirstOrThrow({
      where: { id: { in: createdWorkspaceIds } },
    });
    expect((back.settings as { churchProfile: { sermonsPerWeek: number } }).churchProfile
      .sermonsPerWeek).toBe(1);
  });

  /**
   * The candidate limit is a staff control (plan §2.2, product-owner Decision 1). This workspace
   * has an override set, so the page has something real to leak — and must not.
   */
  test("says nothing about the candidate limit, though this church has one set", async ({
    page,
    context,
  }) => {
    await signInAs(context, ownerId);
    await page.goto("/app/settings");

    const html = await page.content();
    for (const forbidden of [
      "candidateLimit",
      "hiddenOverride",
      "masterDefault",
      "hardMaximum",
      "internalOperations",
      "up to 18",
    ]) {
      expect(html).not.toContain(forbidden);
    }
    // And not the override's value, which would be the leak that mattered.
    const visible = await page.locator("body").innerText();
    expect(visible).not.toContain("candidate");
  });

  test("tells a church a change applies only to sermons uploaded afterwards", async ({
    page,
    context,
  }) => {
    await signInAs(context, ownerId);
    await page.goto("/app/settings");

    await expect(
      page.getByText(/apply to sermons you upload from now on/i),
    ).toBeVisible();
  });
});
