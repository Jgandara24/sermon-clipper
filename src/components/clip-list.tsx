"use client";

import { Pencil, Send, ThumbsDown, ThumbsUp } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { CandidateStateBadge, candidateStateCopy } from "@/components/candidates/candidate-state-badge";
import { SourceRangePreview } from "@/components/candidates/source-range-preview";
import type { CandidatePresentationState } from "@/lib/candidates/project-pool";

/**
 * The clips of one service, as the church sees them.
 *
 * **No selector signal appears here, and the type is what enforces it.** The score, its
 * subscores, the model that produced them and the excerpt it quoted were all on this card until
 * P3.2 and are all gone: §2.2 of the plan says no church-facing page exposes them, and a field
 * the type does not have cannot be rendered by accident. The same removal happened in the API
 * route that feeds this list.
 */

export type Clip = {
  id: string;
  rank: number;
  startMs: number;
  endMs: number;
  title: string;
  hookText: string | null;
  summary: string;
  status: string;
  liked: boolean | null;
  /** Where this clip stands in the service: scheduled, reserve, retired (P3.1). */
  state: CandidatePresentationState;
  /** The date it is booked for, when it is booked. */
  scheduledDate: string | null;
  /** Whether a final file exists for it yet, and how that render is doing. */
  finalRender: { state: string; qcStatus: string | null } | null;
  /** The standing decision, and whether it was made about the file booked now. */
  review: { latestDecision: string | null; isAboutBoundRender: boolean };
  /** The older service a borrowed fill came from. Null for this service's own clips. */
  borrowedFromProjectId: string | null;
  /**
   * The signed sermon recording this moment is cut from, or null when it has been deleted.
   *
   * One URL for the whole service, shared by every candidate — each one plays its own span of it
   * through byte ranges. Signing one link rather than a dozen is the cheap part; `preload="none"`
   * is what stops any of them being fetched before somebody asks.
   */
  previewUrl: string | null;
  scriptureReferences: Array<{
    id: string;
    normalized: string;
    detectedText: string;
  }>;
  approval: {
    state: string;
    reviewUrl: string | null;
    reviewTokenExpiresAt?: string | null;
    notificationStatus?: string | null;
  } | null;
};

