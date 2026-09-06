/**
 * Platform-operator authority end to end: the marker, the gate that reads it, and the audited
 * command that grants it.
 *
 * P2.2 adds no route — the operator surfaces arrive in P2.5 — so there is nothing yet for the
 * route matrix in `route-authorization.integration.test.ts` to cover. The behaviour that exists
 * is the gate helper and the command, and this is where they are asserted.
 */
import { MemberStatus, PrismaClient, WorkspaceAccessPlan, WorkspaceRole } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Same hoisted-cookie shape as the route matrix: vi.mock factories run above imports, so the
// mutable session state has to be hoisted with them.
const cookieState = vi.hoisted(() => ({ sessionToken: null as string | null }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieState.sessionToken && name === "sermon_clipper_session"
        ? { name, value: cookieState.sessionToken }
        : undefined,
  }),
}));

import { requireApiPlatformOperator, requireApiWorkspace } from "@/lib/api/auth";
import { AUTH_SESSION_COOKIE, createSessionToken, hashSecret } from "@/lib/auth/email-otp";
import {
  listPlatformOperators,
  PlatformOperatorInputError,
  setPlatformOperator,
} from "@/lib/operations/platform-operator";
import {
  isPlatformOperator,
  PlatformOperatorAuthorizationError,
  PlatformOperatorWorkspaceNotFoundError,
  requirePlatformOperatorWorkspace,
} from "@/lib/operator-auth";

const prisma = new PrismaClient();
const userIdsToDelete: string[] = [];
const workspaceIdsToDelete: string[] = [];

let operatorUserId: string;
let operatorToken: string;
let churchOwnerUserId: string;
let churchOwnerToken: string;
let churchAWorkspaceId: string;
let churchBWorkspaceId: string;

/**
 * Audit rows for one user only.
 *
 * The suite shares one database, and `npm run set:platform-operator` against a dev database
 * writes these same rows. A global count over `event_type` therefore counts other people's work:
 * this file passed alone and failed in the suite for exactly that reason. Every assertion below
 * is scoped to a user this test created.
 */
async function auditRowsFor(userId: string, eventType: string) {
  return prisma.operationalEvent.findMany({
    where: { eventType, metadata: { path: ["userId"], equals: userId } },
    orderBy: { createdAt: "asc" },
  });
}

