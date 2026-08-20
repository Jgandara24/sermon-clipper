import { describe, expect, it } from "vitest";
import { getCaptionPreset } from "@/lib/editor/caption-presets";
import { resolveCaptionStyle } from "@/lib/editor/caption-style";
import { applyTextCase, TEXT_CASES, type TextCase } from "@/lib/editor/text-case";
import { generateAssSubtitles } from "@/lib/export/ass-generator";

const LINE_TEXT = "peace is not the absence of trouble";
const LINES = [{ startMs: 0, endMs: 1200, text: LINE_TEXT }];

function dialogueText(textCase: TextCase): string {
  const style = { ...getCaptionPreset("clean").style, textCase };
  const ass = generateAssSubtitles(LINES, style, 1080, 1920);
  const dialogue = ass.split("\n").find((line) => line.startsWith("Dialogue:"))!;
  // Text is the last field, after the nine format fields.
  return dialogue.split(",").slice(9).join(",");
}

describe("the burn-in uses the shared transformation, for every option", () => {
  it.each([...TEXT_CASES])("renders %s exactly as applyTextCase does", (textCase) => {
    expect(dialogueText(textCase)).toBe(applyTextCase(LINE_TEXT, textCase));
  });

  it("produces visibly different text per option, so the choice is not cosmetic", () => {
    const rendered = new Set(TEXT_CASES.map((textCase) => dialogueText(textCase)));
    // original and lowercase coincide for this already-lowercase line; the rest differ.
    expect(rendered.size).toBeGreaterThanOrEqual(4);
  });
});

describe("resolveCaptionStyle — a clip saved before the case model", () => {
  const cleanPreset = getCaptionPreset("clean");
  const karaokePreset = getCaptionPreset("karaoke");

  it("keeps rendering upper-cased text when the old boolean was true", () => {
    const style = resolveCaptionStyle("clean", { uppercase: true });

    expect(style.textCase).toBe("uppercase");
    expect(applyTextCase(LINE_TEXT, style.textCase)).toBe(LINE_TEXT.toUpperCase());
  });

  it("keeps rendering untouched text when the old boolean was false", () => {
    // The clip may already be published. Defaulting it to Uppercase would change the video.
    const style = resolveCaptionStyle("clean", { uppercase: false });

    expect(style.textCase).toBe("original");
    expect(applyTextCase(LINE_TEXT, style.textCase)).toBe(LINE_TEXT);
  });

  it("keeps each preset's own case when the clip overrode nothing", () => {
    expect(resolveCaptionStyle("clean", {}).textCase).toBe(cleanPreset.style.textCase);
    expect(resolveCaptionStyle("karaoke", {}).textCase).toBe(karaokePreset.style.textCase);
  });

  it("still upper-cases the preset that always did", () => {
    // The karaoke preset carried uppercase: true before the model existed.
    expect(resolveCaptionStyle("karaoke", {}).textCase).toBe("uppercase");
  });

  it("lets an explicit case supersede the old boolean once the clip is re-saved", () => {
    const style = resolveCaptionStyle("clean", { textCase: "title", uppercase: true });

    expect(style.textCase).toBe("title");
  });

  it("carries every option through to the resolved style", () => {
    for (const textCase of TEXT_CASES) {
      expect(resolveCaptionStyle("clean", { textCase }).textCase).toBe(textCase);
    }
  });

  it("leaves the other overrides alone", () => {
    const style = resolveCaptionStyle("clean", { textCase: "lowercase", sizePx: 60 });

    expect(style.sizePx).toBe(60);
    expect(style.position).toBe(cleanPreset.style.position);
    expect(style.highlightColor).toBe(cleanPreset.style.highlightColor);
  });
});
