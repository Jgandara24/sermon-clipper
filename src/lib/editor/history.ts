import type { CommitMode } from "./save-scheduler";

/**
 * Undo history for the editor document.
 *
 * The unit of history is an *interaction*, not a state change. A slider drag emits a frame per
 * pointer move and a typed field emits a keystroke per character; undoing those one frame at a
 * time would be useless. Slice 1 already named the boundary — `idle` edits are mid-interaction and
 * `immediate` edits are the interaction's own commit point — so history reuses it rather than
 * inventing a second notion of "one change".
 *
 * A save acknowledgement is deliberately not an edit. It adopts the document the backend stored,
 * which is a different fact about the same content, so it must not add an entry and must not throw
 * away a redo stack the user can still reach.
 */
export type EditorHistory<T> = {
  past: T[];
  present: T;
  future: T[];
  /** True while an interaction is still emitting frames, so its edits coalesce into one entry. */
  openInteraction: boolean;
};

export function createHistory<T>(present: T): EditorHistory<T> {
  return { past: [], present, future: [], openInteraction: false };
}

export function canUndo<T>(history: EditorHistory<T>): boolean {
  return history.past.length > 0;
}

export function canRedo<T>(history: EditorHistory<T>): boolean {
  return history.future.length > 0;
}

/**
 * Records a user edit.
 *
 * The first frame of an interaction pushes the pre-interaction document onto the stack; the frames
 * after it only move `present`, so the whole gesture collapses to a single entry. Any edit clears
 * the redo stack: once the user changes something after undoing, the branch they undid is gone.
 */
export function recordEdit<T>(
  history: EditorHistory<T>,
  next: T,
  mode: CommitMode,
): EditorHistory<T> {
  if (next === history.present) return history;

  // Only a mid-interaction frame joins the open entry. A discrete edit — clicking a different
  // control while a field still has focus — ends that interaction and starts its own entry, so
  // undo returns to the typed state rather than skipping past it.
  const continuesInteraction = history.openInteraction && mode === "idle";
  return {
    past: continuesInteraction ? history.past : [...history.past, history.present],
    present: next,
    future: [],
    openInteraction: mode === "idle",
  };
}

/**
 * Marks the end of an interaction: the next edit starts a new entry. Called from the same commit
 * points that trigger a write — pointer release, key release, Enter, blur.
 */
export function closeInteraction<T>(history: EditorHistory<T>): EditorHistory<T> {
  if (!history.openInteraction) return history;
  return { ...history, openInteraction: false };
}

export function undo<T>(history: EditorHistory<T>): EditorHistory<T> {
  if (!canUndo(history)) return history;
  const past = history.past.slice(0, -1);
  const previous = history.past[history.past.length - 1];
  return {
    past,
    present: previous,
    future: [history.present, ...history.future],
    // Undoing ends whatever gesture was in progress; the next edit is its own entry.
    openInteraction: false,
  };
}

export function redo<T>(history: EditorHistory<T>): EditorHistory<T> {
  if (!canRedo(history)) return history;
  const [next, ...future] = history.future;
  return {
    past: [...history.past, history.present],
    present: next,
    future,
    openInteraction: false,
  };
}

/**
 * Adopts the copy the backend confirmed. Not an edit: no entry, no redo loss, and no effect on an
 * interaction the user is still in the middle of.
 */
export function applyConfirmedSave<T>(history: EditorHistory<T>, confirmed: T): EditorHistory<T> {
  return { ...history, present: confirmed };
}

/** The subset of a keyboard event this needs, so the mapping is testable without a DOM. */
export type ShortcutEvent = { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean };

/**
 * Command+Z / Command+Shift+Z on macOS, Control+Z / Control+Y on Windows, and Control+Shift+Z,
 * which Windows and Linux applications commonly accept for redo as well.
 */
export function historyShortcut(event: ShortcutEvent): "undo" | "redo" | null {
  const key = event.key.toLowerCase();
  const modifier = event.metaKey || event.ctrlKey;
  if (!modifier) return null;

  if (key === "z") return event.shiftKey ? "redo" : "undo";
  // Control+Y is the Windows redo. Command+Y is not a macOS redo, so it stays unclaimed.
  if (key === "y" && event.ctrlKey && !event.metaKey) return "redo";
  return null;
}

/**
 * A text field has its own undo stack. Hijacking the shortcut inside one would revert the whole
 * document while the user was only trying to undo their own typing.
 */
export function isTextEntryTarget(
  target: { tagName: string; isContentEditable: boolean } | null,
): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}
