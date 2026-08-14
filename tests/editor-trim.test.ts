import { describe, expect, it } from "vitest";
import {
  clampEnd,
  clampRegion,
  clampStart,
  computeTrimViewport,
  MIN_CLIP_MS,
  snapToBoundary,
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
