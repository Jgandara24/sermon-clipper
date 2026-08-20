/**
 * Transport arithmetic for the clip editor.
 *
 * The editor plays a window of a much longer service, so every position is clip-relative: a step
 * backwards must not fall into the previous point of the sermon, and reaching the end must not run
 * on into whatever the pastor said next. Keeping that arithmetic here, rather than inside the video
 * element's event handler, is what makes it checkable.
 */

/** The step for "Back 3 seconds" and "Forward 3 seconds". */
export const SKIP_STEP_MS = 3_000;

export type TimeRange = { startMs: number; endMs: number };

/** Keeps a position inside the clip window, whatever it is handed. */
export function clampToClip(ms: number, startMs: number, endMs: number): number {
  const low = Math.min(startMs, endMs);
  const high = Math.max(startMs, endMs);
  if (!Number.isFinite(ms)) return low;
  return Math.min(high, Math.max(low, ms));
}

/** Steps by a delta and clamps, so a skip near a bound lands on the bound instead of outside it. */
export function seekByMs(
  currentMs: number,
  deltaMs: number,
  startMs: number,
  endMs: number,
): number {
  return clampToClip(currentMs + deltaMs, startMs, endMs);
}

export type PlaybackAction =
  /** Keep playing; `atMs` is the position to report. */
  | { kind: "play"; atMs: number }
  /** Jump the video to `toMs` — a deleted word, or a position before the clip start. */
  | { kind: "skip"; toMs: number }
  /** Pause and settle exactly on the clip end. */
  | { kind: "stop"; atMs: number };

/**
 * Decides what playback should do at a reported time.
 *
 * Reaching the end stops. It used to seek back to the clip start and keep playing, which turned
 * every preview into a loop nobody asked for and made it impossible to see the last frame the
 * export will contain.
 */
export function playbackActionForTime(params: {
  ms: number;
  startMs: number;
  endMs: number;
  deletedRanges: TimeRange[];
}): PlaybackAction {
  const { ms, startMs, endMs, deletedRanges } = params;

  if (ms >= endMs) return { kind: "stop", atMs: endMs };
  if (ms < startMs) return { kind: "skip", toMs: startMs };

  const deleted = deletedRanges.find((range) => ms >= range.startMs && ms < range.endMs);
  if (deleted) {
    // A cut that runs to the end of the clip leaves nothing to resume into.
    if (deleted.endMs >= endMs) return { kind: "stop", atMs: endMs };
    return { kind: "skip", toMs: deleted.endMs };
  }

  return { kind: "play", atMs: ms };
}

/** Maps a pointer's x position over a track to a time on the visible range. */
export function positionFromPointer(
  clientX: number,
  track: { left: number; width: number },
  viewStartMs: number,
  viewEndMs: number,
): number {
  if (track.width <= 0) return viewStartMs;
  const ratio = Math.min(1, Math.max(0, (clientX - track.left) / track.width));
  return viewStartMs + ratio * (viewEndMs - viewStartMs);
}

/** m:ss for the transport readout. */
export function msToTimecode(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
