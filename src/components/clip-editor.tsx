"use client";

import {
  Captions,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Download,
  Eye,
  EyeOff,
  FileText,
  Frame,
  Palette,
  Redo2,
  Save as SaveIcon,
  Undo2,
} from "lucide-react";
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
import { VideoPreview, type CaptionPlacement } from "@/components/editor/video-preview";
import { convertToContinuous, hasInternalCuts } from "@/lib/editor/continuous-edit";
import {
  createDocumentHistory,
  updateDocumentHistory,
} from "@/lib/editor/document-history";
import { MIN_CLIP_MS } from "@/lib/editor/trim";
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
type InspectorTab = "captions" | "script" | "frame" | "brand" | "export";

export function ClipEditor({
  clipId,
  clipTitle,
  sourceVideoUrl,
  sourceDurationMs,
  segments,
  initialVersion,
  initialState,
  brandTemplates,
  canExport,
  exportBlockedReason,
}: {
  clipId: string;
  clipTitle: string;
  sourceVideoUrl: string;
  sourceDurationMs: number;
  segments: TranscriptSegmentInput[];
  initialVersion: number;
  initialState: EditorState;
  brandTemplates: EditorBrandTemplate[];
  canExport: boolean;
  exportBlockedReason: string | null;
}) {
  const [history, setHistory] = useState(() => createDocumentHistory(initialState));
  const state = history.present;
  const [version, setVersion] = useState(initialVersion);
  const [savedState, setSavedState] = useState<EditorState>(initialState);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [showSafeZones, setShowSafeZones] = useState(false);
  const [captionSelected, setCaptionSelected] = useState(true);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("captions");
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const [exportAllowed, setExportAllowed] = useState(canExport);
  const [exportReason, setExportReason] = useState(exportBlockedReason);
  // Playback position (from the preview) and outgoing seek requests (from the trim timeline).
  const [currentMs, setCurrentMs] = useState(initialState.source.startMs);
  const [seek, setSeek] = useState<{ ms: number; token: number } | null>(null);
  const stateRef = useRef(initialState);
  const clientRevisionRef = useRef(0);
  const versionRef = useRef(initialVersion);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyGroupRef = useRef<string | null>(null);
  const historyGroupSequenceRef = useRef(0);

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

  const save = useCallback(
    async (nextState: EditorState, isAutosave: boolean) => {
      setSaveStatus("saving");
      const revisionAtRequest = clientRevisionRef.current;
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
        if (clientRevisionRef.current === revisionAtRequest) {
          stateRef.current = json.data.state;
          setHistory((current) =>
            updateDocumentHistory(current, { type: "sync", document: json.data.state }),
          );
        }
        if (json.data.approvalState) {
          setExportAllowed(false);
          setExportReason(json.data.approvalBlockReason ?? "Send this clip for approval before exporting.");
        }
        setSaveStatus("saved");
      } catch {
        setSaveStatus("error");
      }
    },
    [clipId],
  );

  const queueAutosave = useCallback(
    (next: EditorState) => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = setTimeout(() => {
        save(next, true);
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    [save],
  );

  const updateState = useCallback(
    (updater: (prev: EditorState) => EditorState) => {
      setHistory((current) => {
        const next = updater(current.present);
        if (Object.is(next, current.present)) return current;
        clientRevisionRef.current += 1;
        stateRef.current = next;
        queueAutosave(next);
        return updateDocumentHistory(current, {
          type: "edit",
          document: next,
          group: historyGroupRef.current ?? undefined,
        });
      });
    },
    [queueAutosave],
  );

  const beginHistoryGroup = useCallback((kind: string) => {
    if (historyGroupRef.current) return;
    historyGroupSequenceRef.current += 1;
    historyGroupRef.current = `${kind}-${historyGroupSequenceRef.current}`;
  }, []);

  const endHistoryGroup = useCallback(() => {
    const group = historyGroupRef.current;
    if (!group) return;
    historyGroupRef.current = null;
    setHistory((current) => updateDocumentHistory(current, { type: "end-group", group }));
  }, []);

  const travelHistory = useCallback(
    (direction: "undo" | "redo") => {
      historyGroupRef.current = null;
      setHistory((current) => {
        const next = updateDocumentHistory(current, { type: direction });
        if (next === current) return current;
        clientRevisionRef.current += 1;
        stateRef.current = next.present;
        queueAutosave(next.present);
        return next;
      });
    },
    [queueAutosave],
  );

  useEffect(() => {
    const handleHistoryShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input:not([type="range"]), textarea, [contenteditable="true"]')) {
        return;
      }

      const key = event.key.toLowerCase();
      const direction =
        key === "z" && !event.shiftKey
          ? "undo"
          : (key === "z" && event.shiftKey) || key === "y"
            ? "redo"
            : null;
      if (!direction) return;
      event.preventDefault();
      travelHistory(direction);
    };

    window.addEventListener("keydown", handleHistoryShortcut);
    return () => window.removeEventListener("keydown", handleHistoryShortcut);
  }, [travelHistory]);

  useEffect(() => {
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, []);

  function handleSaveNow() {
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    save(stateRef.current, false);
  }

  function handleInspectorTab(nextTab: InspectorTab) {
    if (nextTab === inspectorTab && mobileInspectorOpen) {
      setMobileInspectorOpen(false);
      return;
    }
    setInspectorTab(nextTab);
    setMobileInspectorOpen(true);
  }

  // P1.4: the editor no longer creates internal word cuts. Legacy documents that carry them
  // convert back to one continuous range via an explicit, versioned edit.
  function handleRestoreAllWords() {
    updateState((prev) => convertToContinuous(prev));
  }

  // Drag-to-trim writes the clip window directly; the timeline has already snapped and clamped,
  // so this just guards the minimum length and rejects no-op updates.
  function handleTrim(nextStartMs: number, nextEndMs: number) {
    if (nextEndMs - nextStartMs < MIN_CLIP_MS) return;
    updateState((prev) => {
      if (prev.source.startMs === nextStartMs && prev.source.endMs === nextEndMs) return prev;
      return { ...prev, source: { ...prev.source, startMs: nextStartMs, endMs: nextEndMs } };
    });
  }

  function requestSeek(ms: number) {
    setSeek((prev) => ({ ms, token: (prev?.token ?? 0) + 1 }));
  }

  function handleCaptionPositionChange(placement: CaptionPlacement) {
    updateState((prev) => ({
      ...prev,
      captions: {
        ...prev.captions,
        overrides: {
          ...prev.captions.overrides,
          positionX: placement.positionX,
          positionY: placement.positionY,
          anchor: "center",
          safeAnchor: "custom",
        },
      },
    }));
  }

  function handleCaptionSizeChange(sizePx: number) {
    updateState((prev) => ({
      ...prev,
      captions: {
        ...prev.captions,
        overrides: { ...prev.captions.overrides, sizePx },
      },
    }));
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
    <div
      className="canvas-desk-editor grid min-h-0 min-w-0 overflow-hidden bg-black lg:-mx-8 lg:-my-6"
      data-mobile-sheet={mobileInspectorOpen ? "edit" : "compact"}
    >
      <header className="canvas-desk-header flex items-center justify-between gap-2 border-b border-white/10 bg-black px-2 text-white sm:px-3 lg:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="../../.."
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-stone-400 hover:bg-white/10 hover:text-white"
            aria-label="Back to clips"
          >
            <ChevronLeft size={20} aria-hidden="true" />
          </Link>
          <div className="min-w-0 max-w-[72px] sm:max-w-[220px] lg:max-w-none">
            <p className="hidden items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-stone-500 sm:flex">
              <span className="h-1.5 w-1.5 rounded-full bg-red-600" /> Editing
            </p>
            <h1 className="truncate text-sm font-semibold">{clipTitle}</h1>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 lg:gap-2">
          <span className="hidden sm:inline">
            <SaveStatusLabel status={saveStatus} hasUnsavedChanges={hasUnsavedChanges} dark />
          </span>
          <div className="flex items-center rounded-md border border-white/15" aria-label="Edit history">
            <button
              type="button"
              onClick={() => travelHistory("undo")}
              disabled={history.past.length === 0}
              className="flex h-10 w-9 items-center justify-center rounded-l-md text-stone-300 hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:text-stone-700 sm:w-10"
              aria-label="Undo"
              title="Undo (Command/Ctrl+Z)"
            >
              <Undo2 size={16} aria-hidden="true" />
            </button>
            <span className="h-5 w-px bg-white/10" aria-hidden="true" />
            <button
              type="button"
              onClick={() => travelHistory("redo")}
              disabled={history.future.length === 0}
              className="flex h-10 w-9 items-center justify-center rounded-r-md text-stone-300 hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:text-stone-700 sm:w-10"
              aria-label="Redo"
              title="Redo (Command/Ctrl+Shift+Z)"
            >
              <Redo2 size={16} aria-hidden="true" />
            </button>
          </div>
          <button
            type="button"
            onClick={() => setShowSafeZones((visible) => !visible)}
            className={`hidden h-10 w-10 items-center justify-center gap-2 rounded-md border text-xs font-semibold min-[360px]:inline-flex sm:w-auto sm:px-3 ${
              showSafeZones
                ? "border-red-500 bg-red-500/15 text-red-300"
                : "border-white/15 text-stone-300 hover:bg-white/10"
            }`}
            aria-label="Toggle safe area"
          >
            {showSafeZones ? <EyeOff size={15} /> : <Eye size={15} />}
            <span className="hidden sm:inline">Safe area</span>
          </button>
          <button
            type="button"
            onClick={handleSaveNow}
            disabled={saveStatus === "saving"}
            className="inline-flex h-10 w-10 items-center justify-center gap-2 rounded-md border border-white/15 text-xs font-semibold text-white hover:bg-white/10 disabled:opacity-50 sm:w-auto sm:px-4"
            aria-label="Save editor changes"
          >
            <SaveIcon size={15} aria-hidden="true" />
            <span className="hidden sm:inline">Save</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setInspectorTab("export");
              setMobileInspectorOpen(true);
            }}
            className="inline-flex h-10 w-10 items-center justify-center gap-2 rounded-md bg-red-600 text-xs font-bold text-white hover:bg-red-700 sm:w-auto sm:px-4"
            aria-label="Open export tools"
          >
            <Download size={15} aria-hidden="true" />
            <span className="hidden sm:inline">Export</span>
          </button>
        </div>
      </header>

      <main className="canvas-desk-stage relative flex min-h-0 items-center justify-center overflow-hidden bg-[#111111] p-2 sm:p-3 lg:p-5">
        {saveStatus === "conflict" ? (
          <p className="absolute left-4 right-4 top-4 z-20 rounded-md border border-amber-400/40 bg-amber-950/90 p-3 text-xs text-amber-100">
            This clip changed elsewhere. Reload the page before you save again.
          </p>
        ) : null}
        <div className="h-full max-h-full max-w-full">
          <VideoPreview
            sourceVideoUrl={sourceVideoUrl}
            state={state}
            words={wordsInClip}
            showSafeZones={showSafeZones}
            brandTemplate={selectedBrandTemplate}
            captionSelected={captionSelected}
            onCaptionSelectedChange={(selected) => {
              setCaptionSelected(selected);
              if (selected) setInspectorTab("captions");
            }}
            onCurrentMsChange={setCurrentMs}
            onCaptionPositionChange={handleCaptionPositionChange}
            onCaptionSizeChange={handleCaptionSizeChange}
            seek={seek}
            fillHeight
          />
        </div>
        <p className="absolute bottom-3 left-4 hidden rounded-md bg-black/70 px-2 py-1 text-[10px] text-stone-400 lg:block">
          Version {version} · captions and exported layout use the same coordinates
        </p>
      </main>

      <aside className="canvas-desk-inspector flex min-h-0 flex-col overflow-hidden border-t border-stone-200 bg-white text-stone-950 lg:border-l lg:border-t-0">
        <button
          type="button"
          onClick={() => setMobileInspectorOpen((open) => !open)}
          className="mobile-sheet-handle flex h-11 shrink-0 items-center justify-center gap-2 border-b border-stone-200 bg-white text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-500 lg:hidden"
          aria-expanded={mobileInspectorOpen}
          aria-controls="mobile-editor-tools"
        >
          <span className="h-1 w-10 rounded-full bg-stone-300" aria-hidden="true" />
          {mobileInspectorOpen ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
          {mobileInspectorOpen ? "Hide tools" : "Show tools"}
        </button>
        <nav className="grid grid-cols-5 border-b border-stone-200" aria-label="Editor tools">
          <InspectorTabButton icon={Captions} label="Captions" active={inspectorTab === "captions"} onClick={() => handleInspectorTab("captions")} />
          <InspectorTabButton icon={FileText} label="Script" active={inspectorTab === "script"} onClick={() => handleInspectorTab("script")} />
          <InspectorTabButton icon={Frame} label="Frame" active={inspectorTab === "frame"} onClick={() => handleInspectorTab("frame")} />
          <InspectorTabButton icon={Palette} label="Brand" active={inspectorTab === "brand"} onClick={() => handleInspectorTab("brand")} />
          <InspectorTabButton icon={Download} label="Export" active={inspectorTab === "export"} onClick={() => handleInspectorTab("export")} />
        </nav>
        <div id="mobile-editor-tools" className="mobile-sheet-content min-h-0 flex-1 overflow-y-auto bg-[#f7f7f7] p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] sm:p-3">
          {inspectorTab === "captions" ? (
            <CaptionStylePanel
              captions={state.captions}
              onChange={(captions) => updateState((prev) => ({ ...prev, captions }))}
              onInteractionStart={() => beginHistoryGroup("caption-style")}
              onInteractionEnd={endHistoryGroup}
            />
          ) : null}
          {inspectorTab === "script" ? (
            <ScriptEditorPanel
              words={wordsInClip}
              onExtendBefore={() => handleExtend("before")}
              onExtendAfter={() => handleExtend("after")}
              canExtendBefore={state.source.startMs > 0}
              canExtendAfter={state.source.endMs < sourceDurationMs}
              hasLegacyCuts={hasInternalCuts(state)}
              onRestoreAllWords={handleRestoreAllWords}
            />
          ) : null}
          {inspectorTab === "frame" ? (
            <LayoutPanel
              layout={state.layout}
              onChange={(layout) => updateState((prev) => ({ ...prev, layout }))}
              onInteractionStart={() => beginHistoryGroup("layout")}
              onInteractionEnd={endHistoryGroup}
            />
          ) : null}
          {inspectorTab === "brand" ? (
            <BrandTemplatePanel
              templates={brandTemplates}
              selectedId={state.brandTemplateId}
              onApply={(template) =>
                updateState((prev) => applyBrandTemplateToState(prev, template))
              }
            />
          ) : null}
          {inspectorTab === "export" ? (
            <ExportPanel
              clipId={clipId}
              canExport={exportAllowed}
              blockedReason={exportReason}
            />
          ) : null}
        </div>
      </aside>

      <div className="canvas-desk-timeline overflow-hidden border-t border-white/10 bg-[#181818]">
        <ClipTimeline
          sourceDurationMs={sourceDurationMs}
          startMs={state.source.startMs}
          endMs={state.source.endMs}
          currentMs={currentMs}
          wordBoundaries={wordBoundaries}
          onTrim={handleTrim}
          onScrub={requestSeek}
          onInteractionStart={() => beginHistoryGroup("trim")}
          onInteractionEnd={endHistoryGroup}
          compact
        />
      </div>
    </div>
  );
}

function InspectorTabButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: React.ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 border-b-2 px-1 py-2 text-[10px] font-semibold lg:min-h-0 lg:py-3 ${
        active
          ? "border-red-600 bg-red-50 text-red-700"
          : "border-transparent text-stone-500 hover:bg-stone-50 hover:text-stone-900"
      }`}
    >
      <Icon size={16} />
      <span className="truncate">{label}</span>
    </button>
  );
}

function SaveStatusLabel({
  status,
  hasUnsavedChanges,
  dark = false,
}: {
  status: SaveStatus;
  hasUnsavedChanges: boolean;
  dark?: boolean;
}) {
  if (status === "saving") return <span className={`text-xs ${dark ? "text-stone-400" : "text-stone-500"}`}>Saving…</span>;
  if (status === "error") {
    return <span className="text-xs text-red-600">Couldn&apos;t save — try again</span>;
  }
  if (status === "conflict") return <span className="text-xs text-amber-700">Conflict — reload</span>;
  if (hasUnsavedChanges) return <span className={`text-xs ${dark ? "text-stone-400" : "text-stone-500"}`}>Unsaved changes</span>;
  return <span className={`text-xs ${dark ? "text-stone-300" : "text-stone-700"}`}>Saved</span>;
}
