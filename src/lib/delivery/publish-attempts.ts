import { PublishAttemptState, type Prisma, type PrismaClient } from "@prisma/client";
import { FacebookApiAuthError, FacebookApiError } from "@/lib/integrations/facebook";

type PublishAttemptClient = PrismaClient | Prisma.TransactionClient;

/**
 * Intent recorded before a publish call, and the settlement recorded after it.
 *
 * The problem this solves: a Meta call is a side effect on someone else's system, and the process
 * making it can die at any point. Without a row written *before* the call, a worker that dies
 * mid-publish is indistinguishable from one that died before dialling — and the safe-looking
 * recovery, re-queueing the slot, is the one that posts to a church's Page twice.
 *
 * So the order is: write the intent, make the call, settle the intent. An unsettled intent is the
 * signal that an external effect may exist, and recovery reads it rather than guessing.
 */

/** What a publish call turned out to be. */
export type PublishOutcome =
  | { kind: "succeeded"; providerPostId: string }
  | { kind: "failed"; errorCode: string; errorMessage: string }
  | { kind: "indeterminate"; errorCode: string; errorMessage: string };

const MAX_ERROR_MESSAGE = 500;

function truncate(message: string): string {
  return message.length > MAX_ERROR_MESSAGE ? `${message.slice(0, MAX_ERROR_MESSAGE - 1)}…` : message;
}

/**
 * Whether a thrown error leaves the outside world in a known state.
 *
 * Anything unrecognised is treated as indeterminate. That is the conservative direction: a
 * mistaken "indeterminate" costs an operator one look at the Page, while a mistaken "failed"
 * costs the church a duplicate post.
 */
export function classifyPublishFailure(
  error: unknown,
): { kind: "failed" | "indeterminate"; errorCode: string; errorMessage: string } {
  const errorMessage = truncate(error instanceof Error ? error.message : String(error));

  // A rejected token never reached the point of creating anything.
  if (error instanceof FacebookApiAuthError) {
    return { kind: "failed", errorCode: "FACEBOOK_AUTH_REJECTED", errorMessage };
  }
  if (error instanceof FacebookApiError) {
    return error.indeterminate
      ? { kind: "indeterminate", errorCode: "FACEBOOK_OUTCOME_UNKNOWN", errorMessage }
      : { kind: "failed", errorCode: "FACEBOOK_REQUEST_REFUSED", errorMessage };
  }
  return { kind: "indeterminate", errorCode: "PUBLISH_OUTCOME_UNKNOWN", errorMessage };
}

/**
 * Records the intention to publish one slot, naming the exact clip and export the decision was
 * made about. Written before the provider call, inside the same poll iteration that claimed the
 * slot, so a crash on the next line still leaves the intent behind.
 */
export async function recordPublishIntent(
  client: PublishAttemptClient,
  params: {
    scheduledPostId: string;
    expectedClipId: string | null;
    expectedExportJobId: string | null;
    now: Date;
  },
): Promise<string> {
  const attempt = await client.publishAttempt.create({
    data: {
      scheduledPostId: params.scheduledPostId,
      expectedClipId: params.expectedClipId,
      expectedExportJobId: params.expectedExportJobId,
      state: PublishAttemptState.INTENT,
      attemptedAt: params.now,
    },
    select: { id: true },
  });
  return attempt.id;
}

/** Settles an intent row with what actually happened. */
export async function settlePublishAttempt(
  client: PublishAttemptClient,
  params: { attemptId: string; outcome: PublishOutcome; now: Date },
): Promise<void> {
  const { outcome } = params;
  await client.publishAttempt.update({
    where: { id: params.attemptId },
    data: {
      state:
        outcome.kind === "succeeded"
          ? PublishAttemptState.SUCCEEDED
          : outcome.kind === "failed"
            ? PublishAttemptState.FAILED
            : PublishAttemptState.INDETERMINATE,
      providerPostId: outcome.kind === "succeeded" ? outcome.providerPostId : null,
      errorCode: outcome.kind === "succeeded" ? null : outcome.errorCode,
      errorMessage: outcome.kind === "succeeded" ? null : outcome.errorMessage,
      finishedAt: params.now,
    },
  });
}

/**
 * Whether a slot stuck IN_PROGRESS may be re-queued, or whether a person has to look first.
 *
 * An unsettled `INTENT` row means a provider call was started and this process never learned how
 * it ended. A post may exist on the Page. Re-queueing would publish it again, so recovery stops
 * and hands the slot to an operator instead. No intent row means the worker died before calling,
 * and the slot is safe to retry.
 */
export async function hasUnsettledPublishIntent(
  client: PublishAttemptClient,
  scheduledPostId: string,
): Promise<boolean> {
  const unsettled = await client.publishAttempt.findFirst({
    where: { scheduledPostId, state: PublishAttemptState.INTENT },
    select: { id: true },
  });
  return unsettled !== null;
}

/** The exception type an indeterminate outcome opens. One name, so the queue can be filtered. */
export const INDETERMINATE_PUBLISH_EXCEPTION = "indeterminate_publish_outcome";

export const INDETERMINATE_PUBLISH_MESSAGE =
  "A post may have been created on the Page, but the result never came back. Check the Page before doing anything else with this slot: it will not be retried automatically.";
