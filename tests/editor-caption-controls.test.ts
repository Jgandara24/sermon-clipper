import { describe, expect, it } from "vitest";
import {
  CAPTION_PRESETS,
  getCaptionPreset,
  NEON_YELLOW,
  SELECTABLE_CAPTION_PRESETS,
} from "@/lib/editor/caption-presets";
import { resolveCaptionStyle } from "@/lib/editor/caption-style";
import {
  clampToRange,
  displayedValue,
  isSynchronised,
  parseNumericInput,
  type NumericRange,
} from "@/lib/editor/numeric-field";
import { buildDefaultEditorState, editorStateSchema } from "@/lib/editor/types";

const WEIGHT: NumericRange = { min: 100, max: 900, step: 100 };
const SIZE: NumericRange = { min: 16, max: 160, step: 1 };

describe("the preset picker", () => {
  it("offers Clean and Highlighter, and nothing else", () => {
    expect(SELECTABLE_CAPTION_PRESETS.map((preset) => preset.name)).toEqual([
      "Clean",
      "Highlighter",
    ]);
  });

  it("still knows the retired presets", () => {
    expect(CAPTION_PRESETS.map((preset) => preset.id)).toEqual(
      expect.arrayContaining(["bold-serif", "karaoke", "quiet"]),
    );
  });

  it("still renders a clip saved against a retired preset", () => {
    // A church approved this look. Hiding the preset from the picker must not change it.
    const karaoke = getCaptionPreset("karaoke");
    expect(karaoke.id).toBe("karaoke");
    expect(karaoke.style.position).toBe("middle");
    expect(karaoke.style.background).toBe("pill");
    expect(karaoke.style.highlightColor).toBe("#FFD34D");
  });

  it("keeps every retired preset's style exactly as it was", () => {
    expect(getCaptionPreset("bold-serif").style.fontFamily).toBe("Georgia, 'Times New Roman', serif");
    expect(getCaptionPreset("bold-serif").style.sizePx).toBe(50);
    expect(getCaptionPreset("quiet").style.sizePx).toBe(36);
    expect(getCaptionPreset("quiet").style.shadow).toBe(false);
  });

  it("falls back to Clean for an id it does not know", () => {
    expect(getCaptionPreset("no-such-preset").id).toBe("clean");
  });
});

describe("Highlighter", () => {
  const highlighter = getCaptionPreset("highlighter").style;

  it("highlights in Neon Yellow", () => {
    expect(highlighter.highlightColor).toBe(NEON_YELLOW);
  });

  it("sits in the bottom safe area", () => {
    expect(highlighter.position).toBe("bottom");
  });

  it("uses uppercase, like everything new", () => {
    expect(highlighter.textCase).toBe("uppercase");
  });
});

describe("text case for new content", () => {
  it("a new clip starts in Uppercase", () => {
    const state = buildDefaultEditorState({ sourceVideoId: "v", startMs: 0, endMs: 1000 });
    expect(state.captions.overrides.textCase).toBe("uppercase");
    expect(resolveCaptionStyle(state.captions.presetId, state.captions.overrides).textCase).toBe(
      "uppercase",
    );
  });

  it("a stored clip that carries no case keeps its preset's", () => {
    // Nothing already made changes appearance: no case in the document means the preset decides.
    expect(resolveCaptionStyle("clean", {}).textCase).toBe("original");
    expect(resolveCaptionStyle("bold-serif", {}).textCase).toBe("original");
  });

  it("a legacy uppercase boolean still means uppercase", () => {
    expect(resolveCaptionStyle("clean", { uppercase: true }).textCase).toBe("uppercase");
    expect(resolveCaptionStyle("clean", { uppercase: false }).textCase).toBe("original");
  });

  it("offers all five cases through the schema", () => {
    for (const textCase of ["uppercase", "sentence", "title", "lowercase", "original"] as const) {
      const state = buildDefaultEditorState({ sourceVideoId: "v", startMs: 0, endMs: 1 });
      const parsed = editorStateSchema.parse({
        ...state,
        captions: { ...state.captions, overrides: { textCase } },
      });
      expect(parsed.captions.overrides.textCase).toBe(textCase);
    }
  });
});

describe("resolveCaptionStyle carries the new controls", () => {
  it("applies a font override", () => {
    expect(resolveCaptionStyle("clean", { fontFamily: "Georgia, serif" }).fontFamily).toBe(
      "Georgia, serif",
    );
  });

  it("applies a weight override", () => {
    expect(resolveCaptionStyle("clean", { weight: 300 }).weight).toBe(300);
  });

  it("applies outline, shadow and background overrides", () => {
    const style = resolveCaptionStyle("clean", { strokePx: 7, shadow: false, background: "pill" });
    expect(style.strokePx).toBe(7);
    expect(style.shadow).toBe(false);
    expect(style.background).toBe("pill");
  });

  it("falls back to the preset for anything not overridden", () => {
    const style = resolveCaptionStyle("highlighter", {});
    expect(style.weight).toBe(800);
    expect(style.fontFamily).toBe("Inter, system-ui, sans-serif");
  });
});

describe("a slider and its number field show one value", () => {
  it("shows the preset's value when nothing is overridden", () => {
    expect(displayedValue(undefined, 700)).toBe(700);
  });

  it("shows the override once there is one", () => {
    expect(displayedValue(300, 700)).toBe(300);
  });

  it("is synchronised when the slider matches what the field shows", () => {
    expect(isSynchronised(300, 300, 700)).toBe(true);
    expect(isSynchronised(700, undefined, 700)).toBe(true);
  });

  it("is not synchronised when they disagree", () => {
    expect(isSynchronised(300, 500, 700)).toBe(false);
    expect(isSynchronised(300, undefined, 700)).toBe(false);
  });

  it("clamps a typed value above the range", () => {
    expect(parseNumericInput("2000", WEIGHT, 400)).toBe(900);
  });

  it("clamps a typed value below the range", () => {
    expect(parseNumericInput("-40", SIZE, 44)).toBe(16);
  });

  it("accepts a value inside the range unchanged", () => {
    expect(parseNumericInput("500", WEIGHT, 400)).toBe(500);
  });

  it("treats an emptied field as no override, so the control returns to its preset", () => {
    expect(parseNumericInput("", WEIGHT, 400)).toBeUndefined();
    expect(parseNumericInput("   ", WEIGHT, 400)).toBeUndefined();
  });

  it("leaves the value alone for something unparseable", () => {
    expect(parseNumericInput("abc", WEIGHT, 400)).toBe(400);
  });

  it("clamps the displayed value even when a stored document is out of range", () => {
    expect(clampToRange(5000, SIZE)).toBe(160);
    expect(clampToRange(Number.NaN, SIZE)).toBe(16);
  });

  it("round-trips: what the field parses is what the slider shows", () => {
    for (const typed of ["100", "250", "900", "0", "1000"]) {
      const parsed = parseNumericInput(typed, WEIGHT, 400)!;
      expect(isSynchronised(clampToRange(parsed, WEIGHT), parsed, 700)).toBe(true);
    }
  });
});
