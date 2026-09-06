import type { Prisma, PrismaClient } from "@prisma/client";
import { parseDeliverySettings } from "@/lib/delivery/settings";
import { env } from "@/lib/env";
import { parseFacebookConnection } from "@/lib/facebook-connection";
import { HUMAN_REFERENCE_PROGRAM_KEY } from "@/lib/review/program-key";
import { latestReviewForRender } from "@/lib/review/service";
import {
  assessDeliveryEligibility,
  type DeliveryEligibility,
  type DeliveryFacts,
} from "@/lib/delivery/eligibility";

type DeliveryQueryClient = PrismaClient | Prisma.TransactionClient;

/**
 * Loads the facts `assessDeliveryEligibility` needs for one scheduled slot.
 *
 * Deliberately reads only what the slot itself points at. There is no query here that finds "the
 * clip's most recent successful export" — the slot's `exportJobId` is the only way to reach an
 * export, so a slot with no binding produces null and the pure rule refuses. Adding a fallback
 * lookup here would defeat the whole module.
 *
 * The review is loaded the same way: keyed on the render the slot is bound to, never on the slot
 * or the clip. A query by slot would hand the rule a decision about a file this slot no longer
 * holds, which is the same defect one table further along.
 */
export async function loadDeliveryFacts(
  client: DeliveryQueryClient,
  params: { scheduledPostId: string },
): Promise<DeliveryFacts | null> {
  const slot = await client.scheduledPost.findUnique({
    where: { id: params.scheduledPostId },
    select: {
      workspaceId: true,
      projectId: true,
      clipId: true,
      exportJobId: true,
      publishStatus: true,
      workspace: { select: { settings: true } },
      clip: {
        select: {
          id: true,
          workspaceId: true,
          projectId: true,
          supersededAt: true,
          // The newest saved edit is the cut that exists now; the bound export must match it.
          edits: { orderBy: { version: "desc" }, take: 1, select: { version: true } },
          approvals: { orderBy: { createdAt: "desc" }, take: 1, select: { state: true } },
        },
      },
      exportJob: {
        select: {
          id: true,
          workspaceId: true,
          clipId: true,
          state: true,
          editVersion: true,
          qcStatus: true,
          qcChecksum: true,
          outputFile: { select: { checksum: true } },
        },
      },
    },
  });

  if (!slot) return null;

  // The exact render under judgement. Absent any of these four the slot is already ineligible on
  // an earlier rule, so there is nothing to look up and nothing a lookup could rescue.
  const exportJob = slot.exportJob;
  const reviewedIdentity =
    slot.clipId && exportJob && exportJob.editVersion !== null && exportJob.qcChecksum
      ? {
          clipId: slot.clipId,
          exportJobId: exportJob.id,
          editVersion: exportJob.editVersion,
          // The QC-time checksum, which the rule separately asserts is the output file's own.
          // One verified value, compared everywhere.
          checksum: exportJob.qcChecksum,
        }
      : null;
  const review = reviewedIdentity ? await latestReviewForRender(client, reviewedIdentity) : null;

  // One row for the whole installation, so this is a lookup rather than a join.
  const program = await client.editorialProgram.findUnique({
    where: { key: HUMAN_REFERENCE_PROGRAM_KEY },
    select: { state: true },
  });

  return {
    globalPublishingEnabled: env.AUTOMATIC_PUBLISHING_ENABLED,
    programState: program?.state ?? null,
    settings: parseDeliverySettings(slot.workspace.settings),
    connection: parseFacebookConnection(slot.workspace.settings),
    slot: {
      workspaceId: slot.workspaceId,
      projectId: slot.projectId,
      clipId: slot.clipId,
      exportJobId: slot.exportJobId,
      publishStatus: slot.publishStatus,
    },
    clip: slot.clip
      ? {
          id: slot.clip.id,
          workspaceId: slot.clip.workspaceId,
          projectId: slot.clip.projectId,
          supersededAt: slot.clip.supersededAt,
          // No edit rows means the clip predates the editor; version 0 is that cut.
          currentEditVersion: slot.clip.edits[0]?.version ?? 0,
        }
      : null,
    exportJob: exportJob ?? null,
    review:
      review && reviewedIdentity
        ? {
            decision: review.decision,
            reviewerKind: review.reviewerKind,
            // Read back off the row rather than echoing the query, so the rule is checking the
            // decision's own snapshot and a loosened `where` here cannot pass unnoticed.
            identity: {
              clipId: review.clipIdSnapshot,
              exportJobId: review.exportJobIdSnapshot,
              editVersion: review.editVersion,
              checksum: review.checksum,
            },
          }
        : null,
    approval: slot.clip?.approvals[0] ?? null,
  };
}

