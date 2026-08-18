export type EditorPanelWidths = {
  transcriptPx: number;
  inspectorPx: number;
};

export const EDITOR_PANEL_LIMITS = {
  transcript: { initialPx: 340, minPx: 260, maxPx: 520 },
  inspector: { initialPx: 300, minPx: 260, maxPx: 480 },
  videoMinPx: 280,
  dividersPx: 14,
  keyboardStepPx: 16,
  keyboardLargeStepPx: 48,
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Clamps one side panel without changing the other. The remaining width belongs to the Video
 * panel, so this function also enforces its hard minimum.
 */
export function resizeEditorPanels(params: {
  widths: EditorPanelWidths;
  target: "transcript" | "inspector";
  requestedPx: number;
  containerPx: number;
}): EditorPanelWidths {
  const { widths, target, requestedPx, containerPx } = params;
  const otherPx = target === "transcript" ? widths.inspectorPx : widths.transcriptPx;
  const ownLimits = EDITOR_PANEL_LIMITS[target];
  const centerConstrainedMax =
    containerPx - otherPx - EDITOR_PANEL_LIMITS.videoMinPx - EDITOR_PANEL_LIMITS.dividersPx;
  const nextPx = Math.round(
    clamp(requestedPx, ownLimits.minPx, Math.min(ownLimits.maxPx, centerConstrainedMax)),
  );

  return target === "transcript"
    ? { ...widths, transcriptPx: nextPx }
    : { ...widths, inspectorPx: nextPx };
}
