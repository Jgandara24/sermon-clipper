import { describe, expect, it } from "vitest";
import { resizeCaptionFromCorner } from "@/lib/editor/caption-transform";

describe("resizeCaptionFromCorner", () => {
  it("scales caption size from any corner around the object center", () => {
    expect(
      resizeCaptionFromCorner({
        corner: "bottom-right",
        pointerX: 650,
        pointerY: 575,
        centerX: 500,
        centerY: 500,
        boundsWidth: 200,
        boundsHeight: 100,
        startSizePx: 40,
        minSizePx: 16,
        maxSizePx: 160,
      }),
    ).toBe(60);
  });

  it("clamps the result to the supported caption size", () => {
    expect(
      resizeCaptionFromCorner({
        corner: "top-left",
        pointerX: 499,
        pointerY: 499,
        centerX: 500,
        centerY: 500,
        boundsWidth: 200,
        boundsHeight: 100,
        startSizePx: 40,
        minSizePx: 16,
        maxSizePx: 160,
      }),
    ).toBe(16);
  });
});
