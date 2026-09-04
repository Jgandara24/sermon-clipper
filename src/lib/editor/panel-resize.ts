// Panel widths for the editor's three columns, and where the video sits between them.
//
// The dividers are dragged, so the arithmetic that keeps a panel inside its bounds — and keeps
// the video usable and visually centred — is the part that goes wrong. It lives here, pure and
// tested, rather than in a pointer handler.

export type PanelName = "transcript" | "style";

/** What each side panel may be dragged to. Below the minimum it stops being readable. */
export const PANEL_LIMITS: Record<PanelName, { min: number; max: number }> = {
  transcript: { min: 220, max: 480 },
  style: { min: 260, max: 520 },
};

/** The video never gets smaller than this, whatever the panels want. */
export const VIDEO_MIN_PX = 280;

export type PanelWidths = { transcript: number; style: number };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(Number.isFinite(value) ? value : 0);
}

/**
 * Both panels inside their own bounds, and inside what the container can spare.
 *
 * The video's minimum wins over a panel's width but never over a panel's minimum: in a container
 * too narrow for both, the panels sit at their minimums and the page scrolls rather than the
 * transcript becoming unreadable.
 */
export function clampPanelWidths({
  containerWidth,
  transcript,
  style,
}: {
  containerWidth: number;
  transcript: number;
  style: number;
}): PanelWidths {
  const wanted = {
    transcript: clamp(round(transcript), PANEL_LIMITS.transcript.min, PANEL_LIMITS.transcript.max),
    style: clamp(round(style), PANEL_LIMITS.style.min, PANEL_LIMITS.style.max),
  };

  const spare = round(containerWidth) - VIDEO_MIN_PX;
  const overflow = wanted.transcript + wanted.style - spare;
  if (overflow <= 0) return wanted;

  // Both are over: take from each in proportion to what it has above its minimum, so neither
  // collapses while the other keeps everything it asked for.
  const room = {
    transcript: wanted.transcript - PANEL_LIMITS.transcript.min,
    style: wanted.style - PANEL_LIMITS.style.min,
  };
  const totalRoom = room.transcript + room.style;
  if (totalRoom <= 0) return wanted;

  const take = Math.min(overflow, totalRoom);
  return {
    transcript: wanted.transcript - Math.round((take * room.transcript) / totalRoom),
    style: wanted.style - Math.round((take * room.style) / totalRoom),
  };
}

/**
 * One frame of a divider drag: the named panel changes width and the other keeps its own.
 *
 * The Style divider sits on that panel's left edge, so dragging it right makes it narrower —
 * which is why the delta is subtracted rather than added.
 */
export function resizeDivider({
  divider,
  containerWidth,
  transcript,
  style,
  deltaPx,
}: {
  divider: PanelName;
  containerWidth: number;
  transcript: number;
  style: number;
  deltaPx: number;
}): PanelWidths {
  const proposed =
    divider === "transcript"
      ? { transcript: transcript + deltaPx, style }
      : { transcript, style: style - deltaPx };

  const clamped = clampPanelWidths({ containerWidth, ...proposed });
  // Only the dragged panel may move: proportional clamping could otherwise nudge its neighbour
  // mid-drag, which reads as the other panel drifting under the pointer.
  return divider === "transcript"
    ? { transcript: Math.min(clamped.transcript, containerWidth - style - VIDEO_MIN_PX), style }
    : { transcript, style: Math.min(clamped.style, containerWidth - transcript - VIDEO_MIN_PX) };
}

export type VideoBox = {
  width: number;
  padLeft: number;
  padRight: number;
  /** False when centring would take the video under its minimum, so it fills the column instead. */
  centred: boolean;
};

/**
 * Where the video is drawn in the middle column.
 *
 * The column between two different panels is not centred on the page, so the video is padded
 * inside it until its own centre lands on the container's centre — which is what "the video stays
 * visually centred while either side panel changes width" means. The widest video that can be
 * centred is `containerWidth - 2 × the wider panel`; when that is smaller than the video's own
 * minimum, being usable wins over being centred and the video fills the column.
 */
export function centredVideoBox({
  containerWidth,
  transcript,
  style,
}: {
  containerWidth: number;
  transcript: number;
  style: number;
}): VideoBox {
  const column = Math.max(0, round(containerWidth) - round(transcript) - round(style));
  if (column === 0) return { width: 0, padLeft: 0, padRight: 0, centred: false };

  const centredWidth = round(containerWidth) - 2 * Math.max(round(transcript), round(style));
  if (centredWidth < VIDEO_MIN_PX) {
    return { width: column, padLeft: 0, padRight: 0, centred: false };
  }

  const width = Math.min(column, centredWidth);
  const padLeft = round(containerWidth) / 2 - width / 2 - round(transcript);
  return {
    width,
    padLeft: Math.max(0, padLeft),
    padRight: Math.max(0, column - width - Math.max(0, padLeft)),
    centred: true,
  };
}
