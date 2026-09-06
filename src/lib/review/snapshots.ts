import type { Prisma, PrismaClient } from "@prisma/client";
import { ReviewSubjectError, StaleRenderError, type ReviewedRenderIdentity } from "./types";

/**
 * Loads what a slot currently holds, and refuses a decision aimed at anything else.
 *
 * This is where "the exact file" stops being a claim. A reviewer opens a slot, watches a render,
 * and decides — and in between, a rerender, a new edit, or a replacement can have moved the slot
 * on. Recording their verdict against whatever the slot holds *now* would attach a human decision
 * to a file no human watched, which is the entire failure this table exists to prevent.
 */

export type ReviewSubject = {
  workspaceId: string;
  projectId: string;
  scheduledPostId: string;
  clipId: string;
  clipRank: number;
  clipStartMs: number;
  clipEndMs: number;
  exportJobId: string;
  editVersion: number;
  checksum: string;
  /** Context for replay and the review UI. Never an eligibility input. */
  slotSnapshot: Prisma.InputJsonValue;
};

export type ReviewSubjectClient = Pick<PrismaClient, "scheduledPost"> | Prisma.TransactionClient;

/** The reviewed clip's length, which the feedback policy needs to place a finding. */
export function clipDurationMs(subject: Pick<ReviewSubject, "clipStartMs" | "clipEndMs">): number {
  return Math.max(0, subject.clipEndMs - subject.clipStartMs);
}

/**
 * What the slot holds right now, as the row a review would be written from.
 *
 * Every field is required. A slot with no bound clip, no bound export, or an export that has not
 * passed QC has no reviewable file, and there is nothing honest to record about it.
 */
export async function loadReviewSubject(
  client: ReviewSubjectClient,
  scheduledPostId: string,
): Promise<ReviewSubject> {
  const slot = await client.scheduledPost.findUnique({
    where: { id: scheduledPostId },
    include: { clip: true, exportJob: true },
  });

  if (!slot) throw new ReviewSubjectError(`No scheduled post ${scheduledPostId}.`);
  if (!slot.projectId) {
    throw new ReviewSubjectError(`Scheduled post ${scheduledPostId} is detached from its project.`);
  }
  if (!slot.clip) {
    throw new ReviewSubjectError(`Scheduled post ${scheduledPostId} has no clip bound to it.`);
  }
  if (!slot.exportJob) {
    throw new ReviewSubjectError(`Scheduled post ${scheduledPostId} has no export bound to it.`);
  }
  if (slot.exportJob.editVersion === null) {
    throw new ReviewSubjectError(
      `Export ${slot.exportJob.id} does not name the edit version it rendered, so what a ` +
        "reviewer watched cannot be identified. Historical exports are not reviewable.",
    );
  }
  if (!slot.exportJob.qcChecksum) {
    throw new ReviewSubjectError(
      `Export ${slot.exportJob.id} has no QC checksum, so the file under review cannot be ` +
        "identified. Render QC must pass before a decision can be recorded.",
    );
  }
  // The FK cannot enforce this: it says the clip and the export exist, not that they belong to
  // each other or to this workspace.
  if (slot.exportJob.clipId !== slot.clip.id) {
    throw new ReviewSubjectError(
      `Slot ${scheduledPostId} binds export ${slot.exportJob.id}, which rendered a different clip.`,
    );
  }
  if (slot.clip.projectId !== slot.projectId || slot.clip.workspaceId !== slot.workspaceId) {
    throw new ReviewSubjectError(
      `Slot ${scheduledPostId} binds a clip from another project or workspace.`,
    );
  }

  return {
    workspaceId: slot.workspaceId,
    projectId: slot.projectId,
    scheduledPostId: slot.id,
    clipId: slot.clip.id,
    clipRank: slot.clip.rank,
    clipStartMs: slot.clip.startMs,
    clipEndMs: slot.clip.endMs,
    exportJobId: slot.exportJob.id,
    editVersion: slot.exportJob.editVersion,
    checksum: slot.exportJob.qcChecksum,
    slotSnapshot: {
      scheduledDate: slot.scheduledDate.toISOString(),
      platform: slot.platform,
      publishStatus: slot.publishStatus,
      title: slot.clip.title,
      hookText: slot.clip.hookText,
      qcStatus: slot.exportJob.qcStatus,
      filename: slot.exportJob.filename,
    },
  };
}

/**
 * Refuses a decision aimed at a file the slot no longer holds.
 *
 * All four facts are compared, not just the export id. A rerender of the same edit produces a new
 * export; a new edit of the same clip produces a new version; a rebuild of the same file produces
 * a new checksum. Each one is a different file, and each one invalidates a prior look.
 */
export function assertIdentityIsCurrent(
  subject: ReviewSubject,
  identity: ReviewedRenderIdentity,
): void {
  const mismatches: string[] = [];
  if (identity.clipId !== subject.clipId) {
    mismatches.push(`clip ${identity.clipId} is now ${subject.clipId}`);
  }
  if (identity.exportJobId !== subject.exportJobId) {
    mismatches.push(`export ${identity.exportJobId} is now ${subject.exportJobId}`);
  }
  if (identity.editVersion !== subject.editVersion) {
    mismatches.push(`edit version ${identity.editVersion} is now ${subject.editVersion}`);
  }
  if (identity.checksum !== subject.checksum) {
    mismatches.push("the file's checksum changed");
  }

  if (mismatches.length > 0) {
    throw new StaleRenderError(subject.scheduledPostId, mismatches.join("; "));
  }
}
