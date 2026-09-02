import { describe, expect, it } from "vitest";
import { countCaptionDialogueEvents } from "@/lib/export/ass-generator";

const HEADER = [
  "[Events]",
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
].join("\n");

describe("countCaptionDialogueEvents", () => {
  it("counts nothing in a script with no events", () => {
    expect(countCaptionDialogueEvents(`${HEADER}\n`)).toBe(0);
  });

  it("counts one event per caption dialogue line", () => {
    const script = [
      HEADER,
      "Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,hello",
      "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,world",
    ].join("\n");

    expect(countCaptionDialogueEvents(script)).toBe(2);
  });

  it("does not count the lower third as a caption", () => {
    // The lower third is a Dialogue event in its own style. Counting it would report a caption
    // on a clip whose captions were never drawn, which is the exact defect QC is looking for.
    const script = [
      HEADER,
      "Dialogue: 1,0:00:00.00,0:00:04.00,LowerThird,,0,0,0,,Grace Church\\NPastor",
    ].join("\n");

    expect(countCaptionDialogueEvents(script)).toBe(0);
  });

  it("counts captions alongside a lower third", () => {
    const script = [
      HEADER,
      "Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,hello",
      "Dialogue: 1,0:00:00.00,0:00:04.00,LowerThird,,0,0,0,,Grace Church\\NPastor",
    ].join("\n");

    expect(countCaptionDialogueEvents(script)).toBe(1);
  });

  it("ignores the style definition lines in the header", () => {
    const script = ["Style: Default,Inter,64", HEADER].join("\n");

    expect(countCaptionDialogueEvents(script)).toBe(0);
  });

  it("reads a script with carriage returns", () => {
    const script = `${HEADER}\r\nDialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,hello\r\n`;

    expect(countCaptionDialogueEvents(script)).toBe(1);
  });
});
