"use client";

import { Scissors } from "lucide-react";
import type { EditorWordWithDeletion } from "@/lib/editor/words";

/**
 * Read-only script view (P1.4): editing selects a continuous range via the trim timeline and
 * the extend buttons — clicking words no longer deletes them. Legacy deletions are shown
 * struck through until the owner converts the clip back to one continuous range.
 */
export function ScriptEditorPanel({
  words,
  onExtendBefore,
  onExtendAfter,
  canExtendBefore,
  canExtendAfter,
  hasLegacyCuts,
  onRestoreAllWords,
}: {
  words: EditorWordWithDeletion[];
  onExtendBefore: () => void;
  onExtendAfter: () => void;
  canExtendBefore: boolean;
  canExtendAfter: boolean;
  /** Legacy documents may still carry internal word cuts; export rejects them until converted. */
  hasLegacyCuts: boolean;
  onRestoreAllWords: () => void;
}) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Scissors size={18} className="text-red-700" aria-hidden="true" />
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

      {hasLegacyCuts ? (
        <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-3">
          <p className="text-xs text-amber-900">
            This clip has word deletions from an older editor. Exports need one continuous
            range — restore the deleted words to continue.
          </p>
          <button
            type="button"
            onClick={onRestoreAllWords}
            className="mt-2 rounded-md border border-amber-300 bg-white px-2 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100"
          >
            Restore all deleted words
          </button>
        </div>
      ) : (
        <p className="mt-2 text-xs text-stone-500">
          Use the trim handles or the extend buttons to choose what plays. The clip always keeps
          one continuous range of the sermon.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1 leading-relaxed">
        {words.map((word) => (
          <span
            key={word.id}
            className={`px-1 text-sm ${
              word.effectiveDeleted ? "text-stone-300 line-through" : "text-stone-800"
            }`}
          >
            {word.word}
          </span>
        ))}
        {words.length === 0 ? (
          <p className="text-sm text-stone-500">No transcript words in this range yet.</p>
        ) : null}
      </div>
    </div>
  );
}
