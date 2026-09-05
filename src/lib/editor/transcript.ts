// Pure transcript-editing math for the script panel (src/components/editor/script-editor-panel.tsx).
//
// A transcript correction fixes what the transcription heard. It is the only thing it does: the
// word keeps its id and its timestamps, the clip keeps its range, and nothing is cut. That
// separation is the point — a clip selects part of the sermon, it does not rewrite what was said
// (see the 2026-08-12 decision "Filler Tags Never Delete Spoken Words by Default").

import type { EditorState } from "./types";
import type { EditorWord, EditorWordWithDeletion } from "./words";

export type WordTextOverride = { wordId: string; text: string };

/**
 * The corrections a document carries. Documents written before Slice 5 have no array at all — the
 * editor page hands the stored JSON straight to the client without parsing it through the schema,
 * so the default the schema would apply is not there to rely on.
 */
export function wordTextOverrides(state: EditorState): WordTextOverride[] {
  return state.wordEdits.textOverrides ?? [];
}

/** A word as the transcript shows it: `word` is what it now says, `originalWord` what it said. */
export type EditorWordWithText = EditorWordWithDeletion & { originalWord: string };

/**
 * Shows each word's correction in place of the transcribed text, keeping the transcribed text
 * reachable so typing it back can drop the correction rather than store a no-op.
 */
export function applyWordTextOverrides<W extends EditorWord>(
  words: W[],
  state: EditorState,
): Array<W & { originalWord: string }> {
  const corrections = new Map(
    wordTextOverrides(state).map((override) => [override.wordId, override.text]),
  );
  return words.map((word) => ({
    ...word,
    originalWord: word.word,
    word: corrections.get(word.id) ?? word.word,
  }));
}

/** A word is one word: surrounding space is noise, and a paste can carry newlines and tabs. */
export function normalizeWordText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Corrects one word's text.
 *
 * Returns the *same* document — not an equal copy — whenever nothing changes, so the editor's
 * identity check keeps a no-op keystroke out of the undo stack and out of the save queue.
 *
 * Emptying the field is not a correction. The user is mid-retype, and an empty word would render
 * as a gap they never asked for, so the document keeps what it had while the field sits empty.
 */
export function setWordText(
  state: EditorState,
  wordId: string,
  text: string,
  originalText: string,
): EditorState {
  const next = normalizeWordText(text);
  if (next === "") return state;

  const current = wordTextOverrides(state);
  const existing = current.find((override) => override.wordId === wordId)?.text ?? null;
  // Typing the transcribed word back removes the correction instead of storing one that says
  // nothing, so an edited-then-reverted document is byte-identical to one never edited.
  const target = next === normalizeWordText(originalText) ? null : next;
  if (existing === target) return state;

  const textOverrides =
    target === null
      ? current.filter((override) => override.wordId !== wordId)
      : existing === null
        ? [...current, { wordId, text: target }]
        : // Replacing in place keeps the array's order stable, so re-editing one word does not
          // reshuffle the document and look like a change to everything after it.
          current.map((override) =>
            override.wordId === wordId ? { wordId, text: target } : override,
          );

  return { ...state, wordEdits: { ...state.wordEdits, textOverrides } };
}

/**
 * Clears the word cuts a document written before the continuous-range rule may still carry.
 *
 * Word deletion is no longer something the editor can create. A document that already has cuts
 * still renders them, so this is the one control that can put such a clip back on the continuous
 * range everything downstream now assumes. It is a versioned edit the user asks for, never a
 * background migration: word ids are positional, so a silent rewrite could repoint them.
 */
export function restoreAllDeletedWords(state: EditorState): EditorState {
  if (state.wordEdits.deletedWordIds.length === 0) return state;
  return { ...state, wordEdits: { ...state.wordEdits, deletedWordIds: [] } };
}
