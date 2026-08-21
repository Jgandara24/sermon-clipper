// Pure math for the direct-manipulation editing canvas.
//
// Everything an object on the canvas needs — where it sits, how a drag moves it, how a corner
// resize scales it — and everything the *view* of that canvas needs — zoom, pan, and turning a
// pointer position into a canvas coordinate. The two are deliberately separate: an object's
// position is a document value, the viewport is not, and the only place they meet is
// `pointerToCanvasPct`, which undoes the viewport so a drag lands where the finger is regardless
// of how far the canvas is zoomed.
//
// Slice 6 mounts this under the captions. Slice 9's title overlay is meant to mount the same
// module and the same component rather than growing a second implementation, so nothing here
// mentions captions.

/** A point on the canvas, as a fraction of the frame. (0,0) is top-left, (1,1) bottom-right. */
export type CanvasPoint = { xPct: number; yPct: number };

/** How the canvas is being *looked at*. Never part of the saved document. */
export type CanvasViewport = { zoom: number; panXPct: number; panYPct: number };

export const CANVAS_MIN_ZOOM = 1;
export const CANVAS_MAX_ZOOM = 4;

/** Within this fraction of the frame's vertical centre line, a dragged object snaps to it. */
export const CENTRE_SNAP_PCT = 0.02;

export const CANVAS_VIEWPORT_RESET: CanvasViewport = { zoom: 1, panXPct: 0, panYPct: 0 };

export function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function clampPoint(point: CanvasPoint): CanvasPoint {
  return { xPct: clampPct(point.xPct), yPct: clampPct(point.yPct) };
}

/**
 * Horizontal-centre snapping. Reports whether it snapped so the canvas can show the guide only
 * while the object is actually on the line — a guide that is always visible tells you nothing.
 */
export function snapToCentre(
  point: CanvasPoint,
  thresholdPct: number = CENTRE_SNAP_PCT,
): { point: CanvasPoint; snappedToCentre: boolean } {
  const snapped = Math.abs(point.xPct - 0.5) <= thresholdPct;
  return {
    point: { xPct: snapped ? 0.5 : clampPct(point.xPct), yPct: clampPct(point.yPct) },
    snappedToCentre: snapped,
  };
}

/** Moves an object by a canvas-fraction delta, snapping to the centre line and staying in frame. */
export function moveObject(
  origin: CanvasPoint,
  dxPct: number,
  dyPct: number,
  thresholdPct: number = CENTRE_SNAP_PCT,
): { point: CanvasPoint; snappedToCentre: boolean } {
  return snapToCentre(
    { xPct: clampPct(origin.xPct + dxPct), yPct: clampPct(origin.yPct + dyPct) },
    thresholdPct,
  );
}

/**
 * Corner resize for a text object.
 *
 * A caption has no independent width and height to drag — the text decides those. What a corner
 * handle actually controls is how big the type is, so the handle's distance from the object's
 * centre scales the font size. Dragging a corner outward makes the words bigger, which is what
 * the gesture looks like it should do.
 */
export function resizeFontPx(params: {
  startSizePx: number;
  startDistancePx: number;
  currentDistancePx: number;
  minPx: number;
  maxPx: number;
}): number {
  const { startSizePx, startDistancePx, currentDistancePx, minPx, maxPx } = params;
  // A gesture that began on top of the centre has no ratio to scale by; leave the size alone.
  if (startDistancePx <= 0) return Math.round(Math.min(maxPx, Math.max(minPx, startSizePx)));
  const scaled = (startSizePx * currentDistancePx) / startDistancePx;
  return Math.round(Math.min(maxPx, Math.max(minPx, scaled)));
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return CANVAS_MIN_ZOOM;
  return Math.min(CANVAS_MAX_ZOOM, Math.max(CANVAS_MIN_ZOOM, zoom));
}

/**
 * The furthest the content may be panned before its edge would come inside the frame.
 *
 * At 100% there is nothing to pan: the content exactly fills the view, so the bound is zero and
 * every pan collapses to the reset viewport.
 */
export function maxPanPct(zoom: number): number {
  const z = clampZoom(zoom);
  return (1 - 1 / z) / 2;
}

