"use client";

import { Scissors } from "lucide-react";
import { useEffect, useRef } from "react";
import type { EditorWordWithText } from "@/lib/editor/transcript";

/**
 * The transcript. Clicking a word puts the playhead on it and opens that word for correction in
 * place — there is no floating tool box, because the word itself is the control.
 *
 * Nothing here can shorten the clip. Trimming is the timeline's job, and a correction changes what
 * a word says without touching its id, its timestamps, or the clip's range.
 */
export function ScriptEditorPanel({
  words,
  selectedWordId,
  onSelectWord,
  onChangeWordText,
  onCommitWordText,
  onRestoreAllWords,
  onExtendBefore,
  onExtendAfter,
  canExtendBefore,
  canExtendAfter,
}: {
  words: EditorWordWithText[];
  selectedWordId: string | null;
  onSelectWord: (word: EditorWordWithText) => void;
  onChangeWordText: (word: EditorWordWithText, text: string) => void;
  onCommitWordText: (wordId: string) => void;
  onRestoreAllWords: () => void;
  onExtendBefore: () => void;
  onExtendAfter: () => void;
  canExtendBefore: boolean;
  canExtendAfter: boolean;
}) {
  const deletedCount = words.filter((word) => word.effectiveDeleted).length;

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
        Click a word to jump to it and correct what it says. Press Enter to finish. Correcting a
        word changes the captions only — the clip stays one continuous range, trimmed on the
        timeline above.
      </p>

      {deletedCount > 0 ? (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3">
          <p className="text-xs text-amber-900">
            This clip was edited when the editor could cut words out of the middle. Those{" "}
            {deletedCount === 1 ? "cut is" : `${deletedCount} cuts are`} still in the exported
            video.
          </p>
          <button
            type="button"
            onClick={onRestoreAllWords}
            className="mt-2 rounded-md border border-amber-400 px-2 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100"
          >
            Restore all deleted words
          </button>
        </div>
      ) : null}

      <div
        data-testid="transcript"
        className="mt-3 flex flex-wrap items-center gap-1 leading-relaxed"
      >
        {words.map((word) => {
          if (word.effectiveDeleted) {
            // A cut this editor can no longer make. It stays visible so the clip reads honestly,
            // and "Restore all deleted words" above is the way back.
            return (
              <span key={word.id} className="rounded px-1 text-sm text-stone-300 line-through">
                {word.word}
              </span>
            );
          }

          if (word.id === selectedWordId) {
            return (
              <EditableWord
                key={word.id}
                word={word}
                onChange={(text) => onChangeWordText(word, text)}
                onCommit={() => onCommitWordText(word.id)}
              />
            );
          }

          return (
            <button
              key={word.id}
              type="button"
              // Pointer-down, not click: choosing this word removes the field open on another
              // one, and the words after it shift as the row reflows. By the time a click
              // resolves, the pointer is over a different word than the one that was aimed at.
              //
              // The press must not also move focus. Its default target is this button, which the
              // field replaces mid-press; focus would land on nothing and blur the field the
              // moment it focused itself, closing the correction before it could be typed.
              onPointerDown={(event) => {
                event.preventDefault();
                onSelectWord(word);
              }}
              onMouseDown={(event) => event.preventDefault()}
              // Enter or Space from the keyboard raises no pointer event, so selection still needs
              // a click handler. A mouse press has already removed this button by now.
              onClick={() => onSelectWord(word)}
              title={
                word.isFiller
                  ? "Filler tag — click to jump here and correct it"
                  : "Click to jump here and correct this word"
              }
              className={
                word.isFiller
                  ? "rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-800 hover:bg-amber-100"
                  : "rounded px-1 text-sm text-stone-800 hover:bg-teal-50"
              }
            >
              {word.word}
            </button>
          );
        })}
        {words.length === 0 ? (
          <p className="text-sm text-stone-500">No transcript words in this range yet.</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One word open for correction.
 *
 * The field is uncontrolled on purpose. The document refuses an empty word — an empty caption is a
 * gap nobody asked for — so a controlled field would snap the old word back the moment the user
 * cleared it to retype. Letting the DOM hold the in-progress text and the document hold the last
 * good one keeps clear-and-retype working while the preview never renders a blank.
 */
function EditableWord({
  word,
  onChange,
  onCommit,
}: {
  word: EditorWordWithText;
  onChange: (text: string) => void;
  onCommit: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter both commits and closes the field, and closing it can raise a blur. Committing twice
  // would write the same correction as two versions, so the first commit wins and the rest are
  // ignored. One field is one correction.
  const committedRef = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // Selecting the word means typing replaces it, which is what correcting a word usually is.
    input.select();
  }, []);

  function commitOnce() {
    if (committedRef.current) return;
    committedRef.current = true;
    onCommit();
  }

  return (
    <input
      ref={inputRef}
      type="text"
      defaultValue={word.word}
      // Grows with the committed text, which advances on every accepted keystroke.
      size={Math.max(3, word.word.length)}
      aria-label={`Correct the word ${word.originalWord}`}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        // Enter is this field's commit point, not a form submission.
        event.preventDefault();
        commitOnce();
      }}
      onBlur={commitOnce}
      className="rounded border border-teal-600 bg-white px-1 text-sm text-stone-900 outline-none ring-2 ring-teal-200"
    />
  );
}
