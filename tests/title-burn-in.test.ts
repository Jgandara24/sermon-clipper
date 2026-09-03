import { describe, expect, it } from "vitest";
import { getCaptionPreset } from "@/lib/editor/caption-presets";
import { createCaptionMeasurer } from "@/lib/export/font-metrics";
import { generateAssSubtitles, type AssCaptionLine } from "@/lib/export/ass-generator";
import { defaultTitleBanner, type TitleBanner } from "@/lib/editor/title-banner";
import { layOutTitleBanner } from "@/lib/editor/title-layout";
import { applyTextCase } from "@/lib/editor/text-case";
import { resolveCaptionFace } from "@/lib/editor/caption-face";

const W = 1080;
const H = 1920;
const style = getCaptionPreset("highlighter").style;

const LINES: AssCaptionLine[] = [
  {
    id: "line",
    startMs: 0,
    endMs: 1000,
    text: "peace is here",
    words: ["peace", "is", "here"].map((word, index) => ({
      id: `line:${index}`,
      word,
      startMs: index * 333,
      endMs: (index + 1) * 333,
    })),
  },
];

function titleMeasurer(banner: TitleBanner) {
  const face = resolveCaptionFace(banner);
  const m = createCaptionMeasurer({ family: face.family, bold: face.bold, sizePx: banner.sizePx });
  return { measure: m.measure, spaceWidth: m.spaceWidth };
}

function banner(overrides: Partial<TitleBanner> = {}): TitleBanner {
  return {
    ...defaultTitleBanner({ startMs: 0, endMs: 9000 }),
    text: "grace upon grace",
    ...overrides,
  };
}

function render(t: TitleBanner) {
  const measurer = titleMeasurer(t);
  const ass = generateAssSubtitles(LINES, style, W, H, null, null, {
    banner: t,
    measurer,
  });
  const layout = layOutTitleBanner({
    title: t,
    videoWidth: W,
    videoHeight: H,
    ...measurer,
  });
  const events = ass.split("\n").filter((line) => line.startsWith("Dialogue:"));
  return { ass, layout, events, title: events.filter((line) => line.includes(",Title,")) };
}

/**
 * The title in the burn-in.
 *
 * A title the preview shows and the export omits is the defect this plan exists to prevent, and
 * Slice 7 proved how many separate ways two text engines can disagree. So every property is
 * asserted against the shared layout the preview also reads — none of them inferred from another.
 */
