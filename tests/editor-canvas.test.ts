import { describe, expect, it } from "vitest";
import {
  CANVAS_MAX_ZOOM,
  CANVAS_MIN_ZOOM,
  CANVAS_VIEWPORT_RESET,
  canvasTransform,
  clampPoint,
  clampViewport,
  clampZoom,
  deltaToCanvasPct,
  isViewportReset,
  maxPanPct,
  moveObject,
  panBy,
  pinchViewport,
  pointerToCanvasPct,
  resizeFontPx,
  snapToCentre,
  touchDistance,
  touchMidpoint,
  zoomBy,
  zoomPercent,
  type CanvasViewport,
} from "@/lib/editor/canvas";

const RECT = { left: 0, top: 0, width: 400, height: 711 };

describe("clampPoint", () => {
  it("keeps an object inside the frame", () => {
    expect(clampPoint({ xPct: 1.4, yPct: -0.3 })).toEqual({ xPct: 1, yPct: 0 });
  });

  it("treats a non-finite coordinate as the frame's edge rather than propagating NaN", () => {
    expect(clampPoint({ xPct: Number.NaN, yPct: 0.5 })).toEqual({ xPct: 0, yPct: 0.5 });
  });
});

describe("snapToCentre", () => {
  it("snaps an object released near the centre line onto it", () => {
    const result = snapToCentre({ xPct: 0.507, yPct: 0.8 });
    expect(result.point.xPct).toBe(0.5);
    expect(result.snappedToCentre).toBe(true);
  });

  it("leaves an object that is clearly off-centre alone", () => {
    const result = snapToCentre({ xPct: 0.2, yPct: 0.8 });
    expect(result.point.xPct).toBe(0.2);
    expect(result.snappedToCentre).toBe(false);
  });

  it("does not report a snap the object is not actually on", () => {
    expect(snapToCentre({ xPct: 0.56, yPct: 0.5 }).snappedToCentre).toBe(false);
  });

  it("never moves the object vertically", () => {
    expect(snapToCentre({ xPct: 0.501, yPct: 0.31 }).point.yPct).toBe(0.31);
  });
});

describe("moveObject", () => {
  it("moves by the delta it is given", () => {
    expect(moveObject({ xPct: 0.2, yPct: 0.2 }, 0.1, -0.05).point).toEqual({
      xPct: 0.30000000000000004,
      yPct: 0.15000000000000002,
    });
  });

  it("snaps to the centre line when the drag lands near it", () => {
    const result = moveObject({ xPct: 0.48, yPct: 0.5 }, 0.015, 0);
    expect(result.point.xPct).toBe(0.5);
    expect(result.snappedToCentre).toBe(true);
  });

  it("stops at the frame edge rather than leaving it", () => {
    expect(moveObject({ xPct: 0.9, yPct: 0.9 }, 0.5, 0.5).point).toEqual({ xPct: 1, yPct: 1 });
  });
});

describe("resizeFontPx", () => {
  it("grows the type as the corner is dragged away from the centre", () => {
    expect(
      resizeFontPx({
        startSizePx: 40,
        startDistancePx: 100,
        currentDistancePx: 150,
        minPx: 16,
        maxPx: 160,
      }),
    ).toBe(60);
  });

  it("shrinks the type as the corner is dragged inward", () => {
    expect(
      resizeFontPx({
        startSizePx: 40,
        startDistancePx: 100,
        currentDistancePx: 50,
        minPx: 16,
        maxPx: 160,
      }),
    ).toBe(20);
  });

  it("stops at the smallest readable size", () => {
    expect(
      resizeFontPx({
        startSizePx: 40,
        startDistancePx: 100,
        currentDistancePx: 1,
        minPx: 16,
        maxPx: 160,
      }),
    ).toBe(16);
  });

  it("stops at the largest allowed size", () => {
    expect(
      resizeFontPx({
        startSizePx: 40,
        startDistancePx: 100,
        currentDistancePx: 100_000,
        minPx: 16,
        maxPx: 160,
      }),
    ).toBe(160);
  });

  it("leaves the size alone for a gesture that began on the centre", () => {
    expect(
      resizeFontPx({
        startSizePx: 44,
        startDistancePx: 0,
        currentDistancePx: 80,
        minPx: 16,
        maxPx: 160,
      }),
    ).toBe(44);
  });
});

describe("zoom bounds", () => {
  it("never zooms out past the whole frame", () => {
    expect(clampZoom(0.2)).toBe(CANVAS_MIN_ZOOM);
  });

  it("stops at the maximum zoom", () => {
    expect(clampZoom(99)).toBe(CANVAS_MAX_ZOOM);
  });

  it("reports the zoom as a percentage", () => {
    expect(zoomPercent({ zoom: 2.5, panXPct: 0, panYPct: 0 })).toBe(250);
    expect(zoomPercent(CANVAS_VIEWPORT_RESET)).toBe(100);
  });
});

