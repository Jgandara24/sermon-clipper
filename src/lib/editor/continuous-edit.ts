import type { EditorState } from "./types";

/**
 * P1.4 (agentic editor plan): editing selects a continuous range of the sermon — it does not
 * rewrite what was said. New edits can no longer create internal word cuts; legacy documents
 * that still carry them stay readable but must be explicitly converted before export (P1.5
 * rejects them with CONTINUOUS_RANGE_REQUIRED).
 */

/** True when a legacy editor state still carries internal word cuts. */
export function hasInternalCuts(state: EditorState): boolean {
  return state.wordEdits.deletedWordIds.length > 0;
}

/**
 * Clears every internal cut, restoring the clip to one continuous range. The caller saves the
 * result as a new ClipEdit version — conversion is an explicit, versioned edit, never an
 * implicit migration.
 */
export function convertToContinuous(state: EditorState): EditorState {
  if (!hasInternalCuts(state) && state.wordEdits.restoredFillerIds.length === 0) return state;
  return { ...state, wordEdits: { deletedWordIds: [], restoredFillerIds: [] } };
}
