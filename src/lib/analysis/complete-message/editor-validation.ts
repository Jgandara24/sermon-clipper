import { MIN_CLIP_MS } from "@/lib/editor/trim";
import type { EditorState } from "@/lib/editor/types";
import type { TranscriptSegmentInput } from "@/lib/editor/words";

export type EditorSource = { id: string; durationMs: number | null };

/** Manual edits keep their existing minimum. Automatic generation limits do not apply here. */
export function editorSourceProblem(state: EditorState, source: EditorSource | null | undefined): string | null {
  if (!source || state.source.videoId !== source.id) return "source_identity_mismatch";
  const { startMs, endMs } = state.source;
  const durationMs = source.durationMs;
  if (durationMs === null || !Number.isSafeInteger(durationMs) || durationMs <= 0) return "source_duration_missing";
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) ||
      startMs < 0 || endMs - startMs < MIN_CLIP_MS || endMs > durationMs) return "invalid_source_range";
  return null;
}

/** This is timing evidence only. It does not approve meaning or prove audible word coverage. */
export function finalSelectedWordEndS(state: EditorState, segments: TranscriptSegmentInput[]): number {
  const { startMs, endMs } = state.source;
  for (const segment of segments) {
    if (!Number.isSafeInteger(segment.startMs) || !Number.isSafeInteger(segment.endMs) ||
        segment.startMs < 0 || segment.endMs <= segment.startMs) throw new Error("invalid_segment_evidence");
  }
  const selected = segments.filter((segment) => segment.startMs < endMs && segment.endMs > startMs);
  if (!selected.length) throw new Error("missing_word_evidence");
  const words = selected.flatMap((segment) => {
    if (!Array.isArray(segment.words) || !segment.words.length) throw new Error("missing_word_evidence");
    if (segment.words.some((word) => word.startMs < segment.startMs || word.endMs > segment.endMs)) {
      throw new Error("invalid_word_evidence");
    }
    return segment.words;
  });
  for (const word of words) {
    if (!Number.isSafeInteger(word.startMs) || !Number.isSafeInteger(word.endMs) ||
        word.startMs < 0 || word.endMs <= word.startMs) throw new Error("invalid_word_evidence");
  }
  const included = words.filter((word) => word.startMs < endMs && word.endMs > startMs);
  if (!included.length) throw new Error("missing_word_evidence");
  if (included.some((word) => word.startMs < startMs || word.endMs > endMs)) throw new Error("word_boundary_cut");
  return (included.reduce((lastEnd, word) => Math.max(lastEnd, word.endMs), startMs) - startMs) / 1000;
}
