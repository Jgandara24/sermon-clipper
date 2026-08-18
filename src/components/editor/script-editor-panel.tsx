"use client";

import { Scissors } from "lucide-react";
import type { EditorWordWithDeletion } from "@/lib/editor/words";

export function ScriptEditorPanel({
  words,
  hasLegacyCuts,
  onRestoreDeletedWords,
  onExtendBefore,
  onExtendAfter,
  canExtendBefore,
  canExtendAfter,
}: {
  words: EditorWordWithDeletion[];
  hasLegacyCuts: boolean;
  onRestoreDeletedWords: () => void;
  onExtendBefore: () => void;
  onExtendAfter: () => void;
  canExtendBefore: boolean;
  canExtendAfter: boolean;
}) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Scissors size={18} className="text-teal-800" aria-hidden="true" />
          <h2 className="font-semibold">Script</h2>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onExtendBefore}
            disabled={!canExtendBefore}
            className="rounded-md border border-stone-300 px-2 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-40"
          >
            + Extend before
          </button>
          <button
            type="button"
            onClick={onExtendAfter}
            disabled={!canExtendAfter}
            className="rounded-md border border-stone-300 px-2 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-40"
          >
            + Extend after
          </button>
        </div>
      </div>
      <p className="mt-2 text-xs text-stone-500">
        Every spoken word inside the clip window is kept. Move the trim handles to change what the
        clip covers. Filler words are shown as chips for reference only.
      </p>
      {hasLegacyCuts ? (
        <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3">
          <p className="text-xs text-amber-900">
            This clip was made with an older editor that could delete words inside the clip. Exports
            now render one continuous range, so the deleted words must be restored before you can
            export.
          </p>
          <button
            type="button"
            onClick={onRestoreDeletedWords}
            className="mt-2 rounded-md border border-amber-400 bg-white px-2 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100"
          >
            Restore all deleted words
          </button>
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-1 leading-relaxed">
        {words.map((word) =>
          word.isFiller ? (
            <span
              key={word.id}
              title="Filler tag"
              className={`rounded-full border px-2 py-0.5 text-xs ${
                word.effectiveDeleted
                  ? "border-stone-300 bg-stone-100 text-stone-400 line-through"
                  : "border-amber-300 bg-amber-50 text-amber-800"
              }`}
            >
              {word.word}
            </span>
          ) : (
            <span
              key={word.id}
              className={`rounded px-1 text-sm ${
                word.effectiveDeleted ? "text-stone-300 line-through" : "text-stone-800"
              }`}
            >
              {word.word}
            </span>
          ),
        )}
        {words.length === 0 ? (
          <p className="text-sm text-stone-500">No transcript words in this range yet.</p>
        ) : null}
      </div>
    </div>
  );
}
