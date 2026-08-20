"use client";

import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaptionStylePanel } from "@/components/editor/caption-style-panel";
import {
  applyBrandTemplateToState,
  BrandTemplatePanel,
  type EditorBrandTemplate,
} from "@/components/editor/brand-template-panel";
import { ClipTimeline } from "@/components/editor/clip-timeline";
import { ExportPanel } from "@/components/editor/export-panel";
import { LayoutPanel } from "@/components/editor/layout-panel";
import { ScriptEditorPanel } from "@/components/editor/script-editor-panel";
import { VideoPreview } from "@/components/editor/video-preview";
import { MIN_CLIP_MS } from "@/lib/editor/trim";
import {
  type CommitMode,
  createSaveScheduler,
  type SaveOutcome,
  type SavePhase,
  type SaveScheduler,
} from "@/lib/editor/save-scheduler";
import type { EditorState } from "@/lib/editor/types";
import {
  applyEditorDeletions,
  flattenWords,
  wordsInRange,
  type TranscriptSegmentInput,
} from "@/lib/editor/words";

const EXTEND_STEP_MS = 15_000;

export function ClipEditor({
  clipId,
  clipTitle,
  sourceVideoUrl,
  sourceDurationMs,
  segments,
  initialVersion,
  initialState,
  brandTemplates,
  publishBlockedReason,
}: {
  clipId: string;
  clipTitle: string;
  sourceVideoUrl: string;
  sourceDurationMs: number;
  segments: TranscriptSegmentInput[];
  initialVersion: number;
  initialState: EditorState;
  brandTemplates: EditorBrandTemplate[];
  publishBlockedReason: string | null;
}) {
  const [state, setState] = useState<EditorState>(initialState);
  const [version, setVersion] = useState(initialVersion);
  const [savedState, setSavedState] = useState<EditorState>(initialState);
  const [savePhase, setSavePhase] = useState<SavePhase>("idle");
  const [showSafeZones, setShowSafeZones] = useState(false);
  const [publishReason, setPublishReason] = useState(publishBlockedReason);
  // Playback position (from the preview) and outgoing seek requests (from the trim timeline).
  const [currentMs, setCurrentMs] = useState(initialState.source.startMs);
  const [seek, setSeek] = useState<{ ms: number; token: number } | null>(null);
  const stateRef = useRef(initialState);

  const allWords = useMemo(() => flattenWords(segments), [segments]);
  // Snap targets for the trim handles: every word's start and end, de-duplicated and sorted.
  const wordBoundaries = useMemo(() => {
    const boundaries = new Set<number>();
    for (const word of allWords) {
      boundaries.add(word.startMs);
      boundaries.add(word.endMs);
    }
    return [...boundaries].sort((a, b) => a - b);
  }, [allWords]);
  const selectedBrandTemplate =
    brandTemplates.find((template) => template.id === state.brandTemplateId) ?? null;

  // Persistence only. Nothing here sits between an input and what the preview renders: the
  // preview draws from `state`, which every control updates on its own input event.
  const [scheduler] = useState<SaveScheduler<EditorState>>(() => {
    // The optimistic-concurrency base, owned by the scheduler. Only a confirmed, still-current
    // save advances it, so a superseded response can never move it backwards into a 409 loop.
    let baseVersion = initialVersion;
    const created = createSaveScheduler<EditorState>({
      save: async (doc) => {
        const result = await putEditState(clipId, baseVersion, doc);
        if (result.approvalBlockReason !== null) setPublishReason(result.approvalBlockReason);
        return result.outcome;
      },
      onPhase: setSavePhase,
    });
    created.onSaved(({ version: nextVersion, state: nextState, superseded }) => {
      // The version advances on every successful write, superseded or not: it describes the
      // backend's row, and the next save needs it as its base.
      baseVersion = Math.max(baseVersion, nextVersion);
      setVersion(nextVersion);
      if (superseded) return;

      // Still current, so the stored copy is what the user is looking at. Adopting it keeps the
      // local document identical to the backend's, which is what lets the status label trust its
      // own comparison. Nothing is pending here, so no edit in progress can be clobbered.
      setSavedState(nextState);
      setState(nextState);
    });
    return created;
  });

  /**
   * The preview updates from `setState` on this call — synchronously, with nothing between the
   * input event and the render. `mode` only tells the scheduler when to write: `immediate` for
   * an interaction's natural commit point (pointer release, Enter, blur, a discrete choice), and
   * `idle` for a keystroke or a mid-drag frame.
   */
  const updateState = useCallback(
    (updater: (prev: EditorState) => EditorState, mode: CommitMode = "immediate") => {
      const prev = stateRef.current;
      const next = updater(prev);
      if (next === prev) return;
      stateRef.current = next;
      setState(next);
      scheduler.markDirty(next, mode);
    },
    [scheduler],
  );

  // Mirrors the rendered document into the ref the event handlers read from, including the copy
  // adopted from a confirmed save.
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Strict Mode runs this cleanup once right after mounting, so the scheduler must be revivable:
  // a remount resumes it, and only a real unmount leaves it disposed.
  useEffect(() => {
    scheduler.resume();
    return () => scheduler.dispose();
  }, [scheduler]);

  function handleSaveNow() {
    scheduler.markDirty(stateRef.current, "immediate");
  }

  /** A gesture ended. Writes what is pending; sends nothing when nothing changed. */
  const commitNow = useCallback(() => scheduler.flush(), [scheduler]);

  function toggleWord(word: { id: string; isFiller: boolean }) {
    updateState((prev) => {
      const deleted = prev.wordEdits.deletedWordIds.includes(word.id);
      return {
        ...prev,
        wordEdits: {
          ...prev.wordEdits,
          deletedWordIds: deleted
            ? prev.wordEdits.deletedWordIds.filter((id) => id !== word.id)
            : [...prev.wordEdits.deletedWordIds, word.id],
        },
      };
    });
  }

  // Drag-to-trim writes the clip window directly; the timeline has already snapped and clamped,
  // so this just guards the minimum length and rejects no-op updates.
  function handleTrim(nextStartMs: number, nextEndMs: number) {
    if (nextEndMs - nextStartMs < MIN_CLIP_MS) return;
    updateState((prev) => {
      if (prev.source.startMs === nextStartMs && prev.source.endMs === nextEndMs) return prev;
      return { ...prev, source: { ...prev.source, startMs: nextStartMs, endMs: nextEndMs } };
    }, "idle");
  }

  function requestSeek(ms: number) {
    setSeek((prev) => ({ ms, token: (prev?.token ?? 0) + 1 }));
  }

  function handleExtend(direction: "before" | "after") {
    updateState((prev) => {
      const nextSource =
        direction === "before"
          ? { ...prev.source, startMs: Math.max(0, prev.source.startMs - EXTEND_STEP_MS) }
          : {
              ...prev.source,
              endMs: Math.min(sourceDurationMs, prev.source.endMs + EXTEND_STEP_MS),
            };

      const extension =
        direction === "before"
          ? { startMs: nextSource.startMs, endMs: prev.source.startMs, position: "before" as const }
          : { startMs: prev.source.endMs, endMs: nextSource.endMs, position: "after" as const };

      return { ...prev, source: nextSource, extensions: [...prev.extensions, extension] };
    });
  }

  const wordsInClip = useMemo(
    () => applyEditorDeletions(wordsInRange(allWords, state.source.startMs, state.source.endMs), state),
    [allWords, state],
  );

  // Excludes the embedded `version` field: it's bookkeeping the server stamps into the saved
  // copy, not user-meaningful content, and comparing it directly would show "unsaved changes"
  // forever after every save (the client's working copy never carries the new version number).
  const hasUnsavedChanges =
    JSON.stringify({ ...state, version: 0 }) !== JSON.stringify({ ...savedState, version: 0 });

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link href="../../.." className="text-stone-500 hover:text-stone-700">
            <ChevronLeft size={20} aria-hidden="true" />
          </Link>
          <div>
            <p className="text-sm font-medium text-teal-800">Editing</p>
            <h1 className="text-xl font-semibold">{clipTitle}</h1>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <SaveStatusLabel phase={savePhase} hasUnsavedChanges={hasUnsavedChanges} />
          <button
            type="button"
            onClick={handleSaveNow}
            disabled={savePhase === "saving"}
            className="rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>

      {savePhase === "conflict" ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          This clip changed elsewhere. Reload the page to see the latest edit before saving again.
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <div className="grid gap-3">
          <VideoPreview
            sourceVideoUrl={sourceVideoUrl}
            state={state}
            words={wordsInClip}
            showSafeZones={showSafeZones}
            brandTemplate={selectedBrandTemplate}
            onCurrentMsChange={setCurrentMs}
            seek={seek}
          />
          <label className="flex items-center gap-2 text-sm text-stone-600">
            <input
              type="checkbox"
              checked={showSafeZones}
              onChange={(event) => setShowSafeZones(event.target.checked)}
            />
            Show safe zones
          </label>
          <p className="text-xs text-stone-500">
            Version {version} · {hasUnsavedChanges ? "editing" : "saved"}. Preview approximates
            the final render — captions and layout are precise, playback trims are approximate.
          </p>
        </div>

        <div className="grid gap-4">
          <ClipTimeline
            sourceDurationMs={sourceDurationMs}
            startMs={state.source.startMs}
            endMs={state.source.endMs}
            currentMs={currentMs}
            wordBoundaries={wordBoundaries}
            onTrim={handleTrim}
            onCommitTrim={commitNow}
            onScrub={requestSeek}
          />
          <ScriptEditorPanel
            words={wordsInClip}
            onToggleWord={toggleWord}
            onExtendBefore={() => handleExtend("before")}
            onExtendAfter={() => handleExtend("after")}
            canExtendBefore={state.source.startMs > 0}
            canExtendAfter={state.source.endMs < sourceDurationMs}
          />
          <CaptionStylePanel
            captions={state.captions}
            onChange={(captions, mode) => updateState((prev) => ({ ...prev, captions }), mode)}
            onCommit={commitNow}
          />
          <BrandTemplatePanel
            templates={brandTemplates}
            selectedId={state.brandTemplateId}
            onApply={(template) =>
              updateState((prev) => applyBrandTemplateToState(prev, template))
            }
          />
          <LayoutPanel
            layout={state.layout}
            onChange={(layout, mode) => updateState((prev) => ({ ...prev, layout }), mode)}
            onCommit={commitNow}
          />
          <ExportPanel clipId={clipId} publishBlockedReason={publishReason} />
        </div>
      </div>
    </div>
  );
}

