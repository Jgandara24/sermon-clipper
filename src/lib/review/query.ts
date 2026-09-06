import {
  ProcessingJobState,
  RenderQcStatus,
  SchedulePublishStatus,
  type ClipReviewDecision,
  type PrismaClient,
  type ReviewFeedbackActionability,
  type ReviewFeedbackCategory,
  type ReviewFeedbackSeverity,
  type SocialPlatform,
} from "@prisma/client";
import { createSignedMediaUrl } from "@/lib/media/signed-url";

/**
 * What an operator is shown, and — just as deliberately — what they are not.
 *
 * These are Data Transfer Objects, not rows. Nothing here spreads a Prisma model, because a
 * spread is how a field nobody decided to show ends up on a page. Every field below was chosen.
 *
 * **The selector's scores never appear.** Not the total, not the subscores, not the model's
 * rationale (Addendum S14). A reviewer who has seen the machine's confidence is no longer an
 * independent judgement of the machine's work, and an independent judgement is the entire product
 * of the human-reference phase. `ClipScore` is never selected here; `assertNoSelectorSignal`
 * below makes that structural rather than remembered.
 *
 * Title and hook *are* shown, labelled as machine-generated fields under review, because the
 * reviewer is judging them too (`docs/PULPIT_ENGINE_EDITORIAL_STANDARD.md` §7).
 */

export type OperatorReviewQueueRow = {
  scheduledPostId: string;
  workspaceId: string;
  churchName: string;
  projectName: string;
  scheduledDate: string;
  platform: SocialPlatform;
  publishStatus: SchedulePublishStatus;
  clipTitle: string;
  clipDurationMs: number;
  /** Null until a render finishes. A slot with no playable file cannot be decided about. */
  renderState: ProcessingJobState | null;
  qcStatus: RenderQcStatus | null;
  latestDecision: ClipReviewDecision | null;
  latestDecisionAt: string | null;
  /** True when the newest decision was made about the file the slot holds right now. */
  latestDecisionIsCurrent: boolean;
};

export type OperatorReviewFeedbackRow = {
  id: string;
  category: ReviewFeedbackCategory;
  severity: ReviewFeedbackSeverity;
  actionability: ReviewFeedbackActionability;
  note: string;
  startMs: number | null;
  endMs: number | null;
  createdAt: string;
};

export type OperatorReviewDecisionRow = {
  id: string;
  decision: ClipReviewDecision;
  note: string | null;
  createdAt: string;
  reviewerEmail: string | null;
  /** Whether this decision was about the file the slot holds now, or an earlier one. */
  aboutCurrentRender: boolean;
  feedback: OperatorReviewFeedbackRow[];
};

export type OperatorReviewDetail = {
  scheduledPostId: string;
  workspaceId: string;
  churchName: string;
  projectName: string;
  scheduledDate: string;
  platform: SocialPlatform;
  publishStatus: SchedulePublishStatus;
  /** Machine-generated, and under review. Labelled as such wherever it is shown. */
  clipTitle: string;
  clipHook: string | null;
  clipStartMs: number;
  clipEndMs: number;
  /** The four facts a decision is recorded against, and that P2.8 matches at publish time. */
  identity: {
    clipId: string;
    exportJobId: string;
    editVersion: number;
    checksum: string;
  } | null;
  renderState: ProcessingJobState | null;
  qcStatus: RenderQcStatus | null;
  qcCheckedAt: string | null;
  qcDetails: unknown;
  /** The exact file the slot will publish, signed for the church that owns it. Null if unready. */
  playbackUrl: string | null;
  /** Why there is nothing to play, when there is nothing to play. */
  unplayableReason: string | null;
  history: OperatorReviewDecisionRow[];
};

/**
 * A runtime guard that no selector signal reached a DTO.
 *
 * The rule is easy to state and easy to break by adding one convenient field, so it is checked
 * rather than remembered. Cheap, and it runs on the operator's own page render.
 */
