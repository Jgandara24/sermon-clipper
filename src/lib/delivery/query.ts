import type { Prisma, PrismaClient } from "@prisma/client";
import { parseDeliverySettings } from "@/lib/delivery/settings";
import { env } from "@/lib/env";
import { parseFacebookConnection } from "@/lib/facebook-connection";
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

  return {
    globalPublishingEnabled: env.AUTOMATIC_PUBLISHING_ENABLED,
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
    exportJob: slot.exportJob ?? null,
    // Wave 2 supplies ClipReview. Until then there is nowhere to record an editorial decision,
    // so this stays null and every slot is ineligible — the intended P1 state.
    review: null,
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
