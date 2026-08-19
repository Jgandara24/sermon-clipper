import type { Prisma, PrismaClient } from "@prisma/client";
import type { TranscriptionProviderName } from "./policy";

type ExceptionClient = Pick<PrismaClient, "editorialException"> | Prisma.TransactionClient;

export const TRANSCRIPTION_FALLBACK_EXCEPTION_TYPE = "transcription_provider_fallback";

export type TranscriptionFallbackReason = "unavailable" | "failed";

/**
 * A transcript the configured primary provider did not produce.
 *
 * The clips built on it stay visible and fully editable — nothing is hidden from the church.
 * What changes is delivery: they are held for a person to look at before they can reach an
 * audience, because the transcript underneath them is not the one the workspace's policy asked
 * for, and caption text and word timing are exactly what a lower-quality transcript degrades.
 *
 * The hold is an `EditorialException`, project-scoped and resolvable by a person, rather than a
 * new column: it is the model the plan already reserves for "a human has to look at this", and
 * it carries its own audit trail.
 */
export async function openTranscriptionFallbackHold(
  client: ExceptionClient,
  params: {
    workspaceId: string;
    projectId: string;
    jobId: string;
    primaryProvider: TranscriptionProviderName;
    usedProvider: TranscriptionProviderName;
    reason: TranscriptionFallbackReason;
  },
): Promise<void> {
  // A job retries up to three times. One cause deserves one hold, not one per attempt.
  const existing = await client.editorialException.findFirst({
    where: {
      projectId: params.projectId,
      exceptionType: TRANSCRIPTION_FALLBACK_EXCEPTION_TYPE,
      state: "OPEN",
    },
    select: { id: true },
  });
  if (existing) return;

  await client.editorialException.create({
    data: {
      workspaceId: params.workspaceId,
      projectId: params.projectId,
      exceptionType: TRANSCRIPTION_FALLBACK_EXCEPTION_TYPE,
      state: "OPEN",
      message:
        "This sermon was transcribed by the backup provider, so captions may be less accurate. Check the clips before they are published.",
      // Provider names and the reason only. An editorial exception is church-visible, and
      // provider error text is exactly the shape of thing that leaked in the 2026-08 audit.
      metadata: {
        primaryProvider: params.primaryProvider,
        usedProvider: params.usedProvider,
        reason: params.reason,
        jobId: params.jobId,
      },
    },
  });
}

/**
 * Clears the hold once the configured primary provider serves the same project again.
 *
 * The clips are rebuilt from the new transcript, so the cause is genuinely gone. Leaving the hold
 * open would be a stuck state nobody could reason about a month later, and a hold that never
 * clears is one people learn to ignore.
 */
export async function resolveTranscriptionFallbackHold(
  client: ExceptionClient,
  params: { projectId: string; primaryProvider: TranscriptionProviderName },
): Promise<void> {
  await client.editorialException.updateMany({
    where: {
      projectId: params.projectId,
      exceptionType: TRANSCRIPTION_FALLBACK_EXCEPTION_TYPE,
      state: "OPEN",
    },
    data: {
      state: "RESOLVED",
      resolvedAt: new Date(),
      resolutionReason: `Re-transcribed by the configured primary provider ${params.primaryProvider}.`,
    },
  });
}

/** The subset of the given projects currently held. Used by the publish gate. */
export async function projectsHeldForTranscriptionFallback(
  client: ExceptionClient,
  projectIds: readonly string[],
): Promise<Set<string>> {
  const unique = [...new Set(projectIds)];
  if (unique.length === 0) return new Set();

  const held = await client.editorialException.findMany({
    where: {
      projectId: { in: unique },
      exceptionType: TRANSCRIPTION_FALLBACK_EXCEPTION_TYPE,
      state: "OPEN",
    },
    select: { projectId: true },
  });

  return new Set(
    held
      .map((row) => row.projectId)
      .filter((projectId): projectId is string => typeof projectId === "string"),
  );
}
