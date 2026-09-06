import Link from "next/link";
import {
  AddFeedbackForm,
  ReviewDecisionForm,
} from "@/components/operator/review-decision-form";
import type { OperatorReviewDetail } from "@/lib/review/query";

/**
 * The exact file a slot will publish, and the facts that identify it.
 *
 * A reviewer's judgement is only worth recording if it was made against the file that goes out,
 * so the identity is on the page rather than implied: the clip, the saved edit version, the export
 * that produced this file, and the checksum taken when it passed QC. P2.8 matches all four at
 * publish time, and a decision made against anything else is refused.
 *
 * Title and hook are shown and labelled as machine-generated, because they are under review too.
 * The selector's score, subscores and rationale are not here and must never be added: a reviewer
 * who has seen the machine's confidence is no longer independent of it.
 */

function formatMs(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-stone-500">{label}</dt>
      <dd className="mt-0.5 font-mono text-xs break-all text-stone-900">{value}</dd>
    </div>
  );
}

export function RenderedClipReview({ detail }: { detail: OperatorReviewDetail }) {
  return (
    <div className="grid gap-6">
      <div>
        <Link href="/app/operator/review" className="text-sm text-teal-800 underline">
          ← Review queue
        </Link>
        <p className="mt-4 text-sm font-medium text-teal-800">{detail.churchName}</p>
        <h1 className="mt-1 text-2xl font-semibold">{detail.projectName}</h1>
        {/* The pool behind this one date. A reviewer about to REPLACE wants to know what is
            actually available before deciding, and this is the only route to it. */}
        {detail.projectId ? (
          <Link
            href={`/app/operator/projects/${detail.projectId}`}
            data-testid="operator-project-link"
            className="mt-1 inline-block text-sm text-teal-800 underline"
          >
            Inspect this service&rsquo;s candidate pool
          </Link>
        ) : null}
        <p className="mt-1 text-sm text-stone-500">
          {detail.platform} · {formatDate(detail.scheduledDate)} · {detail.publishStatus}
        </p>
      </div>

      <section aria-label="The file under review" className="grid gap-3">
        {detail.playbackUrl ? (
          <video
            data-testid="review-player"
            src={detail.playbackUrl}
            controls
            preload="metadata"
            className="w-full max-w-sm rounded-lg border border-stone-200 bg-black"
          />
        ) : (
          <p
            data-testid="review-unplayable"
            className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          >
            {detail.unplayableReason}
          </p>
        )}
      </section>

      <section aria-label="Fields under review" className="grid gap-3">
        <h2 className="text-sm font-semibold">Machine-generated, under review</h2>
        <div className="rounded-lg border border-stone-200 bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-stone-500">Title</p>
          <p data-testid="review-title" className="mt-0.5 text-base font-medium">
            {detail.clipTitle}
          </p>
          <p className="mt-3 text-xs uppercase tracking-wide text-stone-500">Hook</p>
          <p data-testid="review-hook" className="mt-0.5 text-sm text-stone-700">
            {detail.clipHook ?? "— none —"}
          </p>
        </div>
      </section>

      <section aria-label="Render quality" className="grid gap-3">
        <h2 className="text-sm font-semibold">Render QC</h2>
        <p data-testid="review-qc" className="text-sm text-stone-700">
          {detail.qcStatus
            ? `${detail.qcStatus}${detail.qcCheckedAt ? ` · checked ${formatDate(detail.qcCheckedAt)}` : ""}`
            : "Not checked yet."}
        </p>
      </section>

      <section aria-label="What this decision is about" className="grid gap-3">
        <h2 className="text-sm font-semibold">This exact file</h2>
        {detail.identity ? (
          <dl
            data-testid="review-identity"
            className="grid gap-3 rounded-lg border border-stone-200 bg-white p-4 sm:grid-cols-2"
          >
            <Fact label="Clip" value={detail.identity.clipId} />
            <Fact label="Export" value={detail.identity.exportJobId} />
            <Fact label="Edit version" value={String(detail.identity.editVersion)} />
            <Fact label="Checksum" value={detail.identity.checksum} />
            <Fact
              label="Clip range"
              value={`${formatMs(detail.clipStartMs)} – ${formatMs(detail.clipEndMs)}`}
            />
          </dl>
        ) : (
          <p className="text-sm text-stone-500">
            This render cannot be identified, so no decision can be recorded against it.
          </p>
        )}
      </section>

      <section aria-label="Decision history" className="grid gap-3">
        <h2 className="text-sm font-semibold">Decisions</h2>
        {detail.history.length === 0 ? (
          <p data-testid="review-history-empty" className="text-sm text-stone-500">
            No decision has been recorded yet.
          </p>
        ) : (
          <ol data-testid="review-history" className="grid gap-3">
            {detail.history.map((entry) => (
              <li key={entry.id} className="rounded-lg border border-stone-200 bg-white p-4">
                <p className="text-sm font-medium">
                  {entry.decision}
                  {!entry.aboutCurrentRender && (
                    <span
                      data-testid="review-stale-decision"
                      className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-normal text-amber-900"
                    >
                      about an earlier file
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-stone-500">
                  {formatDate(entry.createdAt)}
                  {entry.reviewerEmail ? ` · ${entry.reviewerEmail}` : ""}
                </p>
                {entry.note && <p className="mt-2 text-sm text-stone-700">{entry.note}</p>}
                {entry.feedback.length > 0 && (
                  <ul className="mt-3 grid gap-2">
                    {entry.feedback.map((item) => (
                      <li key={item.id} className="text-sm text-stone-700">
                        <span className="font-mono text-xs text-stone-500">
                          {item.category} · {item.severity} · {item.actionability}
                        </span>
                        <br />
                        {item.note}
                      </li>
                    ))}
                  </ul>
                )}
                {/* Findings can be added to any past decision, however long afterwards. The
                    decision itself never moves — correcting one means appending a new review. */}
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm text-teal-800">
                    Add a finding to this decision
                  </summary>
                  <AddFeedbackForm
                    clipReviewId={entry.id}
                    scheduledPostId={detail.scheduledPostId}
                  />
                </details>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-label="Record a decision" className="grid gap-3">
        <h2 className="text-sm font-semibold">Your decision</h2>
        {detail.identity ? (
          <ReviewDecisionForm
            scheduledPostId={detail.scheduledPostId}
            identity={detail.identity}
          />
        ) : (
          // Reached most often straight after a replacement: the promoted reserve's render is
          // queued, so there is nothing to decide about yet. Saying "no identifiable file" and
          // stopping would leave an operator who just replaced a clip with no idea whether it
          // worked — the form they submitted is gone, and so is the message it carried. The
          // reason the file cannot be played is the same reason it cannot be decided about, so
          // it is the one worth showing.
          <p data-testid="review-undecidable" className="text-sm text-stone-500">
            {detail.unplayableReason ??
              "There is no identifiable file here, so no decision can be recorded against it."}{" "}
            The decision history below records what has already been decided.
          </p>
        )}
      </section>
    </div>
  );
}
