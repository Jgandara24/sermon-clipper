import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getCaptionPreset } from "@/lib/editor/caption-presets";
import type { CaptionWord } from "@/lib/editor/caption-lines";
import { generateAssSubtitles, type AssCaptionLine } from "@/lib/export/ass-generator";
import { resolveCaptionFace } from "@/lib/editor/caption-face";
import { createCaptionMeasurer } from "@/lib/export/font-metrics";
import type { CaptionStyle } from "@/lib/editor/caption-presets";

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

/** A line of long words: 1242px against 1000px of usable frame, so it has to wrap. */
const OVERFLOWING_LINE: AssCaptionLine[] = [
  {
    id: "line-wide",
    startMs: 0,
    endMs: 2400,
    text: "everlasting righteousness throughout",
    words: words(
      [
        ["everlasting", 0, 800],
        ["righteousness", 800, 1600],
        ["throughout", 1600, 2400],
      ],
      "line-wide",
    ),
  },
];

type Scenario = {
  fixture: string;
  presetId: string;
  lines: AssCaptionLine[];
  lowerThird?: typeof LOWER_THIRD | null;
  /** Measure the text and give each word its own position, as the worker does. */
  measured?: boolean;
  styleOverrides?: Partial<CaptionStyle>;
};

function measurerFor(style: CaptionStyle) {
  const face = resolveCaptionFace(style);
  const measurer = createCaptionMeasurer({
    family: face.family,
    bold: face.bold,
    sizePx: style.sizePx,
  });
  return { measure: measurer.measure, spaceWidth: measurer.spaceWidth };
}

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
  {
    fixture: "highlighter-perword-onerow.ass",
    presetId: "highlighter",
    lines: LINES_WITH_WORDS,
    measured: true,
  },
  {
    fixture: "highlighter-perword-wrapped.ass",
    presetId: "highlighter",
    lines: OVERFLOWING_LINE,
    measured: true,
  },
  {
    fixture: "highlighter-perword-dragged.ass",
    presetId: "highlighter",
    lines: OVERFLOWING_LINE,
    measured: true,
    styleOverrides: { box: { xPct: 0.5, yPct: 0.42 } },
  },
];

function styleFor(scenario: Scenario): CaptionStyle {
  return { ...getCaptionPreset(scenario.presetId).style, ...scenario.styleOverrides };
}

function render(scenario: Scenario): string {
  const style = styleFor(scenario);
  return generateAssSubtitles(
    scenario.lines,
    style,
    OUTPUT_WIDTH,
    OUTPUT_HEIGHT,
    scenario.lowerThird ?? null,
    scenario.measured ? measurerFor(style) : null,
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

describe("per-word positioning is applied only where it can be done honestly", () => {
  it("leaves Clean exactly as it was, even when a measurer is offered", () => {
    // Clean does not highlight, and its stack asks for a face this repository does not ship.
    // Handing it a measurer must change nothing: a clip a church approved renders as it did.
    const style = getCaptionPreset("clean").style;
    const withMeasurer = generateAssSubtitles(
      LINES_WITH_WORDS,
      style,
      OUTPUT_WIDTH,
      OUTPUT_HEIGHT,
      null,
      { measure: () => 100, spaceWidth: 10 },
    );

    expect(withMeasurer).toBe(readFileSync(path.join(FIXTURE_DIR, "clean-with-words.ass"), "utf8"));
  });

  it("leaves Highlighter as it was when no measurer is available", () => {
    // No bundled face, no honest measurement, so the run goes to libass exactly as before.
    const withoutMeasurer = generateAssSubtitles(
      LINES_WITH_WORDS,
      getCaptionPreset("highlighter").style,
      OUTPUT_WIDTH,
      OUTPUT_HEIGHT,
      null,
      null,
    );

    expect(withoutMeasurer).toBe(
      readFileSync(path.join(FIXTURE_DIR, "highlighter-with-words.ass"), "utf8"),
    );
  });

  it("gives every word its own position once measured", () => {
    const style = getCaptionPreset("highlighter").style;
    const ass = generateAssSubtitles(
      LINES_WITH_WORDS,
      style,
      OUTPUT_WIDTH,
      OUTPUT_HEIGHT,
      null,
      measurerFor(style),
    );
    const dialogue = ass.split("\n").filter((line) => line.startsWith("Dialogue:"));

    expect(dialogue.every((line) => line.includes("\\pos("))).toBe(true);
    // One event per word at least, rather than one per phase carrying the whole run.
    expect(dialogue.length).toBeGreaterThan(7);
  });

  it("anchors an undragged caption to the bottom, with rows growing upward", () => {
    const style = getCaptionPreset("highlighter").style;
    const ass = generateAssSubtitles(
      OVERFLOWING_LINE,
      style,
      OUTPUT_WIDTH,
      OUTPUT_HEIGHT,
      null,
      measurerFor(style),
    );

    const ys = [...ass.matchAll(/\\an2\\pos\(\d+,(\d+)\)/g)].map((match) => Number(match[1]));
    const rows = [...new Set(ys)].sort((a, b) => a - b);

    // Two rows, one font size apart, the lower one on the margin line the style already states.
    expect(rows).toHaveLength(2);
    expect(rows[1] - rows[0]).toBe(style.sizePx);
    expect(rows[1]).toBe(OUTPUT_HEIGHT - Math.round(OUTPUT_HEIGHT * 0.12));
  });

  it("centres a dragged caption's rows on the point it was dragged to", () => {
    const style: CaptionStyle = {
      ...getCaptionPreset("highlighter").style,
      box: { xPct: 0.5, yPct: 0.42 },
    };
    const ass = generateAssSubtitles(
      OVERFLOWING_LINE,
      style,
      OUTPUT_WIDTH,
      OUTPUT_HEIGHT,
      null,
      measurerFor(style),
    );

    const ys = [...ass.matchAll(/\\an5\\pos\(\d+,(\d+)\)/g)].map((match) => Number(match[1]));
    const rows = [...new Set(ys)].sort((a, b) => a - b);

    expect(rows).toHaveLength(2);
    // Within half a pixel: a subtitle position is a whole number, so each row's own y is rounded.
    expect((rows[0] + rows[1]) / 2).toBeCloseTo(0.42 * OUTPUT_HEIGHT, 0);
  });

  it("keeps every word inside the frame on a line that used to overflow", () => {
    const style = getCaptionPreset("highlighter").style;
    const face = resolveCaptionFace(style);
    const measurer = createCaptionMeasurer({
      family: face.family,
      bold: face.bold,
      sizePx: style.sizePx,
    });
    const ass = generateAssSubtitles(
      OVERFLOWING_LINE,
      style,
      OUTPUT_WIDTH,
      OUTPUT_HEIGHT,
      null,
      { measure: measurer.measure, spaceWidth: measurer.spaceWidth },
    );

    // Without wrapping this same line ran from x -81 to x 1161 and was clipped on both sides.
    for (const match of ass.matchAll(/\\pos\((\d+),\d+\)\}(?:\{[^}]*\})*([^\n]+)/g)) {
      const centre = Number(match[1]);
      const half = measurer.measure(match[2]) / 2;
      expect(centre - half).toBeGreaterThanOrEqual(0);
      expect(centre + half).toBeLessThanOrEqual(OUTPUT_WIDTH);
    }
  });
});
