// P1.4's delivery gate: an editor document that still cuts words out of the middle of a clip must
// not render a shortened video.
//
// The editor can no longer create such a cut — the word-delete control is gone (see the 2026-08-20
// decision "A Transcript Correction Changes What A Word Says, Never What The Clip Contains"). What
// remains is documents written when it could. Those still exist, they still render their cuts, and
// the 2026-08-12 entry "Filler Tags Never Delete Spoken Words by Default" left exactly this open:
// "P1 must block those edits from delivery before the continuous-source invariant is fully
// enforced." This is that block.
//
// It refuses; it never repairs. Restoring the words is a versioned edit the user asks for, because
// word ids are positional and a silent rewrite could repoint them at different words.

import type { PrismaClient } from "@prisma/client";
import type { EditorState } from "@/lib/editor/types";
import {
  applyEditorDeletions,
  flattenWords,
  wordsInRange,
  type TranscriptSegmentInput,
} from "@/lib/editor/words";
import { computeKeptRanges } from "@/lib/export/kept-ranges";
import { ExportFailureError } from "./errors";

/** The clip would render as several pieces spliced together rather than one unbroken span. */
export const CONTINUOUS_RANGE_REQUIRED = "CONTINUOUS_RANGE_REQUIRED";

export const CONTINUOUS_RANGE_MESSAGE =
  "This clip still has words cut out of the middle, so exporting it would deliver a shortened " +
  'video. Open the editor and choose "Restore all deleted words", then export again.';

/**
 * The cuts a document declares. Read defensively: documents predate several shapes of this field,
 * and a reader that throws on an old one turns a refusal into a crash.
 */
function declaredCutIds(state: EditorState | null | undefined): string[] {
  const ids = state?.wordEdits?.deletedWordIds;
  return Array.isArray(ids) ? ids : [];
}

/** The words this clip's own range would actually cut out at render time. */
export function clipCutWordIds(
  state: EditorState,
  segments: TranscriptSegmentInput[],
): string[] {
  return applyEditorDeletions(
    wordsInRange(flattenWords(segments), state.source.startMs, state.source.endMs),
    state,
  )
    .filter((word) => word.effectiveDeleted)
    .map((word) => word.id);
}

/**
 * True when the render would be one unbroken span of the source.
 *
 * Decided against the kept ranges the renderer itself derives, not against the presence of a
 * deleted id: a cut outside the clip's range removes nothing, and refusing that export would be a
 * refusal the user could do nothing about.
 */
export function rendersContinuousRange(
  state: EditorState,
  segments: TranscriptSegmentInput[],
): boolean {
  if (declaredCutIds(state).length === 0) return true;

  const words = applyEditorDeletions(
    wordsInRange(flattenWords(segments), state.source.startMs, state.source.endMs),
    state,
  );
  const kept = computeKeptRanges(words, state.source.startMs, state.source.endMs);
  return (
    kept.length === 1 &&
    kept[0].startMs === state.source.startMs &&
    kept[0].endMs === state.source.endMs
  );
}

/**
 * The delivery gate. Terminal, because re-running the same job against the same pinned document
 * would reach the same answer — only a new, user-made edit can change it.
 */
export function assertContinuousRange(
  state: EditorState,
  segments: TranscriptSegmentInput[],
): void {
  if (rendersContinuousRange(state, segments)) return;
  throw new ExportFailureError(CONTINUOUS_RANGE_REQUIRED, CONTINUOUS_RANGE_MESSAGE, {
    terminal: true,
  });
}

/**
 * The same question asked from the request path, where the transcript is not already loaded.
 *
 * A document with nothing deleted cannot be cut, so the overwhelmingly common case answers without
 * touching the database. This is convenience, not the guarantee: the worker checks the pinned
 * document again, and that check is what actually protects delivery.
 */
export async function clipRendersContinuousRange(
  client: Pick<PrismaClient, "transcriptSegment">,
  params: { sourceVideoId: string; state: EditorState | null | undefined },
): Promise<boolean> {
  if (declaredCutIds(params.state).length === 0) return true;

  const rows = await client.transcriptSegment.findMany({
    where: { transcript: { sourceVideoId: params.sourceVideoId } },
    orderBy: { idx: "asc" },
  });

  const segments: TranscriptSegmentInput[] = rows.map((row) => ({
    id: row.id,
    startMs: row.startMs,
    endMs: row.endMs,
    words: row.words as TranscriptSegmentInput["words"],
  }));

  return rendersContinuousRange(params.state as EditorState, segments);
}
