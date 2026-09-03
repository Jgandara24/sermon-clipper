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

// Timeline zoom is magnification: 2 shows half the padding on each side of the clip, 0.5 shows
// twice as much. It is view state — never saved, never read by anything that decides what the
// clip contains. The clamp helpers below do not take it, and that is deliberate: a window is a
// view of the source, and the limits a handle stops at are the source itself.
export const TIMELINE_ZOOM_MIN = 0.25;
export const TIMELINE_ZOOM_MAX = 8;
const TIMELINE_ZOOM_STEP = 2;

export type TrimViewport = { start: number; end: number };

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** A zoom inside the supported range; anything that is not a number is the resting 1. */
export function clampTimelineZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return clamp(zoom, TIMELINE_ZOOM_MIN, TIMELINE_ZOOM_MAX);
}

/** One press of the zoom buttons: doubles or halves, and stops at the ends of the range. */
export function stepTimelineZoom(zoom: number, direction: "in" | "out"): number {
  const current = clampTimelineZoom(zoom);
  return clampTimelineZoom(
    direction === "in" ? current * TIMELINE_ZOOM_STEP : current / TIMELINE_ZOOM_STEP,
  );
}

/**
 * The visible source window for the timeline: the clip padded on both sides (clamped to the real
 * media bounds) so the in/out handles sit away from the edges and can be dragged either way.
 *
 * `zoom` scales only the padding. The clip itself is always inside the window whole, so both
 * handles stay reachable at every zoom, and the media bounds clamp the window exactly as they do
 * at 1.
 */
export function computeTrimViewport(
  startMs: number,
  endMs: number,
  sourceDurationMs: number,
  zoom = 1,
): TrimViewport {
  const basePad = clamp(endMs - startMs, VIEWPORT_PAD_MIN_MS, VIEWPORT_PAD_MAX_MS);
  const pad = basePad / clampTimelineZoom(zoom);
  const start = Math.max(0, startMs - pad);
  const end = Math.min(sourceDurationMs, endMs + pad);
  // Degenerate guard (zero-length media / bad bounds): keep a non-empty window.
  return end > start ? { start, end } : { start: 0, end: Math.max(1, sourceDurationMs) };
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
