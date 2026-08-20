import type { TranscriptionResult } from "./types";

/**
 * The audio window actually submitted to the transcription provider.
 *
 * Paid transcription is priced per audio hour, so the window is a cost decision as well as an
 * editorial one. Until the coarse sermon-boundary stage lands, the narrowest window usually
 * available is the complete service — allowed temporarily, but measured rather than assumed, so
 * the cost of the missing stage is visible instead of silently absorbed.
 */
export type SubmittedSermonRange = {
  startMs: number;
  endMs: number;
  /** "full_service" means no narrower window was known — worship and announcements are paid for. */
  scope: "full_service" | "sermon_range";
};

function readRange(processingConfig: unknown): { startMs: number; endMs: number } | null {
  if (!processingConfig || typeof processingConfig !== "object" || Array.isArray(processingConfig)) {
    return null;
  }
  const raw = (processingConfig as { sermonRange?: unknown }).sermonRange;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { startMs, endMs } = raw as { startMs?: unknown; endMs?: unknown };
  if (typeof startMs !== "number" || typeof endMs !== "number") return null;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return { startMs, endMs };
}

/**
 * Resolves the narrowest sermon window currently known for a source.
 *
 * A malformed, inverted, or empty range is ignored rather than repaired: submitting the whole
 * service costs money, but submitting the wrong window loses the sermon. The expensive failure is
 * the safe one here.
 */
export function resolveSubmittedSermonRange(
  processingConfig: unknown,
  sourceDurationMs: number,
): SubmittedSermonRange {
  const fullService = {
    startMs: 0,
    endMs: Math.max(0, Math.round(sourceDurationMs)),
    scope: "full_service" as const,
  };

  const configured = readRange(processingConfig);
  if (!configured) return fullService;

  const startMs = Math.max(0, Math.round(configured.startMs));
  const endMs = Math.min(fullService.endMs, Math.round(configured.endMs));
  if (endMs <= startMs) return fullService;
  if (startMs === fullService.startMs && endMs === fullService.endMs) return fullService;

  return { startMs, endMs, scope: "sermon_range" };
}

/**
 * Shifts a transcript produced from a submitted window back onto the source timeline.
 *
 * Everything downstream — clip ranges, caption timing, scripture references, future search —
 * is expressed in source time. A transcript that quietly used window time would misplace every
 * one of them by the window offset.
 */
export function offsetTranscriptionResult(
  result: TranscriptionResult,
  offsetMs: number,
): TranscriptionResult {
  if (offsetMs === 0) return result;
  return {
    ...result,
    segments: result.segments.map((segment) => ({
      ...segment,
      startMs: segment.startMs + offsetMs,
      endMs: segment.endMs + offsetMs,
      words: segment.words.map((word) => ({
        ...word,
        startMs: word.startMs + offsetMs,
        endMs: word.endMs + offsetMs,
      })),
    })),
  };
}
