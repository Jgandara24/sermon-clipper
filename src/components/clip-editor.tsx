"use client";

import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaptionStylePanel } from "@/components/editor/caption-style-panel";
import { ExportPanel } from "@/components/editor/export-panel";
import { LayoutPanel } from "@/components/editor/layout-panel";
import { ScriptEditorPanel } from "@/components/editor/script-editor-panel";
import { VideoPreview } from "@/components/editor/video-preview";
import type { EditorState } from "@/lib/editor/types";
import {
  applyEditorDeletions,
  flattenWords,
  wordsInRange,
  type TranscriptSegmentInput,
} from "@/lib/editor/words";

const AUTOSAVE_DEBOUNCE_MS = 2000;
const EXTEND_STEP_MS = 15_000;

type SaveStatus = "idle" | "saving" | "saved" | "error" | "conflict";

export function ClipEditor({
  clipId,
  clipTitle,
  sourceVideoId,
  sourceDurationMs,
  segments,
  initialVersion,
  initialState,
}: {
  clipId: string;
  clipTitle: string;
  sourceVideoId: string;
  sourceDurationMs: number;
  segments: TranscriptSegmentInput[];
  initialVersion: number;
  initialState: EditorState;
}) {
  const [state, setState] = useState<EditorState>(initialState);
  const [version, setVersion] = useState(initialVersion);
  const [savedState, setSavedState] = useState<EditorState>(initialState);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [showSafeZones, setShowSafeZones] = useState(false);
  const versionRef = useRef(initialVersion);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const allWords = useMemo(() => flattenWords(segments), [segments]);

  const save = useCallback(
    async (nextState: EditorState, isAutosave: boolean) => {
      setSaveStatus("saving");
      try {
        const res = await fetch(`/api/clips/${clipId}/edit-state`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ baseVersion: versionRef.current, state: nextState, isAutosave }),
        });
        if (res.status === 409) {
          setSaveStatus("conflict");
          return;
        }
        const json = await res.json();
        if (!res.ok) {
          setSaveStatus("error");
          return;
        }
        versionRef.current = json.data.version;
        setVersion(json.data.version);
        setSavedState(json.data.state);
        setSaveStatus("saved");
      } catch {
        setSaveStatus("error");
      }
    },
    [clipId],
  );

  const updateState = useCallback(
    (updater: (prev: EditorState) => EditorState) => {
      setState((prev) => {
        const next = updater(prev);
        if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = setTimeout(() => {
          save(next, true);
        }, AUTOSAVE_DEBOUNCE_MS);
        return next;
      });
    },
    [save],
  );

  useEffect(() => {
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, []);

  function handleSaveNow() {
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    save(state, false);
  }

  function toggleWord(word: { id: string; isFiller: boolean }) {
    updateState((prev) => {
      if (word.isFiller) {
        const restored = prev.wordEdits.restoredFillerIds.includes(word.id);
        return {
          ...prev,
          wordEdits: {
            ...prev.wordEdits,
            restoredFillerIds: restored
              ? prev.wordEdits.restoredFillerIds.filter((id) => id !== word.id)
              : [...prev.wordEdits.restoredFillerIds, word.id],
          },
        };
      }
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
          <SaveStatusLabel status={saveStatus} hasUnsavedChanges={hasUnsavedChanges} />
          <button
            type="button"
            onClick={handleSaveNow}
            disabled={saveStatus === "saving"}
            className="rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>

      {saveStatus === "conflict" ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          This clip changed elsewhere. Reload the page to see the latest edit before saving again.
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <div className="grid gap-3">
          <VideoPreview
            sourceVideoId={sourceVideoId}
            state={state}
            words={wordsInClip}
            showSafeZones={showSafeZones}
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
            onChange={(captions) => updateState((prev) => ({ ...prev, captions }))}
          />
          <LayoutPanel
            layout={state.layout}
            onChange={(layout) => updateState((prev) => ({ ...prev, layout }))}
          />
          <ExportPanel clipId={clipId} />
        </div>
      </div>
    </div>
  );
}

function SaveStatusLabel({
  status,
  hasUnsavedChanges,
}: {
  status: SaveStatus;
  hasUnsavedChanges: boolean;
}) {
  if (status === "saving") return <span className="text-xs text-stone-500">Saving…</span>;
  if (status === "error") {
    return <span className="text-xs text-red-600">Couldn&apos;t save — try again</span>;
  }
  if (status === "conflict") return <span className="text-xs text-amber-700">Conflict — reload</span>;
  if (hasUnsavedChanges) return <span className="text-xs text-stone-500">Unsaved changes</span>;
  return <span className="text-xs text-emerald-700">Saved</span>;
}
