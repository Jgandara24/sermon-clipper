import { describe, expect, it } from "vitest";
import { defaultTitleBanner, type TitleBanner } from "@/lib/editor/title-banner";
import { layOutTitleBanner, titleLineHeightPx } from "@/lib/editor/title-layout";
import { safeAreaAnchorY } from "@/lib/editor/social-safe-area";

const W = 1080;
const H = 1920;

/** A measurer with round numbers, so the arithmetic under test is the thing being read. */
const TEN_PER_CHAR = { measure: (text: string) => text.length * 10, spaceWidth: 10 };

function title(overrides: Partial<TitleBanner> = {}): TitleBanner {
  return { ...defaultTitleBanner({ startMs: 0, endMs: 9000 }), text: "GRACE", ...overrides };
}

function lay(t: TitleBanner) {
  return layOutTitleBanner({ title: t, videoWidth: W, videoHeight: H, ...TEN_PER_CHAR });
}

/**
 * Where the title's box and text sit, computed once for both renderers.
 *
 * The preview and the burn-in are two different text engines. Every number either of them needs —
 * the box, the wrap, the line height, where each line sits — comes from here, because a title the
 * preview shows and the export draws differently is the defect this plan exists to prevent.
 */
describe("the title box takes its place from the shared datum", () => {
  it("sits at the top-safe line when anchored there", () => {
    const laid = lay(title({ anchor: "top-safe" }));
    expect(laid.box.y).toBe(Math.round(H * safeAreaAnchorY("top-safe")));
  });

  it("rests its bottom edge on the bottom-safe line", () => {
    const laid = lay(title({ anchor: "bottom-safe" }));
    expect(laid.box.y + laid.box.height).toBe(Math.round(H * safeAreaAnchorY("bottom-safe")));
  });

  it("centres on the frame when anchored to the centre", () => {
    const laid = lay(title({ anchor: "center" }));
    expect(laid.box.y + laid.box.height / 2).toBeCloseTo(H / 2, 0);
  });

  it("centres on the point it was dragged to", () => {
    const laid = lay(title({ anchor: "custom", box: { xPct: 0.25, yPct: 0.4 } }));
    expect(laid.box.x + laid.box.width / 2).toBeCloseTo(W * 0.25, 0);
    expect(laid.box.y + laid.box.height / 2).toBeCloseTo(H * 0.4, 0);
  });

  it("is horizontally centred until it is dragged", () => {
    for (const anchor of ["top-safe", "center", "bottom-safe"] as const) {
      const laid = lay(title({ anchor }));
      expect(laid.box.x + laid.box.width / 2).toBeCloseTo(W / 2, 0);
    }
  });

  it("is as wide as its share of the frame", () => {
    expect(lay(title({ widthPct: 0.5 })).box.width).toBe(540);
    expect(lay(title({ widthPct: 0.88 })).box.width).toBe(Math.round(W * 0.88));
  });
});

describe("the title's text is wrapped and measured once", () => {
  it("keeps a short title on one line", () => {
    const laid = lay(title({ text: "GRACE" }));
    expect(laid.lines).toEqual(["GRACE"]);
  });

  it("applies the case before it measures, not after", () => {
    // Measuring "grace" and drawing "GRACE" is how a box comes out too small for its own text.
    expect(lay(title({ text: "grace", textCase: "uppercase" })).lines).toEqual(["GRACE"]);
    expect(lay(title({ text: "GRACE", textCase: "lowercase" })).lines).toEqual(["grace"]);
  });

  it("wraps on words when the text is wider than the box", () => {
    // 10px a character, a 324px box less 26px of padding a side: 272px of room for 350px of text.
    const laid = lay(title({ text: "peace is not the absence of trouble", widthPct: 0.3 }));
    expect(laid.lines.length).toBeGreaterThan(1);
    expect(laid.lines.join(" ")).toBe("PEACE IS NOT THE ABSENCE OF TROUBLE");
  });

  it("never breaks a word that cannot fit, so no text is lost", () => {
    const laid = lay(title({ text: "SUPERCALIFRAGILISTIC", widthPct: 0.1 }));
    expect(laid.lines).toEqual(["SUPERCALIFRAGILISTIC"]);
  });

  it("grows the box to hold every line it wrapped to", () => {
    const one = lay(title({ text: "GRACE", widthPct: 0.3 }));
    const many = lay(title({ text: "peace is not the absence of trouble", widthPct: 0.3 }));
    expect(many.box.height).toBeGreaterThan(one.box.height);
    expect(many.box.height - one.box.height).toBe(
      (many.lines.length - 1) * titleLineHeightPx(many.sizePx),
    );
  });

  it("puts an empty title's box at one line's height, so it can still be seen and dragged", () => {
    const laid = lay(title({ text: "" }));
    expect(laid.lines).toEqual([""]);
    expect(laid.box.height).toBeGreaterThan(0);
  });
});

describe("the box's own geometry is stated, not inferred", () => {
  it("makes the line height the font size, which is what an ASS size means", () => {
    // An ASS Fontsize is a height: libass scales the face so ascent plus descent equals it. So a
    // line occupies exactly that many pixels, and neither renderer has to guess.
    expect(titleLineHeightPx(64)).toBe(64);
    expect(lay(title({ sizePx: 80 })).lineHeight).toBe(80);
  });

  it("pads the box around its text in proportion to the size", () => {
    const small = lay(title({ sizePx: 40 }));
    const large = lay(title({ sizePx: 80 }));
    expect(large.padding.x).toBeGreaterThan(small.padding.x);
    expect(large.padding.y).toBeGreaterThan(small.padding.y);
  });

  it("makes room for a border inside the box rather than outside it", () => {
    // Outside, and a bordered title would be wider than the width the member set.
    const plain = lay(title({ border: { widthPx: 0, color: "#000000" } }));
    const bordered = lay(title({ border: { widthPx: 6, color: "#000000" } }));
    expect(bordered.box.width).toBe(plain.box.width);
    expect(bordered.textWidth).toBeLessThan(plain.textWidth);
  });

  it("places each line under the last, inside the padding", () => {
    const laid = lay(title({ text: "peace is not the absence of trouble", widthPct: 0.3 }));
    const [first, second] = laid.lineCentresY;
    expect(second - first).toBe(laid.lineHeight);
    expect(first - laid.lineHeight / 2).toBeGreaterThanOrEqual(laid.box.y);
  });

  it("anchors the text where the alignment says, inside the padding", () => {
    const left = lay(title({ align: "left" }));
    const centre = lay(title({ align: "center" }));
    const right = lay(title({ align: "right" }));

    expect(left.textX).toBeLessThan(centre.textX);
    expect(right.textX).toBeGreaterThan(centre.textX);
    expect(centre.textX).toBeCloseTo(centre.box.x + centre.box.width / 2, 0);
    expect(left.textX).toBe(left.box.x + left.padding.x + left.border.widthPx);
  });
});
