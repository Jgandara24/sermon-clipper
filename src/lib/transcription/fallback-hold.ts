import type { Prisma, PrismaClient } from "@prisma/client";
import { INITIAL_EDIT_VERSION } from "@/lib/editor/types";
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
 * The name each provider writes into `Transcript.provider`.
 *
 * A separate map rather than importing the provider classes, which would make this module drag
 * the whole provider layer into the analyze handler. A test asserts the two agree, so renaming a
 * provider cannot silently stop auto-resolution.
 */
export function transcriptProviderNameFor(name: TranscriptionProviderName): string {
  return name === "scribe" ? "elevenlabs_scribe_v2" : "whisper_cpp";
}

export type FallbackHoldOutcome =
  | { settled: "no_hold" }
  | { settled: "resolved" }
  | {
      settled: "kept_open";
      reason: "transcript_not_from_primary" | "human_work_needs_reconciliation";
    };

type SettleClient = ExceptionClient &
  Pick<Prisma.TransactionClient, "clipEdit" | "clipApproval" | "exportJob">;

/**
 * Decides what happens to an open hold at the moment the clips are rebuilt.
 *
 * Three things must all be true before a machine closes it:
 *
 *  1. the transcript now stored came from the configured primary provider;
 *  2. the clips rebuilt successfully — which is why this runs inside the rebuild transaction,
 *     so a rebuild that throws resolves nothing;
 *  3. nobody edited, approved, or exported a clip built on the fallback transcript.
 *
 * Condition 3 is the one that needs care. The rebuild deletes the project's clips, and
 * ClipEdit, ClipApproval, and ExportJob all cascade from them — so a person's work on the
 * fallback clips is destroyed by the very transaction that would declare it reconciled. The
 * count therefore happens here, before the delete, and any such work keeps the hold open for a
 * person to reconcile by hand. Only work created at or after the hold opened counts; edits from
 * an earlier, healthy transcript are not the fallback's business.
 */
export async function settleTranscriptionFallbackHold(
  client: SettleClient,
  params: {
    projectId: string;
    /** The provider recorded on the transcript that the rebuild is reading. */
    transcriptProvider: string;
    primaryProvider: TranscriptionProviderName;
  },
): Promise<FallbackHoldOutcome> {
  const hold = await client.editorialException.findFirst({
    where: {
      projectId: params.projectId,
      exceptionType: TRANSCRIPTION_FALLBACK_EXCEPTION_TYPE,
      state: "OPEN",
    },
    select: { id: true, createdAt: true },
  });
  if (!hold) return { settled: "no_hold" };

  if (params.transcriptProvider !== transcriptProviderNameFor(params.primaryProvider)) {
    return { settled: "kept_open", reason: "transcript_not_from_primary" };
  }

  const since = { gte: hold.createdAt };
  const clipScope = { clip: { projectId: params.projectId } };
  const [edits, approvals, exports] = await Promise.all([
    client.clipEdit.count({
      where: {
        ...clipScope,
        createdAt: since,
        // ANALYZE writes each clip's first document itself, unsigned. That row is the machine's,
        // not a person's, and counting it meant a healthy re-transcription could never close the
        // hold it opened — every rebuilt clip arrived already looking like human work. A save
        // made by someone always carries their id, so the two cannot be confused.
        NOT: { savedBy: null, version: INITIAL_EDIT_VERSION },
      },
    }),
    client.clipApproval.count({ where: { ...clipScope, createdAt: since } }),
    client.exportJob.count({ where: { ...clipScope, createdAt: since } }),
  ]);

  if (edits + approvals + exports > 0) {
    await client.editorialException.update({
      where: { id: hold.id },
      data: {
        metadata: {
          manualReconciliationRequired: true,
          fallbackClipEdits: edits,
          fallbackClipApprovals: approvals,
          fallbackClipExports: exports,
        },
      },
    });
    return { settled: "kept_open", reason: "human_work_needs_reconciliation" };
  }

  await client.editorialException.update({
    where: { id: hold.id },
    data: {
      state: "RESOLVED",
      resolvedAt: new Date(),
      resolutionReason: `Re-transcribed by the configured primary provider ${params.primaryProvider} and the clips were rebuilt from it. No edits, approvals, or exports had been made from the fallback transcript.`,
    },
  });
  return { settled: "resolved" };
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
