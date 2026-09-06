import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { recordOperationalEvent } from "@/lib/observability/operational-events";

/**
 * Grant and revoke the platform-operator marker.
 *
 * Beside `candidate-limit-override.ts` because it is the same kind of thing: an audited command
 * with no UI, run by a human at a terminal. There is deliberately no route, server action, or
 * settings toggle — the authority this grants crosses every tenant boundary in the deployment,
 * and the only way to get it should be a deliberate act at a shell with the database URL in hand.
 *
 * `src/lib/operator-auth.ts` is the read side. Keeping the two apart means a route that imports
 * the check cannot accidentally reach the grant.
 */

export class PlatformOperatorInputError extends Error {}

export type PlatformOperatorChange = {
  userId: string;
  email: string;
  isPlatformOperator: boolean;
  /** False when the marker already held the requested value and nothing was written. */
  changed: boolean;
};

export async function setPlatformOperator(
  client: PrismaClient,
  input: { userId?: string; email?: string; isPlatformOperator: boolean },
): Promise<PlatformOperatorChange> {
  if ((input.userId === undefined) === (input.email === undefined)) {
    throw new PlatformOperatorInputError("Give exactly one of a user id or an email address.");
  }
  if (input.userId !== undefined && !z.string().uuid().safeParse(input.userId).success) {
    throw new PlatformOperatorInputError("A user UUID is required.");
  }

  const user = input.userId
    ? await client.user.findUnique({ where: { id: input.userId } })
    : await client.user.findUnique({ where: { email: input.email as string } });

  if (!user) {
    throw new PlatformOperatorInputError(
      input.userId ? `No user with id ${input.userId}.` : `No user with email ${input.email}.`,
    );
  }

  // Re-running the command is not an error, but it must not fabricate an audit row saying
  // authority changed hands when it did not.
  if (user.isPlatformOperator === input.isPlatformOperator) {
    return {
      userId: user.id,
      email: user.email,
      isPlatformOperator: user.isPlatformOperator,
      changed: false,
    };
  }

  const updated = await client.user.update({
    where: { id: user.id },
    data: {
      isPlatformOperator: input.isPlatformOperator,
      // Cleared on revoke, so the column never claims a grant that is no longer in force.
      platformOperatorGrantedAt: input.isPlatformOperator ? new Date() : null,
    },
  });

  // Platform-scoped on purpose, like the candidate-limit override: this authority belongs to no
  // church, and a workspace-scoped event would surface it on the church-facing operations page.
  await recordOperationalEvent(client, {
    category: "auth",
    eventType: input.isPlatformOperator ? "platform_operator_granted" : "platform_operator_revoked",
    severity: "warning",
    message: input.isPlatformOperator
      ? "Cross-workspace platform-operator authority was granted."
      : "Cross-workspace platform-operator authority was revoked.",
    metadata: { userId: updated.id, email: updated.email },
  });

  return {
    userId: updated.id,
    email: updated.email,
    isPlatformOperator: updated.isPlatformOperator,
    changed: true,
  };
}

/** Everyone who currently holds the marker. The closest thing to a staff list that exists. */
export async function listPlatformOperators(client: PrismaClient) {
  return client.user.findMany({
    where: { isPlatformOperator: true },
    select: { id: true, email: true, name: true, platformOperatorGrantedAt: true },
    orderBy: { email: "asc" },
  });
}