/**
 * One PUT of the editor document. Returns a scheduler outcome plus any approval consequence:
 * an editor save invalidates an existing approval, so publishing needs a fresh one. Export is
 * unaffected — the member can still download what they just edited.
 */
async function putEditState(
  clipId: string,
  baseVersion: number,
  next: EditorState,
): Promise<{ outcome: SaveOutcome<EditorState>; approvalBlockReason: string | null }> {
  try {
    const res = await fetch(`/api/clips/${clipId}/edit-state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseVersion, state: next, isAutosave: true }),
    });
    if (res.status === 409) return { outcome: { kind: "conflict" }, approvalBlockReason: null };

    const json = await res.json();
    if (!res.ok) return { outcome: { kind: "error" }, approvalBlockReason: null };

    return {
      outcome: { kind: "saved", version: json.data.version, state: json.data.state },
      approvalBlockReason: json.data.approvalState
        ? (json.data.approvalBlockReason ??
          "Send this clip for approval before publishing or scheduling it.")
        : null,
    };
  } catch {
    return { outcome: { kind: "error" }, approvalBlockReason: null };
  }
}

/**
 * `Saved` is the last thing this reports, never the first. It requires both a settled scheduler
 * and a local document identical to the one the backend confirmed, so a superseded response can
 * never leave the label claiming stale content is safe.
 */
function SaveStatusLabel({
  phase,
  hasUnsavedChanges,
}: {
  phase: SavePhase;
  hasUnsavedChanges: boolean;
}) {
  if (phase === "saving") return <span className="text-xs text-stone-500">Saving…</span>;
  if (phase === "error") {
    return <span className="text-xs text-red-600">Couldn&apos;t save — try again</span>;
  }
  if (phase === "conflict") return <span className="text-xs text-amber-700">Conflict — reload</span>;
  if (hasUnsavedChanges) return <span className="text-xs text-stone-500">Unsaved changes</span>;
  return <span className="text-xs text-emerald-700">Saved</span>;
}