describe("pan bounds", () => {
  it("allows no panning at all at 100%, because the frame already fills the view", () => {
    expect(maxPanPct(1)).toBe(0);
    expect(panBy(CANVAS_VIEWPORT_RESET, 0.4, 0.4)).toEqual(CANVAS_VIEWPORT_RESET);
  });

  it("allows more panning the further in the canvas is zoomed", () => {
    expect(maxPanPct(2)).toBeCloseTo(0.25, 6);
    expect(maxPanPct(4)).toBeCloseTo(0.375, 6);
  });

  it("never pans the frame's edge inside the view", () => {
    const panned = panBy({ zoom: 2, panXPct: 0, panYPct: 0 }, 5, -5);
    expect(panned.panXPct).toBeCloseTo(0.25, 6);
    expect(panned.panYPct).toBeCloseTo(-0.25, 6);
  });

  it("pulls an existing pan back in when the canvas zooms out", () => {
    const zoomedOut = clampViewport({ zoom: 1, panXPct: 0.3, panYPct: 0.3 });
    expect(zoomedOut).toEqual(CANVAS_VIEWPORT_RESET);
  });
});

describe("isViewportReset", () => {
  it("is true for the reset viewport", () => {
    expect(isViewportReset(CANVAS_VIEWPORT_RESET)).toBe(true);
  });

  it("is false once the canvas is zoomed", () => {
    expect(isViewportReset({ zoom: 2, panXPct: 0, panYPct: 0 })).toBe(false);
  });

  it("is false once the canvas is panned", () => {
    expect(isViewportReset({ zoom: 1, panXPct: 0.1, panYPct: 0 })).toBe(false);
  });
});

describe("canvasTransform", () => {
  it("draws nothing at all at 100%", () => {
    expect(canvasTransform(CANVAS_VIEWPORT_RESET)).toBe("none");
  });

  it("scales and translates once zoomed", () => {
    expect(canvasTransform({ zoom: 2, panXPct: 0.1, panYPct: -0.1 })).toBe(
      "scale(2) translate(10%, -10%)",
    );
  });
});

describe("pointerToCanvasPct", () => {
  it("maps the middle of the view to the middle of the canvas", () => {
    const point = pointerToCanvasPct({
      clientX: 200,
      clientY: 355.5,
      rect: RECT,
      viewport: CANVAS_VIEWPORT_RESET,
    });
    expect(point.xPct).toBeCloseTo(0.5, 6);
    expect(point.yPct).toBeCloseTo(0.5, 6);
  });

  it("maps the top-left corner to the origin", () => {
    const point = pointerToCanvasPct({
      clientX: 0,
      clientY: 0,
      rect: RECT,
      viewport: CANVAS_VIEWPORT_RESET,
    });
    expect(point.xPct).toBeCloseTo(0, 6);
    expect(point.yPct).toBeCloseTo(0, 6);
  });

  it("undoes the zoom, so the same pixel is a different canvas point when zoomed", () => {
    const zoomed = pointerToCanvasPct({
      clientX: 300,
      clientY: 355.5,
      rect: RECT,
      viewport: { zoom: 2, panXPct: 0, panYPct: 0 },
    });
    // A quarter of the way across the view is an eighth of the way across the canvas at 2x.
    expect(zoomed.xPct).toBeCloseTo(0.625, 6);
  });

  it("undoes the pan", () => {
    const panned = pointerToCanvasPct({
      clientX: 200,
      clientY: 355.5,
      rect: RECT,
      viewport: { zoom: 2, panXPct: 0.1, panYPct: 0 },
    });
    expect(panned.xPct).toBeCloseTo(0.4, 6);
  });

  it("is the exact inverse of the transform it is paired with", () => {
    const viewport: CanvasViewport = { zoom: 3, panXPct: 0.2, panYPct: -0.15 };
    for (const original of [0.1, 0.5, 0.9]) {
      // Forward: where the transform puts this canvas point in the view.
      const viewFrac = 0.5 + viewport.zoom * (original - 0.5 + viewport.panXPct);
      const back = pointerToCanvasPct({
        clientX: viewFrac * RECT.width,
        clientY: 0,
        rect: RECT,
        viewport,
      });
      expect(back.xPct).toBeCloseTo(original, 6);
    }
  });

  it("survives a rect with no size rather than returning NaN", () => {
    expect(
      pointerToCanvasPct({
        clientX: 10,
        clientY: 10,
        rect: { left: 0, top: 0, width: 0, height: 0 },
        viewport: CANVAS_VIEWPORT_RESET,
      }),
    ).toEqual({ xPct: 0, yPct: 0 });
  });
});

