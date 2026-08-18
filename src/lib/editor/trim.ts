// Pure math for the drag-to-trim timeline (src/components/editor/clip-timeline.tsx). Kept out of
// the component so the boundary/clamp logic is unit-testable without a DOM. The clip window these
// operate on is state.source.startMs/endMs — the same values the export render reads, so a trim
// here is exactly what gets rendered.

/** Shortest clip a manual trim may produce. Below this, dragging a handle stops. */
export const MIN_CLIP_MS = 3_000;
// Source shown on each side of the clip so the handles have room to drag in AND out. Scales with
// clip length within these bounds — a 30s clip gets 30s of padding each side, a 5s clip gets 15s.
export const VIEWPORT_PAD_MIN_MS = 15_000;
export const VIEWPORT_PAD_MAX_MS = 60_000;
export const TIMELINE_MAX_ZOOM_SPAN_MS = 12_000;

export type TrimViewport = { start: number; end: number };

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The visible source window for the timeline: the clip padded on both sides (clamped to the real
 * media bounds) so the in/out handles sit away from the edges and can be dragged either way.
 */
export function computeTrimViewport(
  startMs: number,
  endMs: number,
  sourceDurationMs: number,
): TrimViewport {
  const pad = clamp(endMs - startMs, VIEWPORT_PAD_MIN_MS, VIEWPORT_PAD_MAX_MS);
  const start = Math.max(0, startMs - pad);
  const end = Math.min(sourceDurationMs, endMs + pad);
  // Degenerate guard (zero-length media / bad bounds): keep a non-empty window.
  return end > start ? { start, end } : { start: 0, end: Math.max(1, sourceDurationMs) };
}

/**
 * Visible source time for the multi-track timeline. Zero zoom keeps the existing padded trim view.
 * Maximum zoom shows a twelve-second window centered on the requested time. The window always
 * stays inside the real media bounds.
 */
export function computeTimelineViewport(
  startMs: number,
  endMs: number,
  sourceDurationMs: number,
  centerMs: number,
  zoom: number,
): TrimViewport {
  const duration = Math.max(1, sourceDurationMs);
  const base = computeTrimViewport(startMs, endMs, duration);
  const baseSpan = base.end - base.start;
  const normalizedZoom = clamp(zoom, 0, 1);
  const minimumSpan = Math.min(baseSpan, TIMELINE_MAX_ZOOM_SPAN_MS);
  const span = baseSpan - (baseSpan - minimumSpan) * normalizedZoom;
  if (normalizedZoom === 0) return base;
  const desiredStart = clamp(centerMs, 0, duration) - span / 2;
  const start = clamp(desiredStart, 0, duration - span);
  return { start: Math.round(start), end: Math.round(start + span) };
}

/**
 * Snaps a raw time to the nearest word boundary within `thresholdMs`, so handles land on speech
 * edges (consistent with the word-cut export) instead of mid-word. Returns the raw time when no
 * boundary is close enough. `boundaries` need not be sorted.
 */
export function snapToBoundary(ms: number, boundaries: number[], thresholdMs: number): number {
  let best = ms;
  let bestDist = thresholdMs;
  for (const boundary of boundaries) {
    const dist = Math.abs(boundary - ms);
    if (dist < bestDist) {
      best = boundary;
      bestDist = dist;
    }
  }
  return best;
}

/** New clip start when dragging the in-handle: never past 0 or within MIN_CLIP_MS of the end. */
export function clampStart(ms: number, endMs: number): number {
  return Math.round(clamp(ms, 0, endMs - MIN_CLIP_MS));
}

/** New clip end when dragging the out-handle: never past the media, nor within MIN_CLIP_MS of start. */
export function clampEnd(ms: number, startMs: number, sourceDurationMs: number): number {
  return Math.round(clamp(ms, startMs + MIN_CLIP_MS, sourceDurationMs));
}

/**
 * New window when dragging the whole selection: the clip keeps its length and slides, clamped so
 * neither edge leaves the media.
 */
export function clampRegion(
  desiredStartMs: number,
  widthMs: number,
  sourceDurationMs: number,
): { startMs: number; endMs: number } {
  const startMs = Math.round(clamp(desiredStartMs, 0, sourceDurationMs - widthMs));
  return { startMs, endMs: startMs + widthMs };
}
