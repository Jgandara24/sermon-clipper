import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  SOCIAL_SAFE_AREA,
  SOCIAL_SAFE_AREA_VERSION,
  captionMarginHPx,
  captionMarginVPx,
  captionMaxWidthPx,
  captionRestCentre,
  lowerThirdGeometry,
  safeAreaAnchorY,
  safeAreaGuideGeometry,
} from "@/lib/editor/social-safe-area";

/**
 * The frame's reserved edges, stated once.
 *
 * Before this existed the same idea was written down in five places and disagreed with itself in
 * three of them: the canvas guide drew the top band at 6 percent, the burn-in put a top-anchored
 * caption at 8, and the preview's own default put it at 10. A guide drawn from one number and a
 * caption placed by another is drift a viewer sees and no test catches, which is exactly what the
 * title overlay would have doubled.
 */
describe("the social safe area is one datum, versioned", () => {
  it("is versioned, because moving it moves every clip rendered afterwards", () => {
    expect(SOCIAL_SAFE_AREA_VERSION).toBeGreaterThanOrEqual(1);
    expect(SOCIAL_SAFE_AREA.version).toBe(SOCIAL_SAFE_AREA_VERSION);
  });

  it("states what the platforms' own chrome covers", () => {
    const { chrome } = SOCIAL_SAFE_AREA;
    for (const edge of [chrome.top, chrome.right, chrome.bottom, chrome.left]) {
      expect(edge).toBeGreaterThan(0);
      expect(edge).toBeLessThan(0.5);
    }
  });

  it("puts an anchored edge where the chrome ends", () => {
    // The two anchors are derived, not listed: the bottom one is the chrome edge itself, and the
    // top one sits a stated padding below it, which is the 2 percent the burn-in has always used.
    expect(safeAreaAnchorY("bottom-safe")).toBeCloseTo(1 - SOCIAL_SAFE_AREA.chrome.bottom, 10);
    expect(safeAreaAnchorY("top-safe")).toBeCloseTo(
      SOCIAL_SAFE_AREA.chrome.top + SOCIAL_SAFE_AREA.topPadding,
      10,
    );
    expect(safeAreaAnchorY("center")).toBe(0.5);
  });

  it("keeps the burn-in's caption margins exactly where they have always been", () => {
    // Every stored clip was rendered with these. The datum records them; it does not move them.
    expect(captionMarginVPx("top", 1920)).toBe(Math.round(1920 * 0.08));
    expect(captionMarginVPx("bottom", 1920)).toBe(Math.round(1920 * 0.12));
    expect(captionMarginVPx("middle", 1920)).toBe(0);
    expect(captionMarginHPx()).toBe(40);
    expect(captionMaxWidthPx(1080)).toBe(1080 - 80);
  });

  it("keeps the preview's resting caption centres where they have always been", () => {
    expect(captionRestCentre("top")).toEqual({ xPct: 0.5, yPct: 0.1 });
    expect(captionRestCentre("middle")).toEqual({ xPct: 0.5, yPct: 0.45 });
    expect(captionRestCentre("bottom")).toEqual({ xPct: 0.5, yPct: 0.86 });
  });

  it("gives the canvas guide its geometry as percentages of the frame", () => {
    const guide = safeAreaGuideGeometry();
    expect(guide.left).toBe("6%");
    expect(guide.right).toBe("6%");
    expect(guide.top).toBe("6%");
    expect(guide.bottom).toBe("12%");
    expect(guide.topBandHeight).toBe("6%");
    expect(guide.bottomBandHeight).toBe("12%");
  });

  it("gives the brand lower third its geometry from the same sides", () => {
    const band = lowerThirdGeometry();
    expect(band.left).toBe("6%");
    expect(band.right).toBe("6%");
    expect(band.bottom).toBe("22%");
  });

  it("derives every consumer from the datum rather than from a copy of it", async () => {
    // The property the whole file exists for, proved by moving the datum and watching the
    // consumers move with it. A consumer that kept its own number would not.
    vi.resetModules();
    vi.doMock("@/lib/editor/social-safe-area-values", () => ({
      SAFE_AREA_VALUES: {
        version: 99,
        chrome: { top: 0.2, right: 0.1, bottom: 0.3, left: 0.1 },
        topPadding: 0.05,
        captionMarginHPx: 10,
        captionRestCentreY: { top: 0.11, middle: 0.44, bottom: 0.77 },
        lowerThirdBottom: 0.4,
      },
    }));
    const moved = await import("@/lib/editor/social-safe-area");

    expect(moved.safeAreaAnchorY("top-safe")).toBeCloseTo(0.25, 10);
    expect(moved.safeAreaAnchorY("bottom-safe")).toBeCloseTo(0.7, 10);
    expect(moved.captionMarginVPx("top", 1000)).toBe(250);
    expect(moved.captionMarginVPx("bottom", 1000)).toBe(300);
    expect(moved.captionMaxWidthPx(1080)).toBe(1060);
    expect(moved.safeAreaGuideGeometry().top).toBe("20%");
    expect(moved.lowerThirdGeometry().bottom).toBe("40%");
    expect(moved.captionRestCentre("bottom").yPct).toBe(0.77);

    vi.doUnmock("@/lib/editor/social-safe-area-values");
    vi.resetModules();
  });
});

describe("no consumer keeps a private copy of the safe area", () => {
  const ROOT = path.join(__dirname, "..", "src");
  const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");

  it("leaves no hard-coded safe-area percentage in the preview", () => {
    // The guide used to be four Tailwind literals. There is no test environment that renders this
    // component, so the guard against a copy creeping back is the source itself.
    const source = read("components/editor/video-preview.tsx");
    expect(source).toContain("safeAreaGuideGeometry");
    expect(source).not.toMatch(/\[6%\]|\[12%\]|\[22%\]/);
    // The preview kept its own copy of the caption's 40px side margin, and wrapped from it while
    // the burn-in wrapped from the datum's. Two numbers that happened to agree is not one number.
    expect(source).toContain("captionMaxWidthPx");
    expect(source).not.toMatch(/const CAPTION_MARGIN_H/);
  });

  it("leaves no hard-coded caption margin in the burn-in", () => {
    const source = read("lib/export/ass-generator.ts");
    expect(source).toContain("captionMarginVPx");
    expect(source).not.toMatch(/videoHeight \* 0\.\d+/);
    expect(source).not.toMatch(/const MARGIN_H = \d+/);
  });
});
