import { describe, expect, it } from "vitest";
import {
  clampEnd,
  clampRegion,
  clampStart,
  clampTimelineZoom,
  computeTrimViewport,
  MIN_CLIP_MS,
  snapToBoundary,
  stepTimelineZoom,
  TIMELINE_ZOOM_MAX,
  TIMELINE_ZOOM_MIN,
  VIEWPORT_PAD_MAX_MS,
} from "@/lib/editor/trim";

describe("computeTrimViewport", () => {
  it("pads the clip on both sides, scaled to clip length", () => {
    const view = computeTrimViewport(60_000, 90_000, 600_000);
    // 30s clip → 30s pad each side.
    expect(view.start).toBe(30_000);
    expect(view.end).toBe(120_000);
  });

  it("clamps padding to the media bounds", () => {
    const view = computeTrimViewport(5_000, 25_000, 40_000);
    expect(view.start).toBe(0);
    expect(view.end).toBe(40_000);
  });

  it("caps padding for very long clips", () => {
    const view = computeTrimViewport(0, 600_000, 2_000_000);
    // pad capped at VIEWPORT_PAD_MAX_MS on the right (left already at 0).
    expect(view.end).toBe(600_000 + VIEWPORT_PAD_MAX_MS);
  });
});

describe("snapToBoundary", () => {
  const boundaries = [10_000, 20_000, 30_500];

  it("snaps to a boundary within the threshold", () => {
    expect(snapToBoundary(20_200, boundaries, 400)).toBe(20_000);
  });

  it("leaves the value alone when no boundary is close enough", () => {
    expect(snapToBoundary(25_000, boundaries, 400)).toBe(25_000);
  });

  it("picks the nearest of several in-threshold boundaries", () => {
    expect(snapToBoundary(15_100, [15_000, 15_200], 500)).toBe(15_000);
  });
});

describe("clampStart / clampEnd", () => {
  it("never lets the start pass 0 or crowd the end", () => {
    expect(clampStart(-5_000, 40_000)).toBe(0);
    expect(clampStart(39_000, 40_000)).toBe(40_000 - MIN_CLIP_MS);
  });

  it("never lets the end pass the media or crowd the start", () => {
    expect(clampEnd(999_000, 40_000, 120_000)).toBe(120_000);
    expect(clampEnd(41_000, 40_000, 120_000)).toBe(40_000 + MIN_CLIP_MS);
  });
});

describe("clampRegion", () => {
  it("slides the window keeping its length", () => {
    const region = clampRegion(50_000, 20_000, 600_000);
    expect(region).toEqual({ startMs: 50_000, endMs: 70_000 });
  });

  it("stops the window at the media edges", () => {
    expect(clampRegion(-10_000, 20_000, 600_000)).toEqual({ startMs: 0, endMs: 20_000 });
    expect(clampRegion(595_000, 20_000, 600_000)).toEqual({ startMs: 580_000, endMs: 600_000 });
  });
});

describe("timeline zoom", () => {
  const ZOOMS = [TIMELINE_ZOOM_MIN, 0.5, 1, 2, TIMELINE_ZOOM_MAX];

  it("at 1 the window is exactly what it was before zoom existed", () => {
    expect(computeTrimViewport(60_000, 90_000, 600_000, 1)).toEqual(
      computeTrimViewport(60_000, 90_000, 600_000),
    );
  });

  it("zooming in shows less source on each side, and zooming out shows more", () => {
    // A 30s clip gets 30s of padding at 1. Zoom is magnification, so 2 halves it and 0.5 doubles it.
    expect(computeTrimViewport(60_000, 90_000, 600_000, 2)).toEqual({ start: 45_000, end: 105_000 });
    expect(computeTrimViewport(60_000, 90_000, 600_000, 0.5)).toEqual({ start: 0, end: 150_000 });
  });

  it("stays inside the media at every zoom", () => {
    for (const zoom of ZOOMS) {
      const view = computeTrimViewport(5_000, 25_000, 40_000, zoom);
      expect(view.start).toBeGreaterThanOrEqual(0);
      expect(view.end).toBeLessThanOrEqual(40_000);
    }
  });

  it("keeps the whole clip inside the window at every zoom, so both handles stay reachable", () => {
    for (const zoom of ZOOMS) {
      const view = computeTrimViewport(60_000, 90_000, 600_000, zoom);
      expect(view.start).toBeLessThanOrEqual(60_000);
      expect(view.end).toBeGreaterThanOrEqual(90_000);
      expect(view.end - view.start).toBeGreaterThan(30_000);
    }
  });

  it("never reaches the trim limits, by construction", () => {
    // The limits come from the clamp helpers, and none of them takes a zoom: the window is a view
    // of the source, and the bounds are the source itself. Their arity is the executable statement
    // of that, so a zoom parameter added to any of them fails here and has to explain itself.
    expect(clampStart.length).toBe(2);
    expect(clampEnd.length).toBe(3);
    expect(clampRegion.length).toBe(3);

    // And the bounds a handle lands on are the media's, whatever window it was pushed out of.
    for (const zoom of ZOOMS) {
      const view = computeTrimViewport(60_000, 90_000, 600_000, zoom);
      expect(clampStart(view.start - 1_000_000, 90_000)).toBe(0);
      expect(clampStart(view.end + 1_000_000, 90_000)).toBe(90_000 - MIN_CLIP_MS);
      expect(clampEnd(view.end + 1_000_000, 60_000, 600_000)).toBe(600_000);
      expect(clampEnd(view.start - 1_000_000, 60_000, 600_000)).toBe(60_000 + MIN_CLIP_MS);
    }
  });

  it("clamps a zoom to its range, and treats nonsense as 1", () => {
    expect(clampTimelineZoom(0)).toBe(TIMELINE_ZOOM_MIN);
    expect(clampTimelineZoom(1_000)).toBe(TIMELINE_ZOOM_MAX);
    expect(clampTimelineZoom(Number.NaN)).toBe(1);
    expect(clampTimelineZoom(2)).toBe(2);
  });

  it("steps by doubling and halving, and stops at the ends", () => {
    expect(stepTimelineZoom(1, "in")).toBe(2);
    expect(stepTimelineZoom(1, "out")).toBe(0.5);
    expect(stepTimelineZoom(TIMELINE_ZOOM_MAX, "in")).toBe(TIMELINE_ZOOM_MAX);
    expect(stepTimelineZoom(TIMELINE_ZOOM_MIN, "out")).toBe(TIMELINE_ZOOM_MIN);
  });
});
