"use client";

import { Captions, Clock3, Flag, FlagTriangleRight, Scissors, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { EditorWordWithDeletion } from "@/lib/editor/words";

function formatRelativeTime(ms: number): string {
  const totalSeconds = Math.max(0, ms) / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

/** Opus-style transcript workspace: word selection is an edit target, playback is ephemeral. */
export function ScriptEditorPanel({
  words,
  clipStartMs,
  activeWordId,
  selectedWordId,
  onWordSelect,
  onWordTextChange,
  onSelectionClear,
  onOpenCaptions,
  onSetClipStart,
  onSetClipEnd,
  onExtendBefore,
  onExtendAfter,
  canExtendBefore,
  canExtendAfter,
  hasLegacyCuts,
  onRestoreAllWords,
  dark = false,
  hideExtensionControls = false,
  hideSelectionTools = false,
}: {
  words: EditorWordWithDeletion[];
  clipStartMs: number;
  activeWordId: string | null;
  selectedWordId: string | null;
  onWordSelect: (wordId: string) => void;
  onWordTextChange: (wordId: string, text: string) => void;
  onSelectionClear: () => void;
  onOpenCaptions: () => void;
  onSetClipStart: (word: EditorWordWithDeletion) => void;
  onSetClipEnd: (word: EditorWordWithDeletion) => void;
  onExtendBefore: () => void;
  onExtendAfter: () => void;
  canExtendBefore: boolean;
  canExtendAfter: boolean;
  hasLegacyCuts: boolean;
  onRestoreAllWords: () => void;
  dark?: boolean;
  hideExtensionControls?: boolean;
  hideSelectionTools?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const selectedWord = words.find((word) => word.id === selectedWordId) ?? null;

  useEffect(() => {
    const revealId = selectedWordId ?? activeWordId;
    if (!revealId) return;
    const target = scrollRef.current?.querySelector<HTMLElement>(
      `[data-transcript-word-id="${revealId}"]`,
    );
    target?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeWordId, selectedWordId]);

  const shell = dark
    ? "flex h-full min-h-0 flex-col bg-[#090909] text-white"
    : "flex min-h-0 flex-col rounded-lg border border-stone-200 bg-white text-stone-950 shadow-sm";

  return (
    <section className={shell} aria-label="Transcript workspace">
      <div className={`shrink-0 border-b px-4 py-3 ${dark ? "border-white/10" : "border-stone-200"}`}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className={`text-[10px] font-bold uppercase tracking-[0.2em] ${dark ? "text-red-500" : "text-red-700"}`}>
              Transcript
            </p>
            <p className={`mt-1 text-xs ${dark ? "text-stone-500" : "text-stone-500"}`}>
              Select any word to seek and edit.
            </p>
          </div>
          {!hideExtensionControls ? <div className="flex gap-1">
            <button
              type="button"
              onClick={onExtendBefore}
              disabled={!canExtendBefore}
              className={`rounded-md border px-2 py-1 text-[11px] font-semibold disabled:opacity-30 ${dark ? "border-white/15 text-stone-300 hover:border-white/30 hover:bg-white/5" : "border-stone-300 text-stone-700 hover:bg-stone-50"}`}
            >
              + Before
            </button>
            <button
              type="button"
              onClick={onExtendAfter}
              disabled={!canExtendAfter}
              className={`rounded-md border px-2 py-1 text-[11px] font-semibold disabled:opacity-30 ${dark ? "border-white/15 text-stone-300 hover:border-white/30 hover:bg-white/5" : "border-stone-300 text-stone-700 hover:bg-stone-50"}`}
            >
              + After
            </button>
          </div> : null}
        </div>
      </div>

      {selectedWord && !hideSelectionTools ? (
        <div className={`shrink-0 border-b p-2 ${dark ? "border-white/10 bg-[#111111]" : "border-stone-200 bg-stone-50"}`}>
          <div className={`flex flex-wrap items-center gap-1 rounded-lg border p-1.5 shadow-xl ${dark ? "border-white/10 bg-[#242424]" : "border-stone-200 bg-white"}`}>
            <span className="rounded-md bg-red-600 px-2 py-1.5 text-xs font-bold text-white">
              {selectedWord.word}
            </span>
            <button type="button" onClick={onOpenCaptions} className="transcript-tool-button">
              <Captions size={14} aria-hidden="true" /> Captions
            </button>
            <button type="button" onClick={() => onSetClipStart(selectedWord)} className="transcript-tool-button">
              <Flag size={14} aria-hidden="true" /> Set start
            </button>
            <button type="button" onClick={() => onSetClipEnd(selectedWord)} className="transcript-tool-button">
              <FlagTriangleRight size={14} aria-hidden="true" /> Set end
            </button>
            <span className="inline-flex items-center gap-1 px-2 py-1.5 text-[11px] tabular-nums text-stone-400" title="Exact word timestamp">
              <Clock3 size={13} aria-hidden="true" />
              Timing {formatRelativeTime(selectedWord.startMs - clipStartMs)}
            </span>
            <button type="button" onClick={onSelectionClear} className="ml-auto rounded-md p-1.5 text-stone-400 hover:bg-white/10 hover:text-white" aria-label="Close word tools">
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : null}

      {hasLegacyCuts ? (
        <div className="m-3 shrink-0 rounded-md border border-amber-400/30 bg-amber-500/10 p-3">
          <p className="text-xs text-amber-200">This clip has old internal word cuts.</p>
          <button type="button" onClick={onRestoreAllWords} className="mt-2 rounded-md border border-amber-400/40 px-2 py-1 text-xs font-medium text-amber-100 hover:bg-amber-400/10">
            Restore all words
          </button>
        </div>
      ) : null}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="text-[15px] leading-[2.05] text-stone-300">
          {words.map((word, index) => {
            const active = word.id === activeWordId;
            const selected = word.id === selectedWordId;
            const relativeMs = word.startMs - clipStartMs;
            const previousRelativeMs = index > 0 ? words[index - 1].startMs - clipStartMs : -8000;
            const showTimestamp = index === 0 || Math.floor(relativeMs / 8000) > Math.floor(previousRelativeMs / 8000);
            return (
              <span key={word.id} className="inline">
                {showTimestamp ? (
                  <span className="mr-1 inline-flex rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-stone-500">
                    {formatRelativeTime(relativeMs)}
                  </span>
                ) : null}
                {selected && hideSelectionTools ? (
                  <EditableTranscriptWord
                    key={word.word}
                    word={word}
                    onCommit={(text) => onWordTextChange(word.id, text)}
                  />
                ) : (
                  <button
                    type="button"
                    data-transcript-word-id={word.id}
                    aria-pressed={selected}
                    onClick={() => onWordSelect(word.id)}
                    className={`mx-0.5 rounded px-0.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 ${
                      word.effectiveDeleted
                        ? "text-stone-600 line-through"
                        : selected
                          ? "bg-red-600 text-white"
                          : active
                            ? "bg-red-500/20 text-red-300"
                            : dark
                              ? "text-stone-300 hover:bg-white/10 hover:text-white"
                              : "text-stone-800 hover:bg-red-50 hover:text-red-800"
                    }`}
                  >
                    {word.word}
                  </button>
                )}{" "}
              </span>
            );
          })}
          {words.length === 0 ? (
            <p className="text-sm text-stone-500">No transcript words are in this range.</p>
          ) : null}
        </div>
      </div>

      <div className={`shrink-0 border-t px-4 py-2 text-[10px] ${dark ? "border-white/10 text-stone-600" : "border-stone-200 text-stone-400"}`}>
        <span className="inline-flex items-center gap-1"><Scissors size={11} aria-hidden="true" /> Word clicks do not cut the sermon.</span>
      </div>
    </section>
  );
}

function EditableTranscriptWord({
  word,
  onCommit,
}: {
  word: EditorWordWithDeletion;
  onCommit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(word.word);
  const cancelRef = useRef(false);

  return (
    <input
      autoFocus
      data-transcript-word-id={word.id}
      value={draft}
      maxLength={120}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (cancelRef.current) {
          cancelRef.current = false;
          return;
        }
        onCommit(draft);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          cancelRef.current = true;
          setDraft(word.word);
          event.currentTarget.blur();
        }
      }}
      aria-label={`Edit transcript word ${word.word}`}
      className="mx-0.5 rounded bg-red-600 px-1 py-0.5 text-left text-white outline-none ring-2 ring-red-400"
      style={{ width: `${Math.max(3, draft.length + 1)}ch` }}
    />
  );
}
