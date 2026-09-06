import {
  ClipReviewDecision,
  ReviewFeedbackSeverity,
  ReviewerKind,
  type ClipReview,
  type ClipReviewFeedback,
  type PrismaClient,
} from "@prisma/client";
import { replaceOnlyCategories, resolveActionability } from "./feedback-policy";
import { assertIdentityIsCurrent, clipDurationMs, loadReviewSubject } from "./snapshots";
import {
  BareReplaceForbiddenError,
  NotRevisableError,
  ReviewSubjectError,
  type AppendClipReviewInput,
  type ReviewFeedbackInput,
} from "./types";

/**
 * Writing human editorial decisions down.
 *
 * Every write here is an append. The database refuses updates to both tables outright (see the
 * Wave 2 migration), so this module has no update path to offer: a reviewer who changes their
 * mind appends a newer decision, and the current verdict is the latest applicable row. That is
 * what "correction by supersession" means, and it is why nothing below takes a review id to
 * modify.
 *
 * `ACCEPT` and `REVISE` go through `appendClipReview`. `REPLACE` deliberately cannot: it is not a
 * record of a judgement but five writes that must land together, and only P2.7's atomic command
 * may create one.
 */

export type ReviewServiceClient = PrismaClient;

export type AppendedReview = ClipReview & { feedback: ClipReviewFeedback[] };

function feedbackRow(
  finding: ReviewFeedbackInput,
  context: { workspaceId: string; durationMs: number; fallbackAuthorId: string | null },
) {
  return {
    workspaceId: context.workspaceId,
    category: finding.category,
    severity: finding.severity ?? ReviewFeedbackSeverity.MAJOR,
    actionability: resolveActionability(finding, context.durationMs),
    note: finding.note,
    startMs: finding.startMs ?? null,
    endMs: finding.endMs ?? null,
    authorKind: finding.authorKind ?? ReviewerKind.HUMAN,
    authorUserId: finding.authorUserId ?? context.fallbackAuthorId,
  };
}

function assertPositionsAreCoherent(feedback: ReviewFeedbackInput[], durationMs: number): void {
  for (const finding of feedback) {
    const hasStart = finding.startMs != null;
    const hasEnd = finding.endMs != null;
    if (hasStart !== hasEnd) {
      throw new ReviewSubjectError(
        `A located finding needs both a start and an end (${finding.category}).`,
      );
    }
    if (!hasStart) continue;
    const start = finding.startMs as number;
    const end = finding.endMs as number;
    if (start < 0 || end < start || start > durationMs) {
      throw new ReviewSubjectError(
        `A finding's span ${start}-${end}ms is not inside the clip (0-${durationMs}ms).`,
      );
    }
  }
}

/**
 * Records one `ACCEPT` or `REVISE` against the exact file the slot holds, with any number of
 * initial findings, in one transaction.
 *
 * The identity the caller passes is what the reviewer had in front of them. It is compared with
 * what the slot holds now and refused if they differ, so a verdict can never land on a file
 * nobody watched.
 */
export async function appendClipReview(
  client: ReviewServiceClient,
  input: AppendClipReviewInput,
): Promise<AppendedReview> {
  // Guards the runtime call as well as the type, because a decision arriving from a form or a
  // script is a string until something checks it.
  if ((input.decision as ClipReviewDecision) === ClipReviewDecision.REPLACE) {
    throw new BareReplaceForbiddenError();
  }

  const subject = await loadReviewSubject(client, input.scheduledPostId);
  assertIdentityIsCurrent(subject, input.identity);

  const feedback = input.feedback ?? [];
  const durationMs = clipDurationMs(subject);
  assertPositionsAreCoherent(feedback, durationMs);

  // A REVISE promises this clip can be fixed by re-editing it. A replace-only finding says it
  // cannot, and recording both would leave a slot whose review asks for something impossible.
  if (input.decision === ClipReviewDecision.REVISE) {
    const blocking = replaceOnlyCategories(feedback, durationMs);
    if (blocking.length > 0) throw new NotRevisableError(blocking);
  }

  const reviewerUserId = input.reviewerUserId ?? null;

  return client.clipReview.create({
    data: {
      workspaceId: subject.workspaceId,
      projectId: subject.projectId,
      scheduledPostId: subject.scheduledPostId,
      clipId: subject.clipId,
      exportJobId: subject.exportJobId,
      reviewerUserId,
      reviewerKind: input.reviewerKind ?? ReviewerKind.HUMAN,
      decision: input.decision,
      projectIdSnapshot: subject.projectId,
      scheduledPostIdSnapshot: subject.scheduledPostId,
      clipIdSnapshot: subject.clipId,
      clipRank: subject.clipRank,
      clipStartMs: subject.clipStartMs,
      clipEndMs: subject.clipEndMs,
      exportJobIdSnapshot: subject.exportJobId,
      editVersion: subject.editVersion,
      checksum: subject.checksum,
      slotSnapshot: subject.slotSnapshot,
      note: input.note ?? null,
      feedback: {
        create: feedback.map((finding) =>
          feedbackRow(finding, {
            workspaceId: subject.workspaceId,
            durationMs,
            fallbackAuthorId: reviewerUserId,
          }),
        ),
      },
    },
    include: { feedback: true },
  });
}