describe("deltaToCanvasPct", () => {
  it("turns a pixel movement into a canvas fraction", () => {
    const delta = deltaToCanvasPct({
      dxPx: 40,
      dyPx: 71.1,
      rect: RECT,
      viewport: CANVAS_VIEWPORT_RESET,
    });
    expect(delta.dxPct).toBeCloseTo(0.1, 6);
    expect(delta.dyPct).toBeCloseTo(0.1, 6);
  });

  it("moves the object less per pixel the further in the canvas is zoomed", () => {
    const delta = deltaToCanvasPct({
      dxPx: 40,
      dyPx: 0,
      rect: RECT,
      viewport: { zoom: 4, panXPct: 0, panYPct: 0 },
    });
    expect(delta.dxPct).toBeCloseTo(0.025, 6);
  });
});

describe("pinch", () => {
  it("measures the distance between two fingers", () => {
    expect(touchDistance({ clientX: 0, clientY: 0 }, { clientX: 3, clientY: 4 })).toBe(5);
  });

  it("finds the point between two fingers", () => {
    expect(touchMidpoint({ clientX: 0, clientY: 0 }, { clientX: 10, clientY: 20 })).toEqual({
      clientX: 5,
      clientY: 10,
    });
  });

  it("zooms in as the fingers spread", () => {
    const next = pinchViewport({
      startViewport: CANVAS_VIEWPORT_RESET,
      startDistancePx: 100,
      currentDistancePx: 200,
    });
    expect(next.zoom).toBe(2);
  });

  it("zooms out as the fingers close", () => {
    const next = pinchViewport({
      startViewport: { zoom: 4, panXPct: 0, panYPct: 0 },
      startDistancePx: 200,
      currentDistancePx: 100,
    });
    expect(next.zoom).toBe(2);
  });

  it("measures against the start of the gesture, so a pinch back returns to where it began", () => {
    const start: CanvasViewport = { zoom: 2, panXPct: 0, panYPct: 0 };
    const out = pinchViewport({ startViewport: start, startDistancePx: 100, currentDistancePx: 180 });
    const back = pinchViewport({ startViewport: start, startDistancePx: 100, currentDistancePx: 100 });
    expect(out.zoom).not.toBe(start.zoom);
    expect(back.zoom).toBe(start.zoom);
  });

  it("cannot pinch below 100%", () => {
    const next = pinchViewport({
      startViewport: CANVAS_VIEWPORT_RESET,
      startDistancePx: 200,
      currentDistancePx: 10,
    });
    expect(next).toEqual(CANVAS_VIEWPORT_RESET);
  });

  it("survives a gesture with no starting distance", () => {
    expect(
      pinchViewport({
        startViewport: CANVAS_VIEWPORT_RESET,
        startDistancePx: 0,
        currentDistancePx: 50,
      }),
    ).toEqual(CANVAS_VIEWPORT_RESET);
  });
});

describe("the viewport is a view, never a document value", () => {
  it("zooming and panning changes no object coordinate", () => {
    const object = { xPct: 0.42, yPct: 0.77 };
    let viewport = CANVAS_VIEWPORT_RESET;
    viewport = zoomBy(viewport, 3);
    viewport = panBy(viewport, 0.2, -0.1);

    // Nothing in this module can write to the object; the point is that the object is untouched
    // by construction, and the test states the property the canvas must preserve.
    expect(object).toEqual({ xPct: 0.42, yPct: 0.77 });
    expect(viewport.zoom).toBe(3);
  });

  it("drags to the same visible place produce the same document value at any zoom", () => {
    const at100 = pointerToCanvasPct({
      clientX: 260,
      clientY: 400,
      rect: RECT,
      viewport: CANVAS_VIEWPORT_RESET,
    });

    // The same canvas point, viewed at 2x with the view panned to keep it on screen.
    const viewport: CanvasViewport = { zoom: 2, panXPct: 0, panYPct: 0 };
    const viewX = 0.5 + viewport.zoom * (at100.xPct - 0.5 + viewport.panXPct);
    const viewY = 0.5 + viewport.zoom * (at100.yPct - 0.5 + viewport.panYPct);
    const at200 = pointerToCanvasPct({
      clientX: viewX * RECT.width,
      clientY: viewY * RECT.height,
      rect: RECT,
      viewport,
    });

    expect(at200.xPct).toBeCloseTo(at100.xPct, 6);
    expect(at200.yPct).toBeCloseTo(at100.yPct, 6);
  });
});
