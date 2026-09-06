import Link from "next/link";
import { OperatorCandidateList } from "@/components/operator/operator-candidate-list";
import { PriorServiceFillForm } from "@/components/operator/prior-service-fill-form";
import type { OperatorProjectPool, PoolSlotSummary } from "@/lib/candidates/project-pool";
import type { ShortageResolutionSlot } from "@/lib/review/prior-service-fill-options";
import type { ReplacementLineageRow } from "@/lib/review/query";

/**
 * A service's whole pool, as staff see it.
 *
 * Two things separate this from the church view (`clip-list.tsx`): the internal limits that
 * explain why the pool is the size it is, and the posting dates themselves — including any left
 * empty, which have no candidate row and are the ones needing action.
 *
 * The Selector's opinion is absent here too. The plan only requires hiding it from churches, but
 * S14 is about reviewers: someone who has seen the machine's confidence is no longer an
 * independent judgement of the machine's work, and this page sits one click from the review queue.
 */

function formatDay(date: Date | string) {
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Whether a date has a file a reviewer could actually decide about. */
function isReviewable(slot: PoolSlotSummary): boolean {
  return Boolean(
    slot.clipId && slot.boundRender?.state === "SUCCEEDED" && slot.boundRender.hasChecksum,
  );
}

export function OperatorProjectCandidatePool({
  pool,
  lineage,
  previewUrl,
  shortages,
}: {
  pool: OperatorProjectPool;
  lineage: ReplacementLineageRow[];
  /** The church's signed recording, or null once retention has purged it. */
  previewUrl: string | null;
  /** Fill options, keyed by slot, for the dates that have nothing to post. */
  shortages: Record<string, ShortageResolutionSlot>;
}) {
  return (
    <div className="grid gap-6">
      <section
        data-testid="operator-pool-limits"
        className="rounded-lg border border-stone-200 bg-white p-4 text-sm"
      >
        <h2 className="font-semibold">Pool size</h2>
        <p className="mt-1 text-stone-600">
          <span data-testid="operator-pool-count" className="font-medium text-stone-900">
            {pool.retainedCount} retained
          </span>{" "}
          against a ceiling of {pool.limits.effectiveSnapshot} frozen into this service.
        </p>
        {/*
          Staff-only, all of it. These are the facts a church must never see (§2.2), shown here
          because "why is this pool 12 and not 18" is otherwise unanswerable without a database.
          There is deliberately no control to change any of them — `npm run
          set:candidate-limit-override` is the only door, and this page grants no such authority.
        */}
        <dl className="mt-3 grid gap-2 text-xs text-stone-600 sm:grid-cols-3">
          <div>
            <dt className="text-stone-500">Master default</dt>
            <dd className="font-medium">{pool.limits.masterDefault}</dd>
          </div>
          <div>
            <dt className="text-stone-500">Hard maximum</dt>
            <dd className="font-medium">{pool.limits.hardMaximum}</dd>
          </div>
          <div>
            <dt className="text-stone-500">Church override</dt>
            <dd className="font-medium">
              {pool.limits.hiddenOverride === null ? "none" : pool.limits.hiddenOverride}
            </dd>
          </div>
        </dl>
        {!pool.renderSourceAvailable ? (
          <p data-testid="operator-source-purged" className="mt-3 text-amber-800">
            The sermon recording has been purged, so nothing in this pool can be rendered.
          </p>
        ) : null}
      </section>

      <section>
        <h2 className="text-sm font-semibold text-stone-800">Posting dates</h2>
        <ul data-testid="operator-slots" className="mt-2 grid gap-2">
          {pool.slots.length === 0 ? (
            <li className="text-sm text-stone-500">This service owns no posting dates.</li>
          ) : (
            pool.slots.map((slot) => (
              <li
                key={slot.scheduledPostId}
                data-testid={slot.clipId ? "operator-slot-filled" : "operator-slot-empty"}
                className={`rounded-md border p-3 text-sm ${
                  slot.clipId ? "border-stone-200 bg-white" : "border-amber-200 bg-amber-50"
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{formatDay(slot.scheduledDate)}</span>
                  <span className="text-xs uppercase tracking-wide text-stone-500">
                    {slot.publishStatus.replace(/_/g, " ")}
                  </span>
                  {/*
                    The review page identifies a file by four facts, one of which is the QC-time
                    checksum. A render that has not finished has none, so this link waits for the
                    file to exist rather than opening a page that can only say it does not.
                  */}
                  {isReviewable(slot) ? (
                    <Link
                      href={`/app/operator/review/${slot.scheduledPostId}`}
                      data-testid="operator-slot-review-link"
                      className="text-xs text-teal-800 underline"
                    >
                      Review this date
                    </Link>
                  ) : null}
                </div>
                <p className="mt-1 text-xs text-stone-500">
                  {slot.clipId
                    ? slot.boundRender
                      ? isReviewable(slot)
                        ? `Render ${slot.boundRender.state.toLowerCase()}${
                            slot.boundRender.qcStatus
                              ? ` · QC ${slot.boundRender.qcStatus.toLowerCase()}`
                              : ""
                          }`
                        : slot.boundRender.state === "FAILED"
                          ? "The render failed. This date stays blocked until it is re-rendered."
                          : "A render is in progress. This date opens for review once it finishes."
                      : "No render bound yet."
                    : "No clip in this date. A replacement found no reserve, or none was allocated."}
                </p>
                {shortages[slot.scheduledPostId] ? (
                  <div
                    data-testid="operator-slot-shortage"
                    className="mt-3 rounded-md border border-stone-200 bg-white p-3"
                  >
                    <p className="text-xs font-medium text-stone-700">
                      Fill this date from an earlier service
                    </p>
                    <div className="mt-2">
                      <PriorServiceFillForm slot={shortages[slot.scheduledPostId]} />
                    </div>
                  </div>
                ) : null}
              </li>
            ))
          )}
        </ul>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-stone-800">Every candidate</h2>
        <OperatorCandidateList candidates={pool.candidates} previewUrl={previewUrl} />
      </section>

      <section>
        <h2 className="text-sm font-semibold text-stone-800">Replacement lineage</h2>
        {lineage.length === 0 ? (
          <p data-testid="operator-lineage-empty" className="mt-2 text-sm text-stone-500">
            No clip in this service has been replaced.
          </p>
        ) : (
          <ol data-testid="operator-lineage" className="mt-2 grid gap-2">
            {lineage.map((row) => (
              <li
                key={row.clipReviewId}
                className="rounded-md border border-stone-200 bg-white p-3 text-sm"
              >
                <p className="text-xs text-stone-500">
                  {formatDay(row.decidedAt)}
                  {row.reviewerEmail ? ` · ${row.reviewerEmail}` : ""}
                </p>
                <p className="mt-1">
                  <span className="font-medium">
                    Rank {row.rejected.rank}
                    {row.rejected.title ? ` — ${row.rejected.title}` : " (clip since deleted)"}
                  </span>
                  {" was set aside, "}
                  {row.promoted ? (
                    <span className="font-medium">rank {row.promoted.rank} took its date</span>
                  ) : (
                    /* The empty-pool replacement. The most important lineage row there is. */
                    <span className="font-medium text-amber-800">
                      and nothing was available to take its date
                    </span>
                  )}
                  .
                </p>
                {row.note ? <p className="mt-1 text-xs text-stone-600">{row.note}</p> : null}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
