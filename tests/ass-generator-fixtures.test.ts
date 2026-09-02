import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getCaptionPreset } from "@/lib/editor/caption-presets";
import type { CaptionWord } from "@/lib/editor/caption-lines";
import { generateAssSubtitles, type AssCaptionLine } from "@/lib/export/ass-generator";

/**
 * The regression net for Slice 8.
 *
 * Slice 8 restructures how caption events are emitted: today one Dialogue event carries a whole
 * run of words and libass lays them out, and afterwards each word carries its own position. That
 * is a rewrite of the generator's output, and the risk it carries is silent — a clip a church
 * already approved would render differently and nothing would say so.
 *
 * So the exact bytes are recorded here first, before the generator is touched.
 *
 *  - **Clean is a guarantee.** It does not highlight, it predates every part of this work, and its
 *    output must survive the restructuring byte for byte. If this fixture moves, a legacy clip's
 *    render moved with it, and that is a defect until proven otherwise.
 *  - **Highlighter is a tripwire.** Its output is expected to change when words gain their own
 *    positions. The fixture is here so the change is deliberate and reviewable in a diff, not
 *    discovered later in a rendered file.
 *
 * To accept a change, run the suite with `UPDATE_ASS_FIXTURES=1` and commit the diff, with the
 * reason. Regenerating without reading the diff defeats the whole point of this file.
 */

const FIXTURE_DIR = path.join(__dirname, "fixtures", "ass");

const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1920;

function words(spec: Array<[string, number, number]>, linePrefix: string): CaptionWord[] {
  return spec.map(([word, startMs, endMs], index) => ({
    id: `${linePrefix}:${index}`,
    word,
    startMs,
    endMs,
  }));
}

/** Two lines that carry their words, so a highlighting preset has something to light. */
const LINES_WITH_WORDS: AssCaptionLine[] = [
  {
    id: "line-a",
    startMs: 0,
    endMs: 1200,
    text: "peace is not the absence",
    words: words(
      [
        ["peace", 0, 240],
        ["is", 240, 460],
        ["not", 460, 700],
        ["the", 700, 900],
        ["absence", 900, 1200],
      ],
      "line-a",
    ),
  },
  {
    id: "line-b",
    startMs: 1200,
    endMs: 2400,
    text: "of trouble.",
    words: words(
      [
        ["of", 1200, 1600],
        ["trouble.", 1600, 2400],
      ],
      "line-b",
    ),
  },
];

/** A line the member retyped: it no longer spells out its words. */
const LINE_WITHOUT_WORDS: AssCaptionLine[] = [
  { id: "line-c", startMs: 0, endMs: 1500, text: "he never leaves" },
];

const LOWER_THIRD = {
  headline: "Grace Community Church",
  subhead: "Pastor Dan Reyes",
  primaryColor: "#0F766E",
  accentColor: "#FACC15",
  startMs: 0,
  endMs: 4000,
};

type Scenario = {
  fixture: string;
  presetId: string;
  lines: AssCaptionLine[];
  lowerThird?: typeof LOWER_THIRD | null;
};

const SCENARIOS: Scenario[] = [
  { fixture: "clean-with-words.ass", presetId: "clean", lines: LINES_WITH_WORDS },
  { fixture: "clean-retyped-line.ass", presetId: "clean", lines: LINE_WITHOUT_WORDS },
  {
    fixture: "clean-with-lower-third.ass",
    presetId: "clean",
    lines: LINES_WITH_WORDS,
    lowerThird: LOWER_THIRD,
  },
  { fixture: "highlighter-with-words.ass", presetId: "highlighter", lines: LINES_WITH_WORDS },
  { fixture: "highlighter-retyped-line.ass", presetId: "highlighter", lines: LINE_WITHOUT_WORDS },
];

function render(scenario: Scenario): string {
  return generateAssSubtitles(
    scenario.lines,
    getCaptionPreset(scenario.presetId).style,
    OUTPUT_WIDTH,
    OUTPUT_HEIGHT,
    scenario.lowerThird ?? null,
  );
}

describe("the ASS generator's exact output, recorded before Slice 8 restructures it", () => {
  for (const scenario of SCENARIOS) {
    it(`renders ${scenario.fixture} byte for byte`, () => {
      const actual = render(scenario);
      const fixturePath = path.join(FIXTURE_DIR, scenario.fixture);

      if (process.env.UPDATE_ASS_FIXTURES === "1") {
        writeFileSync(fixturePath, actual, "utf8");
      }

      expect(actual).toBe(readFileSync(fixturePath, "utf8"));
    });
  }

  it("covers both presets the picker offers", () => {
    const covered = new Set(SCENARIOS.map((scenario) => scenario.presetId));
    expect([...covered].sort()).toEqual(["clean", "highlighter"]);
  });

  it("records a Clean render that draws its line whole, with no per-word tags", () => {
    // The property the Clean fixture exists to protect, stated so a reader does not have to
    // reverse it out of the bytes: Clean lights nothing, so one line is one event.
    const dialogue = render(SCENARIOS[0])
      .split("\n")
      .filter((line) => line.startsWith("Dialogue:"));

    expect(dialogue).toHaveLength(2);
    expect(dialogue.join("\n")).not.toContain("\\t(");
  });

  it("records a Highlighter render that lights one word at a time", () => {
    const dialogue = render(SCENARIOS[3])
      .split("\n")
      .filter((line) => line.startsWith("Dialogue:"));

    expect(dialogue.length).toBeGreaterThan(2);
    expect(dialogue.join("\n")).toContain("\\t(");
  });
});