describe("the burn-in draws the title from the shared layout", () => {
  it("draws nothing at all when there is no title", () => {
    const ass = generateAssSubtitles(LINES, style, W, H, null, null, null);
    expect(ass).not.toContain(",Title,");
    expect(ass).not.toContain("Style: Title,");
  });

  it("draws the box and the text, box beneath", () => {
    const { title } = render(banner());
    const box = title.filter((line) => line.includes("\\p1"));
    const text = title.filter((line) => !line.includes("\\p1"));

    expect(box.length).toBeGreaterThan(0);
    expect(text.length).toBeGreaterThan(0);
    const layerOf = (line: string) => Number(line.slice("Dialogue: ".length).split(",")[0]);
    expect(Math.max(...box.map(layerOf))).toBeLessThan(Math.min(...text.map(layerOf)));
  });

  it("states the box at exactly the dimensions the layout computed", () => {
    const { title, layout } = render(banner());
    const drawing = title.find((line) => line.includes("\\p1"))!;

    expect(drawing).toContain(`\\pos(${layout.box.x},${layout.box.y})`);
    // An \an7 drawing runs from its position, so the shape's own corner is the box's size.
    expect(drawing).toContain(`m 0 0 l ${layout.box.width} 0 ${layout.box.width} ${layout.box.height} 0 ${layout.box.height}`);
  });

  it("puts each line where the layout puts it, in the order it wrapped", () => {
    const { title, layout } = render(banner({ text: "peace is not the absence of trouble", widthPct: 0.4 }));
    const text = title.filter((line) => !line.includes("\\p1"));

    expect(layout.lines.length).toBeGreaterThan(1);
    expect(text).toHaveLength(layout.lines.length);
    for (const [index, line] of layout.lines.entries()) {
      expect(text[index]).toContain(`\\pos(${Math.round(layout.textX)},${Math.round(layout.lineCentresY[index])})`);
      expect(text[index].endsWith(line)).toBe(true);
    }
  });

  it("draws the cased text, because the file has no text-transform", () => {
    const { title } = render(banner({ text: "grace upon grace", textCase: "uppercase" }));
    const text = title.filter((line) => !line.includes("\\p1"));
    expect(text.some((line) => line.endsWith("GRACE UPON GRACE"))).toBe(true);
    expect(text.some((line) => line.endsWith("grace upon grace"))).toBe(false);
  });

  it("names the title's own face, size and weight in a style of its own", () => {
    const { ass } = render(banner({ sizePx: 72, weight: 700 }));
    expect(ass).toContain("Style: Title,DejaVu Sans,72,");
    // -1 is what an ASS style line calls bold.
    expect(ass).toMatch(/Style: Title,DejaVu Sans,72,[^\n]*,-1,0,0,0,/);
  });

  it("does not draw the title in the caption's face when they differ", () => {
    const { ass } = render(banner({ fontFamily: "DejaVu Sans", sizePx: 40 }));
    const titleStyle = ass.split("\n").find((line) => line.startsWith("Style: Title,"))!;
    expect(titleStyle).toContain(",40,");
    expect(ass.split("\n").find((line) => line.startsWith("Style: Default,"))).toContain(
      `,${style.sizePx},`,
    );
  });

  it("anchors the text as the alignment says", () => {
    for (const [align, tag] of [["left", "\\an4"], ["center", "\\an5"], ["right", "\\an6"]] as const) {
      const { title } = render(banner({ align }));
      const text = title.filter((line) => !line.includes("\\p1"));
      expect(text[0], `${align} should use ${tag}`).toContain(tag);
    }
  });

  it("fills the box in the background colour the member chose", () => {
    const { title } = render(banner({ backgroundColor: "#FF0000" }));
    const drawing = title.find((line) => line.includes("\\p1"))!;
    // ASS colours are BBGGRR behind the hash.
    expect(drawing).toContain("\\1c&H0000FF&");
  });

  it("draws the text in the text colour the member chose", () => {
    const { title } = render(banner({ color: "#00FF00" }));
    const text = title.filter((line) => !line.includes("\\p1"))[0];
    expect(text).toContain("\\1c&H00FF00&");
  });

  it("draws no border shape at all when the border is zero wide", () => {
    const { title } = render(banner({ border: { widthPx: 0, color: "#123456" } }));
    expect(title.filter((line) => line.includes("\\p1"))).toHaveLength(1);
  });

  it("draws the border as a shape behind the background, in its own colour", () => {
    const { title, layout } = render(banner({ border: { widthPx: 8, color: "#123456" } }));
    const drawings = title.filter((line) => line.includes("\\p1"));

    expect(drawings).toHaveLength(2);
    // The border is the full box; the background is inset by the border's width on every side.
    expect(drawings[0]).toContain("\\1c&H563412&");
    expect(drawings[0]).toContain(`\\pos(${layout.box.x},${layout.box.y})`);
    expect(drawings[1]).toContain(`\\pos(${layout.box.x + 8},${layout.box.y + 8})`);
    expect(drawings[1]).toContain(
      `m 0 0 l ${layout.box.width - 16} 0 ${layout.box.width - 16} ${layout.box.height - 16} 0 ${layout.box.height - 16}`,
    );
  });

  it("casts a shadow only when the member asked for one", () => {
    expect(render(banner({ shadow: false })).title.find((l) => l.includes("\\p1"))).toContain("\\shad0");
    expect(render(banner({ shadow: true })).title.find((l) => l.includes("\\p1"))).not.toContain("\\shad0");
  });

  it("shows the title over exactly the range the model states, on the centisecond grid", () => {
    const { title } = render(banner({ startMs: 1234, endMs: 4567 }));
    for (const line of title) {
      expect(line).toContain("0:00:01.23,0:00:04.57,");
    }
  });

  it("leaves the caption events exactly as they were", () => {
    // A title must not disturb a single caption. This is the same line rendered with and without.
    const withTitle = render(banner()).ass;
    const without = generateAssSubtitles(LINES, style, W, H, null, null, null);
    const captionsOf = (ass: string) =>
      ass.split("\n").filter((line) => line.startsWith("Dialogue:") && line.includes(",Default,"));
    expect(captionsOf(withTitle)).toEqual(captionsOf(without));
  });
});

describe("the file and the layout cannot drift apart", () => {
  it("takes every number in the file from the layout, for each anchor", () => {
    for (const anchor of ["top-safe", "center", "bottom-safe"] as const) {
      const { title, layout } = render(banner({ anchor }));
      const drawing = title.find((line) => line.includes("\\p1"))!;
      expect(drawing, anchor).toContain(`\\pos(${layout.box.x},${layout.box.y})`);
    }
  });

  it("moves with the box when the title is dragged", () => {
    const dragged = banner({ anchor: "custom", box: { xPct: 0.3, yPct: 0.7 } });
    const { title, layout } = render(dragged);
    expect(title.find((line) => line.includes("\\p1"))).toContain(
      `\\pos(${layout.box.x},${layout.box.y})`,
    );
    expect(layout.box.y).toBeGreaterThan(H / 2);
  });

  it("draws exactly the strings the layout wrapped to, and nothing else", () => {
    const { title, layout } = render(banner({ text: "peace is not the absence of trouble", widthPct: 0.4 }));
    const drawn = title
      .filter((line) => !line.includes("\\p1"))
      .map((line) => line.slice(line.lastIndexOf("}") + 1));
    expect(drawn).toEqual(layout.lines);
    expect(drawn.join(" ")).toBe(applyTextCase("peace is not the absence of trouble", "uppercase"));
  });
});
