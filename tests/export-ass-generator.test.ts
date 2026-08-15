import { describe, expect, it } from "vitest";
import { generateAssSubtitles, hexToAssColor } from "@/lib/export/ass-generator";
import { buildCaptionLines, type CaptionWord } from "@/lib/editor/caption-lines";
import { getCaptionPreset, type CaptionStyle } from "@/lib/editor/caption-presets";
import { POP_IN_MS, POP_SETTLE_MS } from "@/lib/editor/caption-animation";
import type { TextMeasurer } from "@/lib/editor/caption-layout";

// Deterministic fake measurer — geometry assertions never depend on real font files.
const measure: TextMeasurer = (text, fontPx) => text.length * (fontPx / 4);

function words(...specs: Array<[string, number, number]>): CaptionWord[] {
  return specs.map(([text, startMs, endMs], i) => ({ id: `s:${i}`, word: text, startMs, endMs }));
}

const LINES = buildCaptionLines([
  ...words(["peace", 0, 600], ["is", 600, 800], ["not", 800, 1200]),
]);

function generate(style: CaptionStyle, lines = LINES, lowerThird?: Parameters<typeof generateAssSubtitles>[0]["lowerThird"]) {
  return generateAssSubtitles({
    lines,
    style,
    videoWidth: 1080,
    videoHeight: 1920,
    measure,
    lowerThird,
  });
}

function dialogues(ass: string): string[] {
  return ass.split("\n").filter((line) => line.startsWith("Dialogue:"));
}

describe("generateAssSubtitles", () => {
  it("emits script info sized to the output frame", () => {
    const ass = generate(getCaptionPreset("clean").style);
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("PlayResY: 1920");
  });

  it("positions every word event absolutely — no \\k tags anywhere", () => {
    const ass = generate(getCaptionPreset("kinetic").style);
    for (const event of dialogues(ass)) {
      expect(event).toContain("\\an5\\pos(");
      expect(event).toContain("\\q2\\fsp0");
    }
    expect(ass).not.toMatch(/\\k[f0-9]/);
  });

  it("emits one event per word for non-animating presets, spanning the whole line", () => {
    const ass = generate(getCaptionPreset("clean").style);
    const events = dialogues(ass);
    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(event).toContain("0:00:00.00,0:00:01.20");
    }
  });

  it("splits animated words into base-before / active / base-after with no overlap", () => {
    const ass = generate({ ...getCaptionPreset("kinetic").style, background: "none" });
    const events = dialogues(ass);
    // word 0 (starts at line start): active + after = 2; word 1 (interior): 3; word 2 (ends
    // at line end): before + active = 2
    expect(events).toHaveLength(7);

    const active = events.filter((e) => e.startsWith("Dialogue: 1,"));
    expect(active).toHaveLength(3);
    // the middle word's active window is exactly its spoken time
    expect(active[1]).toContain("0:00:00.60,0:00:00.80");
    // base events for the middle word never overlap its active window
    const middleBases = events.filter((e) => e.includes("IS") && e.startsWith("Dialogue: 0,"));
    expect(middleBases[0]).toContain("0:00:00.00,0:00:00.60");
    expect(middleBases[1]).toContain("0:00:00.80,0:00:01.20");
  });

  it("ends the prior active event when the next spoken word starts", () => {
    const lines = buildCaptionLines(words(["first", 0, 800], ["second", 400, 1000]));
    const active = dialogues(
      generate({ ...getCaptionPreset("kinetic").style, background: "none" }, lines),
    ).filter((event) => event.startsWith("Dialogue: 1,"));

    expect(active[0]).toContain("0:00:00.00,0:00:00.40");
    expect(active[1]).toContain("0:00:00.40,0:00:01.00");
  });

  it("animates the active word with the shared two-phase pop curve", () => {
    const style = getCaptionPreset("kinetic").style; // highlightScale 1.14
    const ass = generate(style);
    const overshoot = Math.round((1 + (style.highlightScale - 1) * 1.5) * 100);
    const rest = Math.round(style.highlightScale * 100);

    expect(ass).toContain(
      `\\t(0,${POP_IN_MS},0.6,\\fscx${overshoot}\\fscy${overshoot})\\t(${POP_IN_MS},${POP_IN_MS + POP_SETTLE_MS},1.4,\\fscx${rest}\\fscy${rest})`,
    );
    expect(ass).toContain(`\\1c${hexToAssColor(style.highlightColor)}`);
  });

  it("swaps color without scaling when highlightScale is 1", () => {
    const style = { ...getCaptionPreset("kinetic").style, highlightScale: 1 };
    const ass = generate(style);
    expect(ass).not.toContain("\\t(");
    expect(ass).toContain(`\\1c${hexToAssColor(style.highlightColor)}`);
  });

  it("uppercases word text for uppercase styles", () => {
    const ass = generate(getCaptionPreset("kinetic").style);
    expect(ass).toContain("}PEACE");
    expect(ass).not.toContain("}peace");
  });

  it("draws one pill rectangle per row for pill backgrounds", () => {
    const ass = generate(getCaptionPreset("karaoke").style);
    const boxes = dialogues(ass).filter((e) => e.includes("CaptionBox"));
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toContain("\\p1}m 0 0 l ");
    expect(boxes[0]).toContain("\\an7\\pos(");
  });

  it("derives the ASS Fontname and Bold flag from the font registry", () => {
    const kinetic = generate(getCaptionPreset("kinetic").style); // Poppins weight 800
    expect(kinetic).toContain("Style: Caption,Poppins ExtraBold,");

    const serif = generate(getCaptionPreset("bold-serif").style); // Source Serif 600
    expect(serif).toContain("Style: Caption,Source Serif 4 Semibold,");
  });

  it("converts hex colors into ASS &H00BBGGRR order", () => {
    expect(hexToAssColor("#FFD34D")).toBe("&H004DD3FF");
    const ass = generate(getCaptionPreset("clean").style);
    expect(ass).toContain("&H00FFFFFF");
  });

  it("escapes ASS override-block braces in caption text", () => {
    const lines = buildCaptionLines(words(["he", 0, 200], ["said", 200, 400], ["{this}", 400, 800]));
    const ass = generate({ ...getCaptionPreset("clean").style, uppercase: false }, lines);
    expect(ass).not.toContain("{this}");
    expect(ass).toContain("(this)");
  });

  it("skips events below the ASS centisecond floor", () => {
    const lines = buildCaptionLines(words(["blip", 0, 4]));
    const ass = generate(getCaptionPreset("kinetic").style, lines);
    expect(dialogues(ass)).toHaveLength(0);
  });

  it("emits a lower-third dialogue event when brand data is provided", () => {
    const ass = generate(getCaptionPreset("clean").style, LINES, {
      headline: "First Baptist",
      subhead: "Sunday message",
      primaryColor: "#0f766e",
      accentColor: "#facc15",
      startMs: 0,
      endMs: 4000,
    });

    expect(ass).toContain("Style: LowerThird");
    expect(ass).toContain("Dialogue: 1,0:00:00.00,0:00:04.00,LowerThird");
    expect(ass).toContain("First Baptist\\NSunday message");
  });
});
