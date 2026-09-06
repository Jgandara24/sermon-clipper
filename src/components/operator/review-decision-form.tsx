"use client";

import { ClipReviewDecision } from "@prisma/client";
import { useActionState, useState } from "react";
import { addReviewFeedbackAction, submitClipReviewAction } from "@/app/actions/clip-review";
import { CLIP_REVIEW_IDLE } from "@/lib/review/decision-input";
import {
  emptyFinding,
  ReviewFeedbackList,
  type DraftFinding,
} from "@/components/operator/review-feedback-list";

/**
 * Recording a decision about the exact file above it.
 *
 * The identity travels with the submission as hidden fields, because a decision has to name what
 * the reviewer actually watched. The server compares those four values with what the slot holds
 * now and refuses if they differ — so a rerender landing mid-review produces a refusal to reload,
 * not a verdict silently attached to a file nobody saw.
 *
 * `REPLACE` is live as of P2.7. It does not append a decision: it runs one transaction that
 * supersedes this clip, promotes the sermon's next reserve, rebinds the slot, and queues that
 * reserve's render at priority. If the sermon has no clip left, the same transaction still records
 * the decision, empties the slot and opens an exception — there is no half-replaced state to land
 * in, which is why it is a command rather than a button that does five things in a row.
 */

type Identity = {
  clipId: string;
  exportJobId: string;
  editVersion: number;
  checksum: string;
};

function Status({ state }: { state: { status: string; message: string } }) {
  if (state.status === "idle" || !state.message) return null;
  return (
    <p
      data-testid={state.status === "error" ? "review-error" : "review-success"}
      aria-live="polite"
      className={
        state.status === "error"
          ? "rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900"
          : "rounded border border-teal-200 bg-teal-50 px-3 py-2 text-sm text-teal-900"
      }
    >
      {state.message}
    </p>
  );
}

export function ReviewDecisionForm({
  scheduledPostId,
  identity,
}: {
  scheduledPostId: string;
  identity: Identity;
}) {
  const [state, formAction, pending] = useActionState(submitClipReviewAction, CLIP_REVIEW_IDLE);
  const [findings, setFindings] = useState<DraftFinding[]>(() => [emptyFinding()]);

  return (
    <form action={formAction} className="grid gap-4" data-testid="review-decision-form">
      <input type="hidden" name="scheduledPostId" value={scheduledPostId} />
      <input type="hidden" name="clipId" value={identity.clipId} />
      <input type="hidden" name="exportJobId" value={identity.exportJobId} />
      <input type="hidden" name="editVersion" value={identity.editVersion} />
      <input type="hidden" name="checksum" value={identity.checksum} />

      <label className="grid gap-1 text-sm">
        <span className="text-xs uppercase tracking-wide text-stone-500">Note (optional)</span>
        <textarea
          name="note"
          aria-label="Decision note"
          rows={2}
          disabled={pending}
          className="rounded border border-stone-300 px-2 py-1"
        />
      </label>

      <div className="grid gap-2">
        <p className="text-sm font-semibold">Findings</p>
        <ReviewFeedbackList findings={findings} onChange={setFindings} disabled={pending} />
      </div>

      <Status state={state} />

      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          name="decision"
          value={ClipReviewDecision.ACCEPT}
          disabled={pending}
          data-testid="review-accept"
          className="rounded bg-teal-800 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Accept this file
        </button>
        <button
          type="submit"
          name="decision"
          value={ClipReviewDecision.REVISE}
          disabled={pending}
          data-testid="review-revise"
          className="rounded border border-stone-300 px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          Ask for a revision
        </button>
        <button
          type="submit"
          name="decision"
          value={ClipReviewDecision.REPLACE}
          disabled={pending}
          data-testid="review-replace"
          className="rounded border border-amber-400 px-4 py-2 text-sm font-medium text-amber-900 disabled:opacity-50"
        >
          Replace this clip
        </button>
      </div>

      <p className="text-xs text-stone-500">
        Replacing supersedes this clip, promotes this sermon&apos;s next-best one into the same
        date, and queues its render ahead of the backlog. All of it lands together or none of it
        does. If the sermon has nothing left, the date is emptied and flagged for you rather than
        left pointing at a clip you rejected.
      </p>
    </form>
  );
}

/** Findings noticed after the decision was recorded. The decision itself does not move. */
export function AddFeedbackForm({
  clipReviewId,
  scheduledPostId,
}: {
  clipReviewId: string;
  scheduledPostId: string;
}) {
  const [state, formAction, pending] = useActionState(addReviewFeedbackAction, CLIP_REVIEW_IDLE);
  const [findings, setFindings] = useState<DraftFinding[]>(() => [emptyFinding()]);

  return (
    <form action={formAction} className="mt-3 grid gap-3" data-testid="review-add-feedback-form">
      <input type="hidden" name="clipReviewId" value={clipReviewId} />
      <input type="hidden" name="scheduledPostId" value={scheduledPostId} />

      <ReviewFeedbackList findings={findings} onChange={setFindings} disabled={pending} />
      <Status state={state} />

      <button
        type="submit"
        disabled={pending}
        data-testid="review-add-feedback"
        className="justify-self-start rounded border border-stone-300 px-3 py-1.5 text-sm disabled:opacity-50"
      >
        Add to this decision
      </button>
    </form>
  );
}