/** Loads the facts and applies the rule. Returns null when the slot does not exist. */
export async function assessScheduledPostDelivery(
  client: DeliveryQueryClient,
  params: { scheduledPostId: string },
): Promise<DeliveryEligibility | null> {
  const facts = await loadDeliveryFacts(client, params);
  return facts ? assessDeliveryEligibility(facts) : null;
}

/**
 * The rows the publisher would consider right now.
 *
 * Shared with `publishDueScheduledPosts` on purpose. P2.9's sandbox census claims that exactly one
 * row would go out if the global switch were flipped, and a census that scanned a different set
 * from the publisher would be proving something about a population that never publishes. One
 * definition, two callers.
 */
export function duePublishWhere(now: Date): Prisma.ScheduledPostWhereInput {
  return {
    platform: "FACEBOOK",
    publishStatus: "NOT_STARTED",
    scheduledDate: { lte: now },
    // Detached history rows (clip regenerated after publish) are never publishable.
    clipId: { not: null },
    OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
  };
}

/** One due row's verdict now, and its verdict if the global switch were the only thing changed. */
export type DueRowVerdict = {
  scheduledPostId: string;
  workspaceId: string;
  scheduledDate: Date;
  actual: DeliveryEligibility;
  /** The same facts with `globalPublishingEnabled` forced true. Nothing else is simulated. */
  withSwitchOn: DeliveryEligibility;
  /** True when the global switch is the single thing standing between this row and an audience. */
  switchOnly: boolean;
};

export type SwitchOnlyCensus = {
  /** What `AUTOMATIC_PUBLISHING_ENABLED` actually reads as. The proof requires it false. */
  globalPublishingEnabled: boolean;
  takenAt: Date;
  rows: DueRowVerdict[];
  /** The subset whose only failing reason is the switch — the rows a flip would release. */
  switchOnly: DueRowVerdict[];
};

/**
 * Every due row, judged twice: as it stands, and with the global switch simulated on.
 *
 * This is the "dry run" the P2 sandbox sequence calls for, and simulating the switch is the only
 * liberty it takes — every other fact is read from the database as it is. A row that becomes
 * eligible under the simulation had the switch as its single failing reason, which is precisely
 * the claim the proof has to establish about exactly one row and refute about every other.
 *
 * Deliberately not a publish path and deliberately read-only: it changes nothing, so it can be
 * run as often as an operator likes before deciding whether to enable anything.
 */
export async function collectSwitchOnlyCensus(
  client: DeliveryQueryClient,
  params: { now: Date },
): Promise<SwitchOnlyCensus> {
  const due = await client.scheduledPost.findMany({
    where: duePublishWhere(params.now),
    orderBy: { scheduledDate: "asc" },
    select: { id: true, workspaceId: true, scheduledDate: true },
  });

  const rows: DueRowVerdict[] = [];

  for (const post of due) {
    const facts = await loadDeliveryFacts(client, { scheduledPostId: post.id });
    // Vanished between the two reads. Nothing to judge, and nothing that could publish.
    if (!facts) continue;

    const actual = assessDeliveryEligibility(facts);
    const withSwitchOn = assessDeliveryEligibility({ ...facts, globalPublishingEnabled: true });
    rows.push({
      scheduledPostId: post.id,
      workspaceId: post.workspaceId,
      scheduledDate: post.scheduledDate,
      actual,
      withSwitchOn,
      switchOnly: !actual.eligible && withSwitchOn.eligible,
    });
  }

  return {
    // The same value every assessment above saw, reported so a census can be read months later
    // without having to reconstruct what the environment was set to when it was taken.
    globalPublishingEnabled: env.AUTOMATIC_PUBLISHING_ENABLED,
    takenAt: params.now,
    rows,
    switchOnly: rows.filter((row) => row.switchOnly),
  };
}
