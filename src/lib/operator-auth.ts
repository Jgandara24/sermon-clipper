import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Platform staff, kept deliberately outside the workspace permission model.
 *
 * Every permission in `authorization.ts` is workspace-scoped: `MANAGE_OPERATIONS` shows one
 * church's data, not the deployment's. Reviewing renders across every pilot church needs
 * authority no workspace role can express, and the two ways to fake it are both wrong — a
 * "super workspace" nobody's clips live in, or making Jake an owner of each church, which hands
 * him billing, membership and destructive tenant powers he must not have to do editorial review.
 *
 * So the marker sits beside the workspace model rather than inside it, and grants exactly one
 * thing: read and review another workspace's editorial work. It is never an input to
 * `hasWorkspacePermission`, and no `WorkspaceRole` can produce it. See DECISIONS.md, "Platform
 * Staff Is Not A Workspace Role".
 */

/** The fields a caller must have loaded to answer the question. Any user row satisfies it. */
export type PlatformOperatorSubject = {
  id: string;
  isPlatformOperator: boolean;
};

export class PlatformOperatorAuthorizationError extends Error {
  constructor(readonly userId: string | null) {
    super(
      userId
        ? `User ${userId} is not a platform operator.`
        : "A platform operator session is required.",
    );
    this.name = "PlatformOperatorAuthorizationError";
  }
}

/** A workspace the operator may not read, because it does not exist. */
export class PlatformOperatorWorkspaceNotFoundError extends Error {
  constructor(readonly workspaceId: string) {
    super(`Workspace ${workspaceId} does not exist.`);
    this.name = "PlatformOperatorWorkspaceNotFoundError";
  }
}

export function isPlatformOperator(user: PlatformOperatorSubject | null | undefined): boolean {
  return user?.isPlatformOperator === true;
}

export function assertPlatformOperator(
  user: PlatformOperatorSubject | null | undefined,
): asserts user is PlatformOperatorSubject {
  if (!isPlatformOperator(user)) {
    throw new PlatformOperatorAuthorizationError(user?.id ?? null);
  }
}

/**
 * The workspace an operator is acting on, loaded without a membership check.
 *
 * This is the whole point of the marker and the only place membership is skipped. It is a read:
 * it returns the workspace so a caller can scope signed media URLs and queries to the *target*
 * church (P2.5 mints URLs with this workspace's id, not the operator's own). It confers no
 * ability to write to that workspace, and deliberately does not consult the workspace's billing
 * state — a church whose trial lapsed still has editorial work that staff must be able to review.
 */
export async function requirePlatformOperatorWorkspace(
  client: PrismaClient | Prisma.TransactionClient,
  user: PlatformOperatorSubject | null | undefined,
  workspaceId: string,
) {
  assertPlatformOperator(user);

  const workspace = await client.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) {
    throw new PlatformOperatorWorkspaceNotFoundError(workspaceId);
  }

  return workspace;
}