function formatTimestamp(ms: number) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatDay(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * What a church is told about the final file, in one line.
 *
 * A reserve has no final render and that is correct rather than a failure, so it says what a
 * reserve *is* — a preview of the source — instead of reporting an absence. Only scheduled clips
 * are rendered (P2.4), and saying so here is what stops "no final file" reading as a fault.
 */
function renderLine(clip: Clip): string {
  if (clip.state === "RESERVE") {
    return candidateStateCopy("RESERVE").description;
  }
  if (!clip.finalRender) {
    return "Final file: not started yet.";
  }
  const qc = clip.finalRender.qcStatus ? ` · quality check ${clip.finalRender.qcStatus.toLowerCase()}` : "";
  const decision = clip.review.latestDecision
    ? clip.review.isAboutBoundRender
      ? ` · reviewed: ${clip.review.latestDecision.toLowerCase()}`
      : " · reviewed, but that was an earlier version of the file"
    : " · not reviewed yet";
  return `Final file: ${clip.finalRender.state.toLowerCase()}${qc}${decision}`;
}

function ClipCard({
  clip,
  onLike,
  isPreviewOpen,
  onTogglePreview,
}: {
  clip: Clip;
  onLike: (id: string, liked: boolean | null) => void;
  isPreviewOpen: boolean;
  onTogglePreview: () => void;
}) {
  const [isSaving, setIsSaving] = useState(false);
  const [approval, setApproval] = useState(clip.approval);
  const [reviewerEmail, setReviewerEmail] = useState("");
  const [reviewerPhone, setReviewerPhone] = useState("");

  async function handleLike(nextLiked: boolean | null) {
    setIsSaving(true);
    try {
      const res = await fetch(`/api/clips/${clip.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ liked: nextLiked }),
      });
      if (res.ok) onLike(clip.id, nextLiked);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleRequestReview() {
    setIsSaving(true);
    try {
      const res = await fetch(`/api/clips/${clip.id}/approval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewerEmail, reviewerPhone }),
      });
      const json = await res.json();
      if (res.ok) {
        const notificationSummary =
          json.data.notifications?.length > 0
            ? json.data.notifications
                .map((item: { channel: string; status: string }) => `${item.channel.toLowerCase()} ${item.status.toLowerCase()}`)
                .join(", ")
            : null;
        setApproval({
          state: json.data.state,
          reviewUrl: json.data.reviewUrl,
          reviewTokenExpiresAt: json.data.reviewTokenExpiresAt,
          notificationStatus: notificationSummary,
        });
      }
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <article className="rounded-lg border border-stone-200 p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <CandidateStateBadge state={clip.state} />
            {clip.scheduledDate ? (
              <span className="text-xs font-medium text-stone-600">
                {formatDay(clip.scheduledDate)}
              </span>
            ) : null}
          </div>
          <p className="mt-2 text-xs font-medium uppercase tracking-wide text-stone-500">
            Rank {clip.rank} · {formatTimestamp(clip.startMs)}–{formatTimestamp(clip.endMs)} ·{" "}
            {Math.round((clip.endMs - clip.startMs) / 1000)}s
          </p>
          <h4 className="mt-1 text-base font-semibold">{clip.title}</h4>
          {clip.hookText ? (
            <p className="mt-1 text-sm italic text-stone-500">&quot;{clip.hookText}&quot;</p>
          ) : null}
          <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-600">{clip.summary}</p>
          {clip.scriptureReferences.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {clip.scriptureReferences.map((ref) => (
                <span
                  key={ref.id}
                  title={`Detected from "${ref.detectedText}"`}
                  className="rounded-full border border-teal-200 bg-teal-50 px-2.5 py-1 text-xs font-medium text-teal-900"
                >
                  {ref.normalized}
                </span>
              ))}
            </div>
          ) : null}
          <p className="mt-2 text-xs text-stone-500">{renderLine(clip)}</p>
          <SourceRangePreview
            mediaUrl={clip.previewUrl}
            startMs={clip.startMs}
            endMs={clip.endMs}
            isOpen={isPreviewOpen}
            onToggle={onTogglePreview}
            label={clip.title}
          />
          {approval ? (
            <div className="mt-3 rounded-md border border-stone-200 bg-stone-50 p-3 text-xs text-stone-600">
              <p>
                Approval: <span className="font-medium text-stone-800">{approval.state.replace(/_/g, " ")}</span>
              </p>
              {approval.reviewUrl ? (
                <Link href={approval.reviewUrl} className="mt-1 inline-block text-teal-800 hover:underline">
                  Open phone review link
                </Link>
              ) : null}
              {approval.reviewTokenExpiresAt ? (
                <p className="mt-1">Expires: {new Date(approval.reviewTokenExpiresAt).toLocaleDateString()}</p>
              ) : null}
              {approval.notificationStatus ? (
                <p className="mt-1">Notification: {approval.notificationStatus}</p>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <div className="flex gap-1">
            <Link
              href={`/app/clips/${clip.id}/editor`}
              className="rounded-md border border-stone-300 p-1.5 text-stone-500 hover:bg-stone-50"
              aria-label="Edit this clip"
            >
              <Pencil size={14} />
            </Link>
            <button
              type="button"
              disabled={isSaving}
              onClick={handleRequestReview}
              className="rounded-md border border-stone-300 p-1.5 text-stone-500 hover:bg-stone-50 disabled:opacity-50"
              aria-label="Send this clip for approval"
            >
              <Send size={14} />
            </button>
            <button
              type="button"
              disabled={isSaving}
              onClick={() => handleLike(clip.liked === true ? null : true)}
              className={`rounded-md border p-1.5 disabled:opacity-50 ${
                clip.liked === true
                  ? "border-teal-700 bg-teal-50 text-teal-800"
                  : "border-stone-300 text-stone-500 hover:bg-stone-50"
              }`}
              aria-label="Like this clip"
            >
              <ThumbsUp size={14} />
            </button>
            <button
              type="button"
              disabled={isSaving}
              onClick={() => handleLike(clip.liked === false ? null : false)}
              className={`rounded-md border p-1.5 disabled:opacity-50 ${
                clip.liked === false
                  ? "border-red-700 bg-red-50 text-red-800"
                  : "border-stone-300 text-stone-500 hover:bg-stone-50"
              }`}
              aria-label="Dislike this clip"
            >
              <ThumbsDown size={14} />
            </button>
          </div>
          <div className="grid max-w-[220px] gap-1 text-xs">
            <input
              type="email"
              value={reviewerEmail}
              onChange={(event) => setReviewerEmail(event.target.value)}
              placeholder="Reviewer email"
              className="rounded-md border border-stone-300 px-2 py-1"
              aria-label="Reviewer email"
            />
            <input
              type="tel"
              value={reviewerPhone}
              onChange={(event) => setReviewerPhone(event.target.value)}
              placeholder="Reviewer phone"
              className="rounded-md border border-stone-300 px-2 py-1"
              aria-label="Reviewer phone"
            />
          </div>
        </div>
      </div>
    </article>
  );
}

/** The three groups, in the order a church cares about them. */
const SECTIONS: {
  id: string;
  heading: string;
  blurb: string;
  states: CandidatePresentationState[];
}[] = [
  {
    id: "scheduled",
    heading: "Going out",
    blurb: "Booked for a date. These are the clips that get a final file.",
    states: ["SCHEDULED", "SELECTED_REPLACEMENT", "PRIOR_SERVICE_FILL"],
  },
  {
    id: "reserves",
    heading: "In reserve",
    blurb:
      "Ready to step in if a scheduled clip is set aside. They are previewed from the sermon " +
      "recording and are not rendered until one is chosen.",
    states: ["RESERVE"],
  },
  {
    id: "retired",
    heading: "Set aside",
    blurb: "Kept so past decisions stay readable.",
    states: ["SUPERSEDED", "HIDDEN"],
  },
];

export function ClipList({ initialClips }: { initialClips: Clip[] }) {
  const [clips, setClips] = useState(initialClips);
  // One preview at a time. Held here rather than in each card so opening a second closes the
  // first, which is both the plan's rule and the only way a page of candidates stays cheap.
  const [openPreviewId, setOpenPreviewId] = useState<string | null>(null);

  function handleLike(id: string, liked: boolean | null) {
    setClips((prev) => prev.map((clip) => (clip.id === id ? { ...clip, liked } : clip)));
  }

  if (clips.length === 0) {
    return (
      <p data-testid="candidate-pool-empty" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        No clips yet — they will appear once analysis finishes.
      </p>
    );
  }

  return (
    <div className="grid gap-6">
      {SECTIONS.map((section) => {
        // Rank order is preserved from the pool; filtering never reorders.
        const rows = clips.filter((clip) => section.states.includes(clip.state));
        if (rows.length === 0) return null;
        return (
          <section key={section.id} data-testid={`candidate-section-${section.id}`}>
            <h3 className="text-sm font-semibold text-stone-800">{section.heading}</h3>
            <p className="mt-1 text-xs text-stone-500">{section.blurb}</p>
            <div className="mt-3 grid gap-3">
              {rows.map((clip) => (
                <ClipCard
                  key={clip.id}
                  clip={clip}
                  onLike={handleLike}
                  isPreviewOpen={openPreviewId === clip.id}
                  onTogglePreview={() =>
                    setOpenPreviewId((current) => (current === clip.id ? null : clip.id))
                  }
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
