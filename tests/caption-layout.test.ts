import { describe, expect, it } from "vitest";
import { layoutCaptionLine, type TextMeasurer } from "@/lib/editor/caption-layout";
import { getCaptionPreset, normalizeCaptionStyle } from "@/lib/editor/caption-presets";
import type { CaptionWord } from "@/lib/editor/caption-lines";

// Deterministic fake: every character is 10px at 40px font, scaling linearly with size.
const measure: TextMeasurer = (text, fontPx) => text.length * (fontPx / 4);

const FRAME = { width: 1080, height: 1920 };

function words(...texts: string[]): CaptionWord[] {
  return texts.map((text, i) => ({
    id: `s:${i}`,
    word: text,
    startMs: i * 300,
    endMs: (i + 1) * 300,
  }));
}

const kinetic = getCaptionPreset("kinetic").style;

describe("layoutCaptionLine", () => {
  it("centers a single row and reserves pop-aware word clearance", () => {
    const style = { ...kinetic, sizePx: 40, uppercase: false };
    const layout = layoutCaptionLine({ words: words("one", "two") }, style, FRAME, measure);

    expect(layout.rows).toHaveLength(1);
    // Natural space is 10px. Kinetic's 21% animation overshoot reserves another 3.15px.
    expect(layout.rows[0].widthPx).toBe(73);
    expect(layout.words[0].xCenter).toBe(Math.round((1080 - 73.15) / 2 + 15));
    expect(layout.words[1].xCenter).toBe(Math.round((1080 - 73.15) / 2 + 30 + 13.15 + 15));
    // both words share the row's vertical center
    expect(layout.words[0].yCenter).toBe(layout.words[1].yCenter);
  });

  it("measures the uppercased text when the style uppercases", () => {
    const style = { ...kinetic, uppercase: true };
    const layout = layoutCaptionLine({ words: words("hello") }, style, FRAME, measure);
    expect(layout.words[0].text).toBe("HELLO");
  });

  it("wraps into a second row past the universal safe width", () => {
    const style = { ...kinetic, sizePx: 40, uppercase: false };
    // each word 400px wide; 400*2 + space > 950 forces a wrap
    const layout = layoutCaptionLine(
      { words: words("a".repeat(40), "b".repeat(40), "c".repeat(40)) },
      style,
      FRAME,
      measure,
    );

    expect(layout.rows.length).toBeGreaterThan(1);
    expect(layout.words.some((w) => w.row === 1)).toBe(true);
    for (const row of layout.rows) {
      expect(row.widthPx).toBeLessThanOrEqual(1080 * 0.76);
    }
  });

  it("increases word spacing as the pop scale increases", () => {
    const base = layoutCaptionLine(
      { words: words("wide", "words") },
      { ...kinetic, sizePx: 40, uppercase: false, highlightScale: 1 },
      FRAME,
      measure,
    );
    const popped = layoutCaptionLine(
      { words: words("wide", "words") },
      { ...kinetic, sizePx: 40, uppercase: false, highlightScale: 1.4 },
      FRAME,
      measure,
    );

    expect(popped.rows[0].widthPx).toBeGreaterThan(base.rows[0].widthPx);
    expect(popped.words[1].xCenter - popped.words[0].xCenter).toBeGreaterThan(
      base.words[1].xCenter - base.words[0].xCenter,
    );
  });

  it("reserves clearance for the pop animation overshoot", () => {
    const layout = layoutCaptionLine(
      { words: words("abcdefghij", "short") },
      { ...kinetic, sizePx: 40, uppercase: false, highlightScale: 1.4 },
      FRAME,
      measure,
    );
    const [left, right] = layout.words;
    const baseGap = right.xCenter - right.widthPx / 2 - (left.xCenter + left.widthPx / 2);

    // 10px natural space + 30px reserve for the 1.6x animation overshoot on a 100px word.
    expect(baseGap).toBe(40);
  });

  it("moves rows horizontally with positionX", () => {
    const left = layoutCaptionLine(
      { words: words("hi") },
      { ...kinetic, positionX: 35 },
      FRAME,
      measure,
    );
    const right = layoutCaptionLine(
      { words: words("hi") },
      { ...kinetic, positionX: 65 },
      FRAME,
      measure,
    );

    expect(right.blockCenterX).toBeGreaterThan(left.blockCenterX);
  });

  it("anchors center on positionY", () => {
    const style = { ...kinetic, sizePx: 40, positionY: 50, anchor: "center" as const };
    const layout = layoutCaptionLine({ words: words("hi") }, style, FRAME, measure);
    const lineHeight = Math.round(40 * 1.25);
    expect(layout.blockTopY).toBe(Math.round(960 - lineHeight / 2));
  });

  it("anchors bottom on positionY", () => {
    const style = { ...kinetic, sizePx: 40, positionY: 88, anchor: "bottom" as const };
    const layout = layoutCaptionLine({ words: words("hi") }, style, FRAME, measure);
    const lineHeight = Math.round(40 * 1.25);
    expect(layout.blockTopY).toBe(Math.round(1920 * 0.88 - lineHeight));
  });

  it("aligns semantic anchors with the universal safe area", () => {
    const top = layoutCaptionLine(
      { words: words("hi") },
      { ...kinetic, sizePx: 40, highlightScale: 1, safeAnchor: "top-safe" },
      FRAME,
      measure,
    );
    const center = layoutCaptionLine(
      { words: words("hi") },
      { ...kinetic, sizePx: 40, highlightScale: 1, safeAnchor: "center" },
      FRAME,
      measure,
    );
    const bottom = layoutCaptionLine(
      { words: words("hi") },
      { ...kinetic, sizePx: 40, highlightScale: 1, safeAnchor: "bottom-safe" },
      FRAME,
      measure,
    );

    expect(top.blockTopY).toBe(Math.round(1920 * 0.14));
    expect(center.blockCenterY).toBe(960);
    expect(bottom.blockTopY + bottom.blockHeightPx).toBe(Math.round(1920 * 0.78));
  });

  it("clamps the block inside the frame at extreme positionY", () => {
    const top = layoutCaptionLine(
      { words: words("hi") },
      { ...kinetic, positionY: 0 },
      FRAME,
      measure,
    );
    const bottom = layoutCaptionLine(
      { words: words("hi") },
      { ...kinetic, positionY: 100 },
      FRAME,
      measure,
    );

    expect(top.blockTopY).toBeGreaterThanOrEqual(1920 * 0.04);
    expect(bottom.blockTopY + bottom.blockHeightPx).toBeLessThanOrEqual(1920 * 0.96);
  });

  it("reproduces the legacy bottom-position placement through normalization", () => {
    // The legacy "bottom" position mapped to marginV = 12% of frame height; the normalized
    // positionY 88 / anchor bottom must put the block's bottom edge at the same line.
    const legacyBottom = normalizeCaptionStyle({
      ...getCaptionPreset("clean").style,
      position: "bottom",
      positionY: undefined as unknown as number,
      anchor: undefined as unknown as "center",
    });
    const layout = layoutCaptionLine({ words: words("hi") }, legacyBottom, FRAME, measure);
    expect(layout.blockTopY + layout.blockHeightPx).toBe(Math.round(1920 * 0.88));
  });
});
