"use client";

import { useState } from "react";
import { CandidateStateBadge } from "@/components/candidates/candidate-state-badge";
import { SourceRangePreview } from "@/components/candidates/source-range-preview";
import type { PoolCandidate } from "@/lib/candidates/project-pool";

/**
 * The candidate rows of the operator pool, and the one preview that may be open at a time.
 *
 * Extracted from `project-candidate-pool.tsx` because this is the only part of that page needing
 * state; the limits, dates and lineage stay server-rendered.
 */

function formatDay(date: Date | string) {
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatRange(startMs: number, endMs: number) {
  const stamp = (ms: number) => {
    const total = Math.floor(ms / 1000);
    return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
  };
  return `${stamp(startMs)}–${stamp(endMs)}`;
}

export function OperatorCandidateList({
  candidates,
  previewUrl,
}: {
  candidates: PoolCandidate[];
  /** The church's signed recording, or null once retention has purged it. */
  previewUrl: string | null;
}) {
  const [openPreviewId, setOpenPreviewId] = useState<string | null>(null);

  return (
    <ul data-testid="operator-candidates" className="mt-2 grid gap-2">
      {candidates.map((candidate) => (
        <li
          key={candidate.clipId}
          className="rounded-md border border-stone-200 bg-white p-3 text-sm"
        >
          <div className="flex flex-wrap items-center gap-2">
            <CandidateStateBadge state={candidate.state} />
            <span className="text-xs font-medium uppercase tracking-wide text-stone-500">
              Rank {candidate.rank} ·{" "}
              {formatRange(candidate.sourceRange.startMs, candidate.sourceRange.endMs)} ·{" "}
              {Math.round(candidate.durationMs / 1000)}s
            </span>
            {candidate.scheduledDate ? (
              <span className="text-xs text-stone-600">{formatDay(candidate.scheduledDate)}</span>
            ) : null}
          </div>
          <p className="mt-1 font-medium">{candidate.title}</p>
          {candidate.hook ? (
            <p className="mt-0.5 text-xs italic text-stone-500">&quot;{candidate.hook}&quot;</p>
          ) : null}
          <p className="mt-1 text-xs text-stone-500">
            {candidate.review.latestDecision
              ? candidate.review.isAboutBoundRender
                ? `Decision: ${candidate.review.latestDecision}`
                : `Decision: ${candidate.review.latestDecision} (about an earlier file)`
              : "No decision recorded."}
            {candidate.borrowedFromProjectId ? " · borrowed from an earlier service" : ""}
          </p>
          <SourceRangePreview
            // A borrowed fill comes from a different service's recording, so this link would play
            // the wrong sermon. It is previewable on its own service's page.
            mediaUrl={candidate.borrowedFromProjectId === null ? previewUrl : null}
            startMs={candidate.sourceRange.startMs}
            endMs={candidate.sourceRange.endMs}
            isOpen={openPreviewId === candidate.clipId}
            onToggle={() =>
              setOpenPreviewId((current) =>
                current === candidate.clipId ? null : candidate.clipId,
              )
            }
            label={candidate.title}
          />
        </li>
      ))}
    </ul>
  );
}
