"use client";

import { Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  CLIP_TITLE_MAX_CHARS,
  CLIP_TITLE_WORD_TARGET,
  countTitleWords,
  isTitleOverTarget,
} from "@/lib/editor/clip-title";

/**
 * The clip's own title, in the header, editable in place.
 *
 * At rest it is the page's heading, which is what a member reads and what every test looks for.
 * Pressing it opens a field over the same words: Enter or a blur saves, Escape puts back what was
 * there. The title belongs to the clip rather than to the edit document, so it is written straight
 * to the clip and never touches the editor's version history — renaming a clip is not an edit to
 * what the clip contains.
 *
 * Five words is a target, not a limit. The field says when a title has run past it and saves it
 * anyway; every clip generated before the rule has a longer one.
 */
export function ClipTitleField({
  clipId,
  title,
  onRenamed,
}: {
  clipId: string;
  title: string;
  onRenamed: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [failed, setFailed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  function open() {
    setDraft(title);
    setFailed(false);
    setEditing(true);
  }

  async function commit() {
    const next = draft.trim();
    setEditing(false);
    if (next === "" || next === title) return;

    // Optimistic: the header shows the new name at once, and puts the old one back if the write
    // is refused, rather than leaving a name the clip does not have.
    onRenamed(next);
    try {
      const response = await fetch(`/api/clips/${clipId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: next }),
      });
      if (!response.ok) throw new Error("refused");
    } catch {
      onRenamed(title);
      setFailed(true);
    }
  }

  if (!editing) {
    return (
      <div className="flex items-center gap-2">
        <h1 className="text-xl font-semibold">{title}</h1>
        <button
          type="button"
          aria-label="Rename this clip"
          title="Rename this clip"
          onClick={open}
          className="rounded-md p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700"
        >
          <Pencil size={14} aria-hidden="true" />
        </button>
        {failed ? (
          <span className="text-xs text-red-600">That rename didn&apos;t save — try again</span>
        ) : null}
      </div>
    );
  }

  const words = countTitleWords(draft);

  return (
    <div className="flex items-center gap-2">
      <input
        ref={inputRef}
        type="text"
        aria-label="Clip title"
        data-testid="clip-title-input"
        value={draft}
        maxLength={CLIP_TITLE_MAX_CHARS}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void commit();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setDraft(title);
            setEditing(false);
          }
        }}
        className="w-72 rounded-md border border-stone-300 px-2 py-1 text-xl font-semibold"
      />
      <span
        data-testid="clip-title-words"
        className={`text-xs ${isTitleOverTarget(draft) ? "text-amber-700" : "text-stone-500"}`}
      >
        {words} of {CLIP_TITLE_WORD_TARGET} words
      </span>
    </div>
  );
}