// Specific enough not to fire on an innocent field. `total` was dropped on purpose: QC writes a
// free-form details document that could reasonably count things, and a false positive here would
// break the operator's page over nothing. A spread `ClipScore` still cannot get past this — its
// `subscores`, `modelVersion` and `excerpt` are all named below.
const FORBIDDEN_KEYS = ["score", "subscores", "rationale", "excerpt", "modelVersion"];

export function assertNoSelectorSignal(value: unknown, path = "detail"): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSelectorSignal(item, `${path}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      throw new Error(
        `Selector signal "${key}" reached the operator review model at ${path}. Reviewers must ` +
          "not see the machine's confidence in the work they are judging (Addendum S14).",
      );
    }
    assertNoSelectorSignal(nested, `${path}.${key}`);
  }
}

/** Slot states worth an operator's attention. Published and missed slots are finished business. */
const QUEUE_STATES: readonly SchedulePublishStatus[] = [
  SchedulePublishStatus.NOT_STARTED,
  SchedulePublishStatus.BLOCKED,
  SchedulePublishStatus.FAILED,
];

/**
 * Every church's queue in one list, oldest date first.
 *
 * Cross-workspace by design and by nothing else: the caller must already have proved the platform
 * operator marker (`requirePlatformOperator`). There is no workspace filter here because there is
 * no workspace to filter by — that is the whole point of the marker.
 */
export async function listOperatorReviewQueue(
  client: PrismaClient,
  options?: { limit?: number },
): Promise<OperatorReviewQueueRow[]> {
  const slots = await client.scheduledPost.findMany({
    where: { publishStatus: { in: [...QUEUE_STATES] }, clipId: { not: null } },
    include: {
      workspace: { select: { name: true } },
      project: { select: { name: true } },
      // `clip: true` would be enough today, but naming the fields keeps a later column off this
      // page by default rather than by luck.
      clip: { select: { id: true, title: true, startMs: true, endMs: true } },
      exportJob: { select: { id: true, state: true, qcStatus: true, editVersion: true, qcChecksum: true } },
    },
    orderBy: [{ scheduledDate: "asc" }, { createdAt: "asc" }],
    take: options?.limit ?? 100,
  });

  const rows: OperatorReviewQueueRow[] = [];
  for (const slot of slots) {
    if (!slot.clip) continue;
    const latest = await client.clipReview.findFirst({
      where: { scheduledPostIdSnapshot: slot.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        decision: true,
        createdAt: true,
        clipIdSnapshot: true,
        exportJobIdSnapshot: true,
        editVersion: true,
        checksum: true,
      },
    });

    rows.push({
      scheduledPostId: slot.id,
      workspaceId: slot.workspaceId,
      churchName: slot.workspace.name,
      projectName: slot.project?.name ?? "Deleted project",
      scheduledDate: slot.scheduledDate.toISOString(),
      platform: slot.platform,
      publishStatus: slot.publishStatus,
      clipTitle: slot.clip.title,
      clipDurationMs: Math.max(0, slot.clip.endMs - slot.clip.startMs),
      renderState: slot.exportJob?.state ?? null,
      qcStatus: slot.exportJob?.qcStatus ?? null,
      latestDecision: latest?.decision ?? null,
      latestDecisionAt: latest?.createdAt.toISOString() ?? null,
      latestDecisionIsCurrent: Boolean(
        latest &&
          slot.exportJob &&
          latest.clipIdSnapshot === slot.clip.id &&
          latest.exportJobIdSnapshot === slot.exportJob.id &&
          latest.editVersion === slot.exportJob.editVersion &&
          latest.checksum === slot.exportJob.qcChecksum,
      ),
    });
  }

  assertNoSelectorSignal(rows, "queue");
  return rows;
}

export async function loadOperatorReviewDetail(
  client: PrismaClient,
  scheduledPostId: string,
): Promise<OperatorReviewDetail | null> {
  const slot = await client.scheduledPost.findUnique({
    where: { id: scheduledPostId },
    include: {
      workspace: { select: { id: true, name: true } },
      project: { select: { name: true } },
      clip: { select: { id: true, title: true, hookText: true, startMs: true, endMs: true } },
      exportJob: {
        select: {
          id: true,
          state: true,
          editVersion: true,
          qcStatus: true,
          qcCheckedAt: true,
          qcChecksum: true,
          qcDetails: true,
          filename: true,
          outputFile: { select: { storageKey: true, downloadExpiresAt: true } },
        },
      },
    },
  });

  if (!slot || !slot.clip) return null;

  const exportJob = slot.exportJob;
  const identity =
    exportJob && exportJob.editVersion !== null && exportJob.qcChecksum
      ? {
          clipId: slot.clip.id,
          exportJobId: exportJob.id,
          editVersion: exportJob.editVersion,
          checksum: exportJob.qcChecksum,
        }
      : null;

  let playbackUrl: string | null = null;
  let unplayableReason: string | null = null;
  if (!exportJob) {
    unplayableReason = "No render is bound to this slot yet.";
  } else if (!exportJob.outputFile) {
    unplayableReason =
      exportJob.state === ProcessingJobState.FAILED
        ? "The render failed, so there is no file to review."
        : "The render has not finished yet.";
  } else if (!identity) {
    unplayableReason =
      "This render does not name its edit version or its QC checksum, so the file under review " +
      "cannot be identified. It is not reviewable.";
  } else {
    // Signed for **the church that owns the file**, not for the operator. The media route checks
    // the key against the workspace id inside the signature, so the operator's own id would
    // produce a link that 403s — and `createSignedMediaUrl` now refuses to mint one at all.
    playbackUrl = createSignedMediaUrl({
      key: exportJob.outputFile.storageKey,
      workspaceId: slot.workspace.id,
      contentType: "video/mp4",
      filename: exportJob.filename,
      disposition: "inline",
    });
  }

  const reviews = await client.clipReview.findMany({
    where: { scheduledPostIdSnapshot: slot.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: {
      reviewer: { select: { email: true } },
      feedback: { orderBy: { createdAt: "asc" } },
    },
  });

  const detail: OperatorReviewDetail = {
    scheduledPostId: slot.id,
    workspaceId: slot.workspace.id,
    churchName: slot.workspace.name,
    projectName: slot.project?.name ?? "Deleted project",
    scheduledDate: slot.scheduledDate.toISOString(),
    platform: slot.platform,
    publishStatus: slot.publishStatus,
    clipTitle: slot.clip.title,
    clipHook: slot.clip.hookText,
    clipStartMs: slot.clip.startMs,
    clipEndMs: slot.clip.endMs,
    identity,
    renderState: exportJob?.state ?? null,
    qcStatus: exportJob?.qcStatus ?? null,
    qcCheckedAt: exportJob?.qcCheckedAt?.toISOString() ?? null,
    qcDetails: exportJob?.qcDetails ?? null,
    playbackUrl,
    unplayableReason,
    history: reviews.map((review) => ({
      id: review.id,
      decision: review.decision,
      note: review.note,
      createdAt: review.createdAt.toISOString(),
      reviewerEmail: review.reviewer?.email ?? null,
      aboutCurrentRender: Boolean(
        identity &&
          review.clipIdSnapshot === identity.clipId &&
          review.exportJobIdSnapshot === identity.exportJobId &&
          review.editVersion === identity.editVersion &&
          review.checksum === identity.checksum,
      ),
      feedback: review.feedback.map((item) => ({
        id: item.id,
        category: item.category,
        severity: item.severity,
        actionability: item.actionability,
        note: item.note,
        startMs: item.startMs,
        endMs: item.endMs,
        createdAt: item.createdAt.toISOString(),
      })),
    })),
  };

  // `qcDetails` is free-form JSON written by the QC step, so it is the one field that could carry
  // something nobody chose. Checked with the rest.
  assertNoSelectorSignal(detail);
  return detail;
}
