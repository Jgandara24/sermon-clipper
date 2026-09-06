import Link from "next/link";
import { requirePlatformOperator } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
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

  const rows = await listOperatorReviewQueue(prisma);

  return (
    <div className="grid gap-6">
      <div>
        <p className="text-sm font-medium text-teal-800">Operator</p>
        <h1 className="mt-1 text-2xl font-semibold">Review queue</h1>
        <p className="mt-1 text-sm text-stone-500">
          Every scheduled slot awaiting a decision, across every church, soonest first.
        </p>
      </div>

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
