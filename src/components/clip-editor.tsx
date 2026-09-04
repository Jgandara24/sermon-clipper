"use client";

import { ChevronLeft, Redo2, Undo2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AudioPanel } from "@/components/editor/audio-panel";
import { CaptionStylePanel } from "@/components/editor/caption-style-panel";
import {
  applyBrandTemplateToState,
  BrandTemplatePanel,
  type EditorBrandTemplate,
} from "@/components/editor/brand-template-panel";
import { ClipTimeline, type TimelineTrack } from "@/components/editor/clip-timeline";
import { EditorColumns } from "@/components/editor/editor-columns";
import { ExportPanel } from "@/components/editor/export-panel";
import { LayoutPanel } from "@/components/editor/layout-panel";
import { ScriptEditorPanel } from "@/components/editor/script-editor-panel";
import { TitlePanel } from "@/components/editor/title-panel";
import {
  type PreviewTransport,
  TransportControls,
} from "@/components/editor/transport-controls";
import {
  defaultTitleBanner,
  readTitleBanner,
  type TitleRange,
  upsertTitleBanner,
} from "@/lib/editor/title-banner";
import { VideoPreview } from "@/components/editor/video-preview";
import {
  applyConfirmedSave,
  canRedo,
  canUndo,
  closeInteraction,
  createHistory,
  historyShortcut,
  isTextEntryTarget,
  recordEdit,
  redo,
  undo,
} from "@/lib/editor/history";
import type { CanvasPoint } from "@/lib/editor/canvas";
import { MIN_CLIP_MS } from "@/lib/editor/trim";
import {
  type CommitMode,
  createSaveScheduler,
  type SaveOutcome,
  type SavePhase,
  type SaveScheduler,
} from "@/lib/editor/save-scheduler";
import {
  applyWordTextOverrides,
  restoreAllDeletedWords,
  setWordText,
  type EditorWordWithText,
} from "@/lib/editor/transcript";
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
  // History owns the working document: `history.present` is what the editor renders.
  const [history, setHistory] = useState(() => createHistory<EditorState>(initialState));
  const state = history.present;
  // The title, read once: both the track and the panel work from the same entry in overlays.
  const editorTitle = readTitleBanner(state.overlays);
  const [version, setVersion] = useState(initialVersion);
  const [savedState, setSavedState] = useState<EditorState>(initialState);
  const [savePhase, setSavePhase] = useState<SavePhase>("idle");
  const [showSafeZones, setShowSafeZones] = useState(false);
  const [publishReason, setPublishReason] = useState(publishBlockedReason);
  // Playback position (from the preview) and outgoing seek requests (from the trim timeline).
  const [currentMs, setCurrentMs] = useState(initialState.source.startMs);
  const [seek, setSeek] = useState<{ ms: number; token: number } | null>(null);
  // How much source the timeline shows around the clip. View state, like the canvas zoom: it
  // changes nothing that is saved and nothing the clip may start or end at.
  const [timelineZoom, setTimelineZoom] = useState(1);
  // Which row's settings are open. View state, never saved: the editor opens on Video, which
  // shows Captions — what every clip opened to before the rows existed.
  const [activeTrack, setActiveTrack] = useState<TimelineTrack>("video");
  // The transport above the tracks drives the preview through this; the preview reports back
  // whether it is playing so the button can say which comes next.
  const transportRef = useRef<PreviewTransport | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  // The word open for correction. Selection is view state, not document state: choosing a word
  // changes nothing that is saved, so it must never write a version.
  const [selectedWordId, setSelectedWordId] = useState<string | null>(null);
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
  // Where the speech is, for the Audio row: every word's start across the whole source, since the
  // timeline shows source on both sides of the clip.
  const wordStartsMs = useMemo(() => allWords.map((word) => word.startMs), [allWords]);
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
      //
      // It is an acknowledgement, not an edit: no history entry, and the redo stack survives.
      setSavedState(nextState);
      setHistory((current) => applyConfirmedSave(current, nextState));
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
      setHistory((current) => recordEdit(current, next, mode));
      scheduler.markDirty(next, mode);
    },
    [scheduler],
  );

  /**
   * Undo and redo are edits as far as persistence is concerned — the document changed, so it is
   * written — but they must not themselves become history entries, which is why they move the
   * stack directly instead of going through updateState.
   */
  const stepHistory = useCallback(
    (direction: "undo" | "redo") => {
      const next = direction === "undo" ? undo(history) : redo(history);
      if (next === history) return;
      stateRef.current = next.present;
      setHistory(next);
      // Persisting happens outside the state updater: React invokes updaters twice under Strict
      // Mode, and a write is not something to do twice.
      scheduler.markDirty(next.present, "immediate");
    },
    [history, scheduler],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const action = historyShortcut(event);
      if (!action) return;
      // A focused text field owns its own undo stack; reverting the whole document under the
      // user's cursor would be the wrong answer to Command+Z there.
      const target = event.target as HTMLElement | null;
      if (isTextEntryTarget(target ? { tagName: target.tagName, isContentEditable: target.isContentEditable } : null)) {
        return;
      }
      event.preventDefault();
      stepHistory(action);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [stepHistory]);

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

  /**
   * A gesture ended: write what is pending and close the history entry it built, so the next
   * gesture is a separate undo step.
   */
  const commitNow = useCallback(() => {
    scheduler.flush();
    setHistory(closeInteraction);
  }, [scheduler]);

  /**
   * Clicking a word puts the playhead exactly on it and opens it for correction. Neither half
   * touches the document, so a click alone never writes a version.
   */
  function handleSelectWord(word: EditorWordWithText) {
    // Moving to another word ends the correction in progress: it is written, and it stays its own
    // undo entry. Doing it here rather than waiting for the field's blur means it happens even
    // when the field is removed before the browser gets round to blurring it.
    if (selectedWordId !== null && selectedWordId !== word.id) commitNow();
    setSelectedWordId(word.id);
    requestSeek(word.startMs);
  }

  // A keystroke is mid-interaction: it updates the preview now and coalesces into one save and
  // one undo entry, the same way a slider drag does.
  function handleChangeWordText(word: EditorWordWithText, text: string) {
    updateState((prev) => setWordText(prev, word.id, text, word.originalWord), "idle");
  }

  /**
   * Enter or blur: write what is pending, close the undo entry, and put the caret away.
   *
   * Only the word that was being corrected is closed. A blur raised because the user clicked
   * straight onto another word arrives after that word is already selected, and clearing the
   * selection then would throw away the choice they just made.
   */
  const handleCommitWordText = useCallback(
    (wordId: string) => {
      setSelectedWordId((current) => (current === wordId ? null : current));
      commitNow();
    },
    [commitNow],
  );

  function handleRestoreAllWords() {
    updateState(restoreAllDeletedWords);
  }

  /**
   * A frame of a caption drag or corner-resize. `idle` is what makes the whole gesture one undo
   * entry and one coalesced save, exactly as a slider drag is — the preview still updates on this
   * call, with nothing between the pointer event and the render.
   */
  function handleCaptionMove(point: CanvasPoint) {
    updateState(
      (prev) => ({
        ...prev,
        captions: { ...prev.captions, overrides: { ...prev.captions.overrides, box: point } },
      }),
      "idle",
    );
  }

  function handleCaptionResize(sizePx: number) {
    updateState(
      (prev) => ({
        ...prev,
        captions: { ...prev.captions, overrides: { ...prev.captions.overrides, sizePx } },
      }),
      "idle",
    );
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

  /** A frame of a Title track drag: instant preview, one coalesced save, one undo entry. */
  function handleTitleRange(range: TitleRange) {
    if (!editorTitle) return;
    updateState(
      (prev) => ({
        ...prev,
        overlays: upsertTitleBanner(prev.overlays, { ...editorTitle, ...range }),
      }),
      "idle",
    );
  }

  /**
   * The empty Title row's offer was taken: the default title, written and committed at once, and
   * its settings opened so the next thing to do is right there.
   */
  function handleAddTitle() {
    updateState((prev) => ({
      ...prev,
      overlays: upsertTitleBanner(
        prev.overlays,
        defaultTitleBanner({ startMs: prev.source.startMs, endMs: prev.source.endMs }),
      ),
    }));
    commitNow();
    setActiveTrack("title");
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

  // Follows both trim handles: the range comes from the document, so contracting or extending the
  // clip re-derives the list rather than filtering a fixed one.
  const wordsInClip = useMemo(
    () =>
      applyWordTextOverrides(
        applyEditorDeletions(
          wordsInRange(allWords, state.source.startMs, state.source.endMs),
          state,
        ),
        state,
      ),
    [allWords, state],
  );

  // Excludes the embedded `version` field: it's bookkeeping the server stamps into the saved
  // copy, not user-meaningful content, and comparing it directly would show "unsaved changes"
  // forever after every save (the client's working copy never carries the new version number).
  const hasUnsavedChanges =
    JSON.stringify({ ...state, version: 0 }) !== JSON.stringify({ ...savedState, version: 0 });
  const undoAvailable = canUndo(history);
  const redoAvailable = canRedo(history);

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
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => stepHistory("undo")}
              disabled={!undoAvailable}
              aria-label="Undo"
              title="Undo (⌘Z / Ctrl+Z)"
              className="rounded-md border border-stone-300 p-2 text-stone-700 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Undo2 size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => stepHistory("redo")}
              disabled={!redoAvailable}
              aria-label="Redo"
              title="Redo (⇧⌘Z / Ctrl+Y)"
              className="rounded-md border border-stone-300 p-2 text-stone-700 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Redo2 size={16} aria-hidden="true" />
            </button>
          </div>
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

      <EditorColumns
        transcript={
          <>
            <ScriptEditorPanel
              words={wordsInClip}
              selectedWordId={selectedWordId}
              onSelectWord={handleSelectWord}
              onChangeWordText={handleChangeWordText}
              onCommitWordText={handleCommitWordText}
              onRestoreAllWords={handleRestoreAllWords}
              onExtendBefore={() => handleExtend("before")}
              onExtendAfter={() => handleExtend("after")}
              canExtendBefore={state.source.startMs > 0}
              canExtendAfter={state.source.endMs < sourceDurationMs}
            />
          </>
        }
        video={
          <div className="grid gap-3">
            <VideoPreview
              sourceVideoUrl={sourceVideoUrl}
              state={state}
              words={wordsInClip}
              showSafeZones={showSafeZones}
              brandTemplate={selectedBrandTemplate}
              onCurrentMsChange={setCurrentMs}
              onCaptionMove={handleCaptionMove}
              onCaptionResize={handleCaptionResize}
              // The gesture is over: write what is pending and close its undo entry.
              onCaptionCommit={commitNow}
              // Dragging a title is choosing where it goes, so it stops being anchored.
              onTitleMove={(box) =>
                editorTitle
                  ? updateState(
                      (prev) => ({
                        ...prev,
                        overlays: upsertTitleBanner(prev.overlays, {
                          ...editorTitle,
                          anchor: "custom",
                          box,
                        }),
                      }),
                      "idle",
                    )
                  : undefined
              }
              onTitleResize={(sizePx) =>
                editorTitle
                  ? updateState(
                      (prev) => ({
                        ...prev,
                        overlays: upsertTitleBanner(prev.overlays, { ...editorTitle, sizePx }),
                      }),
                      "idle",
                    )
                  : undefined
              }
              onTitleCommit={commitNow}
              seek={seek}
              transportRef={transportRef}
              onPlayingChange={setIsPlaying}
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
        }
        style={
          <div className="grid gap-4">
            {/* The selected row's settings. The plan names these three; every other panel stays. */}
            {activeTrack === "title" ? (
              <TitlePanel
                overlays={state.overlays}
                clip={{ startMs: state.source.startMs, endMs: state.source.endMs }}
                onChange={(overlays, mode) => updateState((prev) => ({ ...prev, overlays }), mode)}
                onCommit={commitNow}
              />
            ) : activeTrack === "audio" ? (
              <AudioPanel
                audio={state.audio}
                onChange={(audio, mode) => updateState((prev) => ({ ...prev, audio }), mode)}
                onCommit={commitNow}
              />
            ) : (
              <CaptionStylePanel
                captions={state.captions}
                onChange={(captions, mode) => updateState((prev) => ({ ...prev, captions }), mode)}
                onCommit={commitNow}
              />
            )}
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
        }
        timeline={
          <ClipTimeline
            sourceVideoUrl={sourceVideoUrl}
            sourceDurationMs={sourceDurationMs}
            startMs={state.source.startMs}
            endMs={state.source.endMs}
            currentMs={currentMs}
            wordBoundaries={wordBoundaries}
            wordStartsMs={wordStartsMs}
            audio={{ videoId: state.source.videoId }}
            title={{
              banner: editorTitle,
              onChange: handleTitleRange,
              onCommit: commitNow,
              onAdd: handleAddTitle,
            }}
            zoom={timelineZoom}
            onZoomChange={setTimelineZoom}
            activeTrack={activeTrack}
            onSelectTrack={setActiveTrack}
            transport={
              <TransportControls
                isPlaying={isPlaying}
                clip={{ startMs: state.source.startMs, endMs: state.source.endMs }}
                transportRef={transportRef}
              />
            }
            onTrim={handleTrim}
            onCommitTrim={commitNow}
            onScrub={requestSeek}
          />
        }
      />
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
