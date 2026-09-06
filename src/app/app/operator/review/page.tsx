import Link from "next/link";
import { requirePlatformOperator } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { editorialProgramStatus } from "@/lib/review/editorial-program";
import { listOperatorReviewQueue } from "@/lib/review/query";

export const dynamic = "force-dynamic";

/**
 * Every church's review queue in one list.
 *
 * The authorization check is in this page, not in a layout above it. Next's own guidance is
 * explicit about why: a layout does not control whether the rest of the route renders, and route
 * segments render regardless of what the layout returns — so a layout that hid this page would
 * still let it run and still put it in the RSC payload. The check goes next to the data.
 */
export default async function OperatorReviewQueuePage() {
  await requirePlatformOperator();

  const [rows, program] = await Promise.all([
    listOperatorReviewQueue(prisma),
    editorialProgramStatus(prisma),
  ]);

  return (
    <div className="grid gap-6">
      <div>
        <p className="text-sm font-medium text-teal-800">Operator</p>
        <h1 className="mt-1 text-2xl font-semibold">Review queue</h1>
        <p className="mt-1 text-sm text-stone-500">
          Every scheduled slot awaiting a decision, across every church, soonest first.
        </p>
      </div>

      {/*
        Where the phase stands, above the work rather than on a page of its own. The reviewer
        needs two facts while deciding: that their judgement is still the authority, and that the
        clock is running. A day count that has quietly stopped is the failure worth seeing.
      */}
      {program === null ? (
        <p
          data-testid="program-not-started"
          className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm text-stone-600"
        >
          The 30-day human-only review phase has not started. Decisions recorded now are real, but
          they are not counted toward the reference phase.
        </p>
      ) : (
        <div
          data-testid="program-status"
          className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm text-stone-600"
        >
          <p>
            <span className="font-medium text-stone-800">
              Day {program.elapsedDays} of {program.minimumDays}
            </span>
            {program.state === "PAUSED"
              ? " · paused, and delivery is paused with it"
              : program.minimumMet
                ? " · minimum served"
                : ""}
            {" · your decision is the authority"}
          </p>
          {program.agentReviews > 0 ? (
            <p data-testid="program-contaminated" className="mt-1 text-rose-700">
              {program.agentReviews} agent-written review(s) landed inside this window.
            </p>
          ) : null}
        </div>
      )}

      {rows.length === 0 ? (
        <p data-testid="review-queue-empty" className="text-sm text-stone-500">
          Nothing is waiting for a decision.
        </p>
      ) : (
        <ul data-testid="review-queue" className="grid gap-3">
          {rows.map((row) => (
            <li
              key={row.scheduledPostId}
              className="rounded-lg border border-stone-200 bg-white p-4"
            >
              <Link
                href={`/app/operator/review/${row.scheduledPostId}`}
                className="text-base font-medium text-teal-900 underline"
              >
                {row.clipTitle}
              </Link>
              <p className="mt-1 text-sm text-stone-500">
                {row.churchName} · {row.projectName} ·{" "}
                {new Date(row.scheduledDate).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                  timeZone: "UTC",
                })}
              </p>
              <p className="mt-1 text-xs text-stone-500">
                {row.renderState ? `render ${row.renderState}` : "no render bound"}
                {row.qcStatus ? ` · QC ${row.qcStatus}` : ""}
                {row.latestDecision
                  ? ` · ${row.latestDecision}${row.latestDecisionIsCurrent ? "" : " (earlier file)"}`
                  : " · no decision"}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