/**
 * Adds findings to a review that already exists, however long afterwards.
 *
 * Deliberately independent of the decision. A reviewer watching a service back a week later can
 * still say what they noticed, and the product owner's rule is that there is no practical limit
 * on how many findings a review carries or when they arrive. The decision itself does not move:
 * changing it means appending a new review.
 *
 * The clip's span comes from the review's own snapshot, so a finding added after the clip is
 * deleted is still placed against the clip that was actually reviewed.
 */
export async function appendReviewFeedback(
  client: ReviewServiceClient,
  input: {
    clipReviewId: string;
    feedback: ReviewFeedbackInput[];
    authorUserId?: string | null;
  },
): Promise<ClipReviewFeedback[]> {
  if (input.feedback.length === 0) return [];

  const review = await client.clipReview.findUnique({ where: { id: input.clipReviewId } });
  if (!review) throw new ReviewSubjectError(`No clip review ${input.clipReviewId}.`);

  const durationMs = Math.max(0, review.clipEndMs - review.clipStartMs);
  assertPositionsAreCoherent(input.feedback, durationMs);

  const authorUserId = input.authorUserId ?? review.reviewerUserId;
  await client.clipReviewFeedback.createMany({
    data: input.feedback.map((finding) => ({
      clipReviewId: review.id,
      ...feedbackRow(finding, {
        workspaceId: review.workspaceId,
        durationMs,
        fallbackAuthorId: authorUserId,
      }),
    })),
  });

  return client.clipReviewFeedback.findMany({
    where: { clipReviewId: review.id },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * The decision that currently stands for a slot: the newest row, whatever it says.
 *
 * Ordered by `createdAt` then `id`, because two rows appended inside one transaction can share a
 * timestamp and "the latest" has to be a total order, not a coin toss.
 */
export async function latestReviewForSlot(
  client: Pick<PrismaClient, "clipReview">,
  scheduledPostId: string,
): Promise<AppendedReview | null> {
  return client.clipReview.findFirst({
    where: { scheduledPostIdSnapshot: scheduledPostId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: { feedback: { orderBy: { createdAt: "asc" } } },
  });
}

/**
 * The standing decision about one exact rendered file.
 *
 * P2.8 asks this question at publish time and requires an `ACCEPT`. It matches on all four
 * identity facts rather than the export id alone: an export id survives a rerender that produces
 * different bytes, and an acceptance must not.
 */
export async function latestReviewForRender(
  client: Pick<PrismaClient, "clipReview">,
  identity: { clipId: string; exportJobId: string; editVersion: number; checksum: string },
): Promise<ClipReview | null> {
  return client.clipReview.findFirst({
    where: {
      clipIdSnapshot: identity.clipId,
      exportJobIdSnapshot: identity.exportJobId,
      editVersion: identity.editVersion,
      checksum: identity.checksum,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

/** Every decision about a slot, oldest first — the audit trail a correction is appended to. */
export async function reviewHistoryForSlot(
  client: Pick<PrismaClient, "clipReview">,
  scheduledPostId: string,
): Promise<AppendedReview[]> {
  return client.clipReview.findMany({
    where: { scheduledPostIdSnapshot: scheduledPostId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: { feedback: { orderBy: { createdAt: "asc" } } },
  });
}
