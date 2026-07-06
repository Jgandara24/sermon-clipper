import { describe, expect, it } from "vitest";
import { computeCenterCrop, cropRectToPixels, resolveCropRect } from "@/lib/export/crop";
import type { EditorState } from "@/lib/editor/types";

describe("computeCenterCrop", () => {
  it("crops width for a 16:9 source down to 9:16", () => {
    const crop = computeCenterCrop(1920, 1080);
    expect(crop.h).toBe(1);
    expect(crop.y).toBe(0);
    expect(crop.w).toBeCloseTo(1080 * (9 / 16) / 1920, 5);
    expect(crop.x).toBeCloseTo((1 - crop.w) / 2, 5);
  });

  it("crops height for a very tall/narrow source", () => {
    const crop = computeCenterCrop(1080, 3000);
    expect(crop.w).toBe(1);
    expect(crop.x).toBe(0);
    expect(crop.h).toBeLessThan(1);
  });

  it("is a no-op crop for a source already at 9:16", () => {
    const crop = computeCenterCrop(1080, 1920);
    expect(crop).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe("resolveCropRect", () => {
  const baseLayout: EditorState["layout"] = {
    mode: "center",
    crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 },
    aspect: "9:16",
  };

  it("uses the stored crop for manual mode", () => {
    const resolved = resolveCropRect({ ...baseLayout, mode: "manual" }, 1920, 1080);
    expect(resolved).toEqual(baseLayout.crop);
  });

  it("computes a center crop for center mode, ignoring the stored crop", () => {
    const resolved = resolveCropRect({ ...baseLayout, mode: "center" }, 1920, 1080);
    expect(resolved).toEqual(computeCenterCrop(1920, 1080));
  });

  it("falls back to center crop for face mode (no tracking implemented)", () => {
    const resolved = resolveCropRect({ ...baseLayout, mode: "face" }, 1920, 1080);
    expect(resolved).toEqual(computeCenterCrop(1920, 1080));
  });
});

describe("cropRectToPixels", () => {
  it("converts a normalized rect to even pixel dimensions within bounds", () => {
    const px = cropRectToPixels({ x: 0.25, y: 0, w: 0.5, h: 1 }, 1921, 1081);
    expect(px.w % 2).toBe(0);
    expect(px.h % 2).toBe(0);
    expect(px.x + px.w).toBeLessThanOrEqual(1921);
    expect(px.y + px.h).toBeLessThanOrEqual(1081);
  });
});
