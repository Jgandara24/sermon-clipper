import { describe, expect, it } from "vitest";
import { applyBrandTemplateToState, type EditorBrandTemplate } from "@/components/editor/brand-template-panel";
import { buildLowerThird, parseLowerThird } from "@/lib/brand-template";
import { buildDefaultEditorState } from "@/lib/editor/types";

const TEMPLATE: EditorBrandTemplate = {
  id: "template-1",
  name: "Sunday Sermon",
  churchName: "First Baptist",
  speakerName: "Pastor Demo",
  primaryColor: "#0f766e",
  accentColor: "#facc15",
  captionPresetId: "bold-serif",
  lowerThird: { headline: "First Baptist", subhead: "Sunday message", showSpeaker: true },
};

describe("brand templates", () => {
  it("builds lower-third defaults from template input", () => {
    const lowerThird = buildLowerThird({
      name: "Sunday",
      churchName: "First Baptist",
      speakerName: "Pastor Demo",
      primaryColor: "#0f766e",
      accentColor: "#facc15",
      captionPresetId: "clean",
      lowerThirdHeadline: "",
      lowerThirdSubhead: "",
      isDefault: true,
    });

    expect(lowerThird).toEqual({
      headline: "First Baptist",
      subhead: "Pastor Demo",
      showSpeaker: true,
    });
  });

  it("parses malformed lower-third JSON to safe defaults", () => {
    expect(parseLowerThird({ headline: 12 })).toEqual({
      headline: "",
      subhead: "",
      showSpeaker: true,
    });
  });

  it("applies a template to editor state", () => {
    const state = buildDefaultEditorState({ sourceVideoId: "sv", startMs: 0, endMs: 10_000 });
    const next = applyBrandTemplateToState(state, TEMPLATE);

    expect(next.brandTemplateId).toBe("template-1");
    expect(next.captions.presetId).toBe("bold-serif");
    expect(next.captions.overrides.highlightColor).toBe("#facc15");
    expect(next.overlays).toContainEqual({
      type: "lowerThird",
      templateId: "template-1",
      startMs: 0,
      endMs: 4000,
    });
  });
});
