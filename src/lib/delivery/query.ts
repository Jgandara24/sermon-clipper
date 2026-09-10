import type { Prisma, PrismaClient } from "@prisma/client";
import { parseDeliverySettings } from "@/lib/delivery/settings";
import { env } from "@/lib/env";
import { decideWorkspaceAccess, type WorkspaceAccessRecord, type WorkspaceAccessDecision } from "@/lib/billing/access";
import { parseFacebookConnection } from "@/lib/facebook-connection";
import { resolvePublicAppUrl } from "@/lib/integrations/facebook-publish-config";
import { isMediaUrlSigningConfigured, mediaKeyBelongsToWorkspace } from "@/lib/media/signed-url";
import { projectsHeldForTranscriptionFallback } from "@/lib/transcription/fallback-hold";
import { HUMAN_REFERENCE_PROGRAM_KEY } from "@/lib/review/program-key";
import { latestReviewForRender } from "@/lib/review/service";
import {
  assessDeliveryEligibility,
  type DeliveryEligibility,
  type DeliveryFacts,
} from "@/lib/delivery/eligibility";

type DeliveryQueryClient = PrismaClient | Prisma.TransactionClient;

type DeliveryContext = {
  facts: DeliveryFacts;
  workspaceAccess: WorkspaceAccessRecord;
  outputStorageKey: string | null;
  scheduledDate: Date;
};

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
async function loadDeliveryContext(
  client: DeliveryQueryClient,
  params: { scheduledPostId: string; dueAt?: Date },
): Promise<DeliveryContext | null> {
  const slot = await client.scheduledPost.findUnique({
    where: { id: params.scheduledPostId, ...(params.dueAt ? { AND: duePublishWhere(params.dueAt) } : {}) },
    select: {
      scheduledDate: true,
      workspaceId: true,
      projectId: true,
      clipId: true,
      exportJobId: true,
      publishStatus: true,
      workspace: { select: {
        settings: true, accessPlan: true, trialStartedAt: true, trialEndsAt: true, paidAt: true,
      } },
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
          outputFile: { select: { checksum: true, storageKey: true } },
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

  const facts: DeliveryFacts = {
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
  return {
    facts,
    workspaceAccess: slot.workspace,
    outputStorageKey: exportJob?.outputFile?.storageKey ?? null,
    scheduledDate: slot.scheduledDate,
  };
}

/** Exact-render facts only. The census composes the publisher's additional prerequisites. */
export async function loadDeliveryFacts(
  client: DeliveryQueryClient,
  params: { scheduledPostId: string },
): Promise<DeliveryFacts | null> {
  return (await loadDeliveryContext(client, params))?.facts ?? null;
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
 * Shared with `publishDueScheduledPosts` so the census checks the same due population.
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
export type PublicationReadiness = DeliveryEligibility
  | { eligible: false; reason: "workspace_access_denied"; accessReason: WorkspaceAccessDecision["reason"] }
  | { eligible: false; reason:
      | "transcription_hold"
      | "meta_system_token_missing"
      | "public_app_url_unavailable"
      | "media_signing_unavailable"
      | "export_storage_key_missing"
      | "export_storage_scope_mismatch" };

export type CensusEnvironment = {
  metaTokenConfigured: boolean;
  publicAppUrlConfigured: boolean;
  mediaSigningConfigured: boolean;
};

export type DueRowVerdict = {
  scheduledPostId: string;
  workspaceId: string;
  scheduledDate: Date;
  actual: PublicationReadiness;
  /** The same facts with `globalPublishingEnabled` forced true. Nothing else is simulated. */
  withSwitchOn: PublicationReadiness;
  /** All checked prerequisites pass with the switch simulated on. This is not a live publish test. */
  switchOnly: boolean;
};

export type SwitchOnlyCensus = {
  /** What `AUTOMATIC_PUBLISHING_ENABLED` actually reads as. The proof requires it false. */
  globalPublishingEnabled: boolean;
  takenAt: Date;
  /** Configuration of this process only. Never contains token, secret, or URL values. */
  environment: CensusEnvironment;
  rows: DueRowVerdict[];
  /** The subset whose only failing checked prerequisite is the switch. */
  switchOnly: DueRowVerdict[];
};

function assessPublicationReadiness(
  context: DeliveryContext,
  environment: CensusEnvironment,
  heldProjects: Set<string>,
  now: Date,
  globalPublishingEnabled: boolean,
): PublicationReadiness {
  if (!globalPublishingEnabled) return { eligible: false, reason: "global_publishing_disabled" };
  if (!environment.metaTokenConfigured) return { eligible: false, reason: "meta_system_token_missing" };
  if (!environment.publicAppUrlConfigured) return { eligible: false, reason: "public_app_url_unavailable" };
  if (!environment.mediaSigningConfigured) return { eligible: false, reason: "media_signing_unavailable" };
  const access = decideWorkspaceAccess(context.workspaceAccess, "publish_post", now);
  if (!access.allowed) return { eligible: false, reason: "workspace_access_denied", accessReason: access.reason };
  if (context.facts.clip && heldProjects.has(context.facts.clip.projectId)) {
    return { eligible: false, reason: "transcription_hold" };
  }
  const delivery = assessDeliveryEligibility({ ...context.facts, globalPublishingEnabled });
  if (!delivery.eligible) return delivery;
  if (!context.outputStorageKey) return { eligible: false, reason: "export_storage_key_missing" };
  if (!mediaKeyBelongsToWorkspace(context.outputStorageKey, context.facts.slot.workspaceId)) {
    return { eligible: false, reason: "export_storage_scope_mismatch" };
  }
  return { eligible: true };
}

/**
 * Every due row, judged twice: as it stands, and with the global switch simulated on.
 *
 * Only the switch is simulated. Checks use database facts and this process's configuration.
 * No Meta access, file existence, media retrieval, or media quality is tested. These reads do
 * not lock rows or authorize activation; data or worker configuration can differ later.
 *
 * Deliberately not a publish path and deliberately read-only: it changes nothing, so it can be
 * run as often as an operator likes before deciding whether to enable anything.
 */
export async function collectSwitchOnlyCensus(
  client: DeliveryQueryClient,
  params: { now: Date },
): Promise<SwitchOnlyCensus> {
  const globalPublishingEnabled = env.AUTOMATIC_PUBLISHING_ENABLED;
  const environment: CensusEnvironment = {
    metaTokenConfigured: Boolean(env.META_SYSTEM_USER_TOKEN),
    publicAppUrlConfigured: resolvePublicAppUrl() !== null,
    mediaSigningConfigured: isMediaUrlSigningConfigured(),
  };
  const due = await client.scheduledPost.findMany({
    where: duePublishWhere(params.now),
    orderBy: { scheduledDate: "asc" },
    select: { id: true },
  });
  const contexts: { scheduledPostId: string; context: DeliveryContext }[] = [];
  for (const post of due) {
    // Recheck the due predicate when loading current bindings, dates, and workspace ownership.
    const context = await loadDeliveryContext(client, { scheduledPostId: post.id, dueAt: params.now });
    if (context) contexts.push({ scheduledPostId: post.id, context });
  }
  const heldProjects = await projectsHeldForTranscriptionFallback(
    client,
    contexts.flatMap(({ context }) => context.facts.clip ? [context.facts.clip.projectId] : []),
  );
  const rows: DueRowVerdict[] = [];
  for (const { scheduledPostId, context } of contexts) {
    const actual = assessPublicationReadiness(context, environment, heldProjects, params.now, globalPublishingEnabled);
    const withSwitchOn = assessPublicationReadiness(context, environment, heldProjects, params.now, true);
    rows.push({
      scheduledPostId,
      workspaceId: context.facts.slot.workspaceId,
      scheduledDate: context.scheduledDate,
      actual,
      withSwitchOn,
      switchOnly: !actual.eligible && withSwitchOn.eligible,
    });
  }

  return {
    // The same value every assessment above saw, reported so a census can be read months later
    // without having to reconstruct what the environment was set to when it was taken.
    globalPublishingEnabled,
    takenAt: params.now,
    environment,
    rows,
    switchOnly: rows.filter((row) => row.switchOnly),
  };
}
