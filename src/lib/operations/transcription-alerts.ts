import type { Prisma, PrismaClient } from "@prisma/client";
import { assertPlatformOperator, type PlatformOperatorSubject } from "@/lib/operator-auth";
import { TRANSCRIPTION_FALLBACK_EXCEPTION_TYPE } from "@/lib/transcription/fallback-hold";

// Use the existing durable hold. Retried jobs must not create a second notification, and
// acknowledging an alert must not bypass the publishing hold.
const openFallbacks = {
  exceptionType: TRANSCRIPTION_FALLBACK_EXCEPTION_TYPE,
  state: "OPEN",
  projectId: { not: null },
} satisfies Prisma.EditorialExceptionWhereInput;

type AlertClient = Pick<PrismaClient, "editorialException">;

export async function countTranscriptionAlerts(
  client: AlertClient,
  user: PlatformOperatorSubject,
) {
  assertPlatformOperator(user);
  return client.editorialException.count({ where: openFallbacks });
}

export async function listTranscriptionAlerts(
  client: AlertClient,
  user: PlatformOperatorSubject,
) {
  assertPlatformOperator(user);
  return client.editorialException.findMany({
    where: openFallbacks,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    // Only the facts needed to find the affected service. Never serialize error metadata.
    select: {
      id: true,
      createdAt: true,
      workspace: { select: { name: true } },
      project: { select: { id: true, name: true } },
    },
  });
}