export function clampViewport(viewport: CanvasViewport): CanvasViewport {
  const zoom = clampZoom(viewport.zoom);
  const bound = maxPanPct(zoom);
  const clamp = (value: number) =>
    Number.isFinite(value) ? Math.min(bound, Math.max(-bound, value)) : 0;
  return { zoom, panXPct: clamp(viewport.panXPct), panYPct: clamp(viewport.panYPct) };
}

export function zoomBy(viewport: CanvasViewport, factor: number): CanvasViewport {
  return clampViewport({ ...viewport, zoom: viewport.zoom * factor });
}

export function panBy(viewport: CanvasViewport, dxPct: number, dyPct: number): CanvasViewport {
  return clampViewport({
    ...viewport,
    panXPct: viewport.panXPct + dxPct,
    panYPct: viewport.panYPct + dyPct,
  });
}

/** True when the canvas is showing the whole frame at 100%, which is what "reset" restores. */
export function isViewportReset(viewport: CanvasViewport): boolean {
  return viewport.zoom === 1 && viewport.panXPct === 0 && viewport.panYPct === 0;
}

/** Percent, for the zoom readout and the reset control's label. */
export function zoomPercent(viewport: CanvasViewport): number {
  return Math.round(clampZoom(viewport.zoom) * 100);
}

export type CanvasRect = { left: number; top: number; width: number; height: number };

/**
 * The CSS transform the canvas content is drawn with. Kept here beside its own inverse so the two
 * cannot drift: `pointerToCanvasPct` is only correct while it undoes exactly this.
 *
 * Applied with `transform-origin: center`, a content point p maps to the view at
 * `0.5 + zoom * ((p - 0.5) + pan)`.
 */
export function canvasTransform(viewport: CanvasViewport): string {
  const { zoom, panXPct, panYPct } = clampViewport(viewport);
  if (zoom === 1 && panXPct === 0 && panYPct === 0) return "none";
  return `scale(${zoom}) translate(${panXPct * 100}%, ${panYPct * 100}%)`;
}

/**
 * A pointer position, as a canvas coordinate.
 *
 * This is the whole reason zoom and pan cannot disturb a saved position: the viewport is undone
 * on the way in, so a drag of the same object to the same visible spot produces the same document
 * value at 100% and at 400%.
 */
export function pointerToCanvasPct(params: {
  clientX: number;
  clientY: number;
  rect: CanvasRect;
  viewport: CanvasViewport;
}): CanvasPoint {
  const { clientX, clientY, rect, viewport } = params;
  const { zoom, panXPct, panYPct } = clampViewport(viewport);
  if (rect.width <= 0 || rect.height <= 0) return { xPct: 0, yPct: 0 };

  const viewX = (clientX - rect.left) / rect.width;
  const viewY = (clientY - rect.top) / rect.height;
  return {
    xPct: 0.5 + (viewX - 0.5) / zoom - panXPct,
    yPct: 0.5 + (viewY - 0.5) / zoom - panYPct,
  };
}

/** A pointer *movement*, as a canvas-fraction delta. Scales down as the canvas zooms in. */
export function deltaToCanvasPct(params: {
  dxPx: number;
  dyPx: number;
  rect: CanvasRect;
  viewport: CanvasViewport;
}): { dxPct: number; dyPct: number } {
  const { dxPx, dyPx, rect, viewport } = params;
  const zoom = clampZoom(viewport.zoom);
  if (rect.width <= 0 || rect.height <= 0) return { dxPct: 0, dyPct: 0 };
  return { dxPct: dxPx / rect.width / zoom, dyPct: dyPx / rect.height / zoom };
}

export type TouchPoint = { clientX: number; clientY: number };

export function touchDistance(a: TouchPoint, b: TouchPoint): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

export function touchMidpoint(a: TouchPoint, b: TouchPoint): TouchPoint {
  return { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 };
}

/**
 * One frame of a pinch. Measured against where the gesture started rather than the previous
 * frame, so rounding cannot accumulate across a long pinch.
 */
export function pinchViewport(params: {
  startViewport: CanvasViewport;
  startDistancePx: number;
  currentDistancePx: number;
}): CanvasViewport {
  const { startViewport, startDistancePx, currentDistancePx } = params;
  if (startDistancePx <= 0) return clampViewport(startViewport);
  return clampViewport({
    ...startViewport,
    zoom: startViewport.zoom * (currentDistancePx / startDistancePx),
  });
}