function uniqueEmail(label: string) {
  return `operator-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function createUserWithSession(label: string) {
  const user = await prisma.user.create({ data: { email: uniqueEmail(label) } });
  userIdsToDelete.push(user.id);
  const token = createSessionToken();
  await prisma.authSession.create({
    data: {
      userId: user.id,
      tokenHash: hashSecret(token),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return { user, token };
}

async function createWorkspace(
  ownerId: string,
  name: string,
  accessPlan: WorkspaceAccessPlan = WorkspaceAccessPlan.PAID,
) {
  const workspace = await prisma.workspace.create({
    data: { ownerId, name, accessPlan, paidAt: accessPlan === WorkspaceAccessPlan.PAID ? new Date() : null },
  });
  workspaceIdsToDelete.push(workspace.id);
  await prisma.workspaceMember.create({
    data: {
      workspaceId: workspace.id,
      userId: ownerId,
      role: WorkspaceRole.OWNER,
      status: MemberStatus.ACTIVE,
    },
  });
  return workspace;
}

beforeAll(async () => {
  // The cookie name is hard-coded in the mock factory above, which cannot read an import.
  expect(AUTH_SESSION_COOKIE).toBe("sermon_clipper_session");

  const operator = await createUserWithSession("staff");
  operatorUserId = operator.user.id;
  operatorToken = operator.token;

  const churchOwner = await createUserWithSession("church-owner");
  churchOwnerUserId = churchOwner.user.id;
  churchOwnerToken = churchOwner.token;

  churchAWorkspaceId = (await createWorkspace(churchOwnerUserId, "Church A")).id;

  const otherOwner = await createUserWithSession("other-owner");
  churchBWorkspaceId = (await createWorkspace(otherOwner.user.id, "Church B")).id;
});

beforeEach(() => {
  cookieState.sessionToken = null;
});

afterAll(async () => {
  cookieState.sessionToken = null;
  await prisma.operationalEvent.deleteMany({
    where: {
      eventType: { in: ["platform_operator_granted", "platform_operator_revoked"] },
      metadata: { path: ["userId"], equals: operatorUserId },
    },
  });
  await prisma.workspace.deleteMany({ where: { id: { in: workspaceIdsToDelete } } });
  await prisma.user.deleteMany({ where: { id: { in: userIdsToDelete } } });
  await prisma.$disconnect();
});

describe("the audited grant and revoke command", () => {
  it("grants, revokes, and writes exactly one platform-scoped audit row for each", async () => {
    const granted = await setPlatformOperator(prisma, {
      userId: operatorUserId,
      isPlatformOperator: true,
    });
    expect(granted).toMatchObject({ changed: true, isPlatformOperator: true });

    const afterGrant = await prisma.user.findUniqueOrThrow({ where: { id: operatorUserId } });
    expect(afterGrant.isPlatformOperator).toBe(true);
    expect(afterGrant.platformOperatorGrantedAt).not.toBeNull();

    const grantEvents = await auditRowsFor(operatorUserId, "platform_operator_granted");
    expect(grantEvents).toHaveLength(1);
    // Platform-scoped: a workspace-scoped row would surface this on a church's own operations
    // page, telling a church that someone outside it can read their work.
    expect(grantEvents[0].workspaceId).toBeNull();
    expect(grantEvents[0].severity).toBe("warning");
    expect(grantEvents[0].metadata).toMatchObject({ userId: operatorUserId });

    const revoked = await setPlatformOperator(prisma, {
      userId: operatorUserId,
      isPlatformOperator: false,
    });
    expect(revoked).toMatchObject({ changed: true, isPlatformOperator: false });

    const afterRevoke = await prisma.user.findUniqueOrThrow({ where: { id: operatorUserId } });
    expect(afterRevoke.isPlatformOperator).toBe(false);
    // Cleared, so the column never claims a grant that is no longer in force.
    expect(afterRevoke.platformOperatorGrantedAt).toBeNull();
    expect(await auditRowsFor(operatorUserId, "platform_operator_revoked")).toHaveLength(1);

    // Restore for the tests below.
    await setPlatformOperator(prisma, { userId: operatorUserId, isPlatformOperator: true });
  });

  it("writes no audit row when the marker already holds the requested value", async () => {
    const before = await auditRowsFor(operatorUserId, "platform_operator_granted");
    const repeat = await setPlatformOperator(prisma, {
      userId: operatorUserId,
      isPlatformOperator: true,
    });
    expect(repeat.changed).toBe(false);
    expect(await auditRowsFor(operatorUserId, "platform_operator_granted")).toHaveLength(
      before.length,
    );
  });

  it("resolves a user by email and refuses ambiguous or unknown input", async () => {
    const target = await prisma.user.findUniqueOrThrow({ where: { id: churchOwnerUserId } });

    await expect(
      setPlatformOperator(prisma, { isPlatformOperator: true }),
    ).rejects.toThrow(PlatformOperatorInputError);
    await expect(
      setPlatformOperator(prisma, {
        userId: churchOwnerUserId,
        email: target.email,
        isPlatformOperator: true,
      }),
    ).rejects.toThrow(PlatformOperatorInputError);
    await expect(
      setPlatformOperator(prisma, { userId: "not-a-uuid", isPlatformOperator: true }),
    ).rejects.toThrow(PlatformOperatorInputError);
    await expect(
      setPlatformOperator(prisma, { email: "nobody@example.com", isPlatformOperator: true }),
    ).rejects.toThrow(/No user with email/);

    // The church owner is never granted the marker by any of the above.
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: churchOwnerUserId } }),
    ).resolves.toMatchObject({ isPlatformOperator: false });
  });

  it("lists who currently holds the marker", async () => {
    const operators = await listPlatformOperators(prisma);
    expect(operators.map((row) => row.id)).toContain(operatorUserId);
    expect(operators.map((row) => row.id)).not.toContain(churchOwnerUserId);
  });
});

describe("cross-workspace access", () => {
  it("lets an operator read a workspace they are no member of", async () => {
    const operator = await prisma.user.findUniqueOrThrow({ where: { id: operatorUserId } });
    expect(isPlatformOperator(operator)).toBe(true);

    // No membership row exists for this user in either church.
    expect(
      await prisma.workspaceMember.count({ where: { userId: operatorUserId } }),
    ).toBe(0);

    for (const workspaceId of [churchAWorkspaceId, churchBWorkspaceId]) {
      const workspace = await requirePlatformOperatorWorkspace(prisma, operator, workspaceId);
      expect(workspace.id).toBe(workspaceId);
    }
  });

  it("refuses a church owner, even for their own workspace", async () => {
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: churchOwnerUserId } });

    // The owner holds every workspace permission in Church A and still cannot use this door.
    await expect(
      requirePlatformOperatorWorkspace(prisma, owner, churchAWorkspaceId),
    ).rejects.toThrow(PlatformOperatorAuthorizationError);
    await expect(
      requirePlatformOperatorWorkspace(prisma, owner, churchBWorkspaceId),
    ).rejects.toThrow(PlatformOperatorAuthorizationError);
  });

  it("refuses a viewer and an absent session", async () => {
    const viewer = await createUserWithSession("viewer");
    await prisma.workspaceMember.create({
      data: {
        workspaceId: churchAWorkspaceId,
        userId: viewer.user.id,
        role: WorkspaceRole.VIEWER,
        status: MemberStatus.ACTIVE,
      },
    });

    await expect(
      requirePlatformOperatorWorkspace(prisma, viewer.user, churchAWorkspaceId),
    ).rejects.toThrow(PlatformOperatorAuthorizationError);
    await expect(
      requirePlatformOperatorWorkspace(prisma, null, churchAWorkspaceId),
    ).rejects.toThrow(PlatformOperatorAuthorizationError);
  });

  it("refuses the marker check before looking a workspace up", async () => {
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: churchOwnerUserId } });
    const missingWorkspaceId = "00000000-0000-0000-0000-0000000000ff";

    // A non-operator gets the authorization error, not a "no such workspace" that would let them
    // probe which workspace ids exist.
    await expect(
      requirePlatformOperatorWorkspace(prisma, owner, missingWorkspaceId),
    ).rejects.toThrow(PlatformOperatorAuthorizationError);

    const operator = await prisma.user.findUniqueOrThrow({ where: { id: operatorUserId } });
    await expect(
      requirePlatformOperatorWorkspace(prisma, operator, missingWorkspaceId),
    ).rejects.toThrow(PlatformOperatorWorkspaceNotFoundError);
  });
});

describe("the route-handler gate", () => {
  it("returns 401 without a session and 403 for a signed-in non-operator", async () => {
    const anonymous = await requireApiPlatformOperator();
    expect(anonymous.error?.status).toBe(401);

    cookieState.sessionToken = churchOwnerToken;
    const nonOperator = await requireApiPlatformOperator();
    expect(nonOperator.error?.status).toBe(403);
    // The same refusal a non-member gets, so the route does not advertise that staff authority
    // exists at all.
    await expect(nonOperator.error?.json()).resolves.toMatchObject({
      error: { code: "PERMISSION_DENIED" },
    });
  });

  it("admits an operator who belongs to no workspace at all", async () => {
    cookieState.sessionToken = operatorToken;
    const result = await requireApiPlatformOperator();
    expect(result.error).toBeUndefined();
    expect(result.user?.id).toBe(operatorUserId);

    // The workspace gate would have refused the same session, because there is no membership.
    const asMember = await requireApiWorkspace();
    expect(asMember.error?.status).toBe(403);
  });

  it("does not read the reviewed church's billing state", async () => {
    // A lapsed church still has editorial work that staff must be able to review. This is why
    // the operator gate is a separate function rather than a flag on requireApiWorkspace, whose
    // last step is a billing check that would 402 here.
    const lapsedOwner = await createUserWithSession("lapsed-owner");
    await createWorkspace(lapsedOwner.user.id, "Lapsed Church", WorkspaceAccessPlan.TRIAL);
    await prisma.workspace.updateMany({
      where: { ownerId: lapsedOwner.user.id },
      data: { trialEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });

    cookieState.sessionToken = lapsedOwner.token;
    const asMember = await requireApiWorkspace("IMPORT_MEDIA");
    expect(asMember.error?.status).toBe(402);

    cookieState.sessionToken = operatorToken;
    const asOperator = await requireApiPlatformOperator();
    expect(asOperator.error).toBeUndefined();

    const lapsedWorkspace = await prisma.workspace.findFirstOrThrow({
      where: { ownerId: lapsedOwner.user.id },
    });
    const operator = await prisma.user.findUniqueOrThrow({ where: { id: operatorUserId } });
    await expect(
      requirePlatformOperatorWorkspace(prisma, operator, lapsedWorkspace.id),
    ).resolves.toMatchObject({ id: lapsedWorkspace.id });
  });
});
