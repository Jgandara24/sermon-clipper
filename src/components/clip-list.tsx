"use client";

import { ChevronDown, ChevronUp, Pencil, Send, ThumbsDown, ThumbsUp } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

type Subscore = { score: number; letter: string; note: string };

export type Clip = {
  id: string;
  rank: number;
  sectionId: string | null;
  startMs: number;
  endMs: number;
  title: string;
  hookText: string | null;
  summary: string;
  status: string;
  liked: boolean | null;
  score: {
    total: number;
    subscores: Record<string, Subscore>;
    modelVersion: string;
    excerpt: string;
  } | null;
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

export type OutlineSection = {
  id: string;
  position: number;
  type: string;
  heading: string;
  summary: string;
  startMs: number;
  endMs: number;
};

export type Outline = {
  mainIdea: string;
  generatedTitle: string | null;
  status: string;
  sections: OutlineSection[];
};

function formatTimestamp(ms: number) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function scoreTone(total: number) {
  if (total >= 85) return "bg-emerald-700";
  if (total >= 70) return "bg-teal-700";
  if (total >= 50) return "bg-amber-600";
  return "bg-stone-500";
}

function ClipCard({
  clip,
  onLike,
  headerLine,
}: {
  clip: Clip;
  onLike: (id: string, liked: boolean | null) => void;
  /** Overrides the default "Rank N · start–end" kicker (the outline view shows section context). */
  headerLine?: string;
}) {
  const [expanded, setExpanded] = useState(false);
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
          <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
            {headerLine ??
              `Rank ${clip.rank} · ${formatTimestamp(clip.startMs)}–${formatTimestamp(clip.endMs)}`}
          </p>
          <h3 className="mt-1 text-base font-semibold">{clip.title}</h3>
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
          {clip.score ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-teal-800 hover:underline"
            >
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {expanded ? "Hide" : "Show"} score breakdown
            </button>
          ) : null}
          {expanded && clip.score ? (
            <div className="mt-3 grid gap-2 rounded-md bg-stone-50 p-3 sm:grid-cols-2">
              {Object.entries(clip.score.subscores).map(([key, sub]) => (
                <div key={key} className="text-xs">
                  <p className="font-medium text-stone-700">
                    {key.replace(/_/g, " ")}: {sub.letter} ({sub.score})
                  </p>
                  <p className="text-stone-500">{sub.note}</p>
                </div>
              ))}
              <p className="col-span-full mt-1 text-xs text-stone-400">
                Scored by {clip.score.modelVersion}
              </p>
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          {clip.score ? (
            <div className={`rounded-lg px-4 py-3 text-center text-white ${scoreTone(clip.score.total)}`}>
              <p className="text-xs">Score</p>
              <p className="text-2xl font-semibold">{clip.score.total}</p>
            </div>
          ) : null}
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

function sectionTypeLabel(type: string) {
  return type
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function sectionRankLabel(index: number) {
  if (index === 0) return "Best in section";
  if (index === 1) return "Second in section";
  if (index === 2) return "Third in section";
  return `#${index + 1} in section`;
}

/** Score-descending order within a section; identical scores fall back to global rank. */
function bySectionScore(a: Clip, b: Clip) {
  return (b.score?.total ?? 0) - (a.score?.total ?? 0) || a.rank - b.rank;
}

function outlineHeaderLine(clip: Clip, sectionIndex: number) {
  const overall = `#${clip.rank} overall`;
  const score = clip.score ? ` · ${clip.score.total}/100` : "";
  return `${overall}${score} · ${sectionRankLabel(sectionIndex)} · ${formatTimestamp(clip.startMs)}–${formatTimestamp(clip.endMs)}`;
}

function OutlineView({
  outline,
  clips,
  onLike,
}: {
  outline: Outline;
  clips: Clip[];
  onLike: (id: string, liked: boolean | null) => void;
}) {
  const unsectioned = clips
    .filter((clip) => !outline.sections.some((s) => s.id === clip.sectionId))
    .sort(bySectionScore);

  return (
    <div className="grid gap-5">
      {outline.generatedTitle || outline.mainIdea ? (
        <div className="rounded-md border border-stone-200 bg-stone-50 p-3 text-sm">
          {outline.generatedTitle ? (
            <p className="font-semibold text-stone-800">{outline.generatedTitle}</p>
          ) : null}
          <p className="mt-1 text-stone-600">{outline.mainIdea}</p>
        </div>
      ) : null}
      {outline.sections.map((section) => {
        const sectionClips = clips.filter((clip) => clip.sectionId === section.id).sort(bySectionScore);
        return (
          <section key={section.id}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-stone-800">
                <span className="text-teal-800">{sectionTypeLabel(section.type)}</span>
                {section.heading.toLowerCase() !== section.type.replace(/_/g, " ") ? (
                  <span> — {section.heading}</span>
                ) : null}
              </h3>
              <p className="text-xs text-stone-500">
                {sectionClips.length} {sectionClips.length === 1 ? "clip" : "clips"}
              </p>
            </div>
            {section.summary ? (
              <p className="mt-1 text-xs text-stone-500">{section.summary}</p>
            ) : null}
            <div className="mt-3 grid gap-3">
              {sectionClips.length === 0 ? (
                <p className="rounded-md border border-stone-200 bg-stone-50 p-3 text-sm text-stone-500">
                  No strong standalone clip was found in this section.
                </p>
              ) : (
                sectionClips.map((clip, index) => (
                  <ClipCard
                    key={clip.id}
                    clip={clip}
                    onLike={onLike}
                    headerLine={outlineHeaderLine(clip, index)}
                  />
                ))
              )}
            </div>
          </section>
        );
      })}
      {unsectioned.length > 0 ? (
        <section>
          <h3 className="text-sm font-semibold text-stone-800">Other moments</h3>
          <div className="mt-3 grid gap-3">
            {unsectioned.map((clip, index) => (
              <ClipCard
                key={clip.id}
                clip={clip}
                onLike={onLike}
                headerLine={outlineHeaderLine(clip, index)}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

export function ClipList({
  initialClips,
  outline = null,
}: {
  initialClips: Clip[];
  outline?: Outline | null;
}) {
  const [clips, setClips] = useState(initialClips);
  // Two views over the SAME clip records (no duplicates): the outline organizes the message,
  // the ranked list surfaces the strongest content fastest. Outline is the default.
  const [view, setView] = useState<"outline" | "ranked">(outline ? "outline" : "ranked");

  function handleLike(id: string, liked: boolean | null) {
    setClips((prev) => prev.map((clip) => (clip.id === id ? { ...clip, liked } : clip)));
  }

  if (clips.length === 0) {
    return (
      <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        No clips yet — they will appear once analysis finishes.
      </p>
    );
  }

  const ranked = [...clips].sort((a, b) => a.rank - b.rank);

  if (!outline) {
    return (
      <div className="grid gap-3">
        {ranked.map((clip) => (
          <ClipCard key={clip.id} clip={clip} onLike={handleLike} />
        ))}
      </div>
    );
  }

  const tabClass = (active: boolean) =>
    `rounded-md px-3 py-1.5 text-sm font-medium ${
      active ? "bg-teal-800 text-white" : "text-stone-600 hover:bg-stone-100"
    }`;

  return (
    <div>
      <div role="tablist" aria-label="Clip views" className="flex gap-1 border-b border-stone-200 pb-3">
        <button
          type="button"
          role="tab"
          aria-selected={view === "outline"}
          onClick={() => setView("outline")}
          className={tabClass(view === "outline")}
        >
          Sermon outline
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "ranked"}
          onClick={() => setView("ranked")}
          className={tabClass(view === "ranked")}
        >
          Ranked clips
        </button>
      </div>
      <div className="mt-4">
        {view === "outline" ? (
          <OutlineView outline={outline} clips={clips} onLike={handleLike} />
        ) : (
          <div className="grid gap-3">
            {ranked.map((clip) => (
              <ClipCard key={clip.id} clip={clip} onLike={handleLike} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
