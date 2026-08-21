import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateAssSubtitles } from "@/lib/export/ass-generator";
import { getCaptionPreset } from "@/lib/editor/caption-presets";
import {
  buildCaptionLines,
  exclusiveLineSpans,
  type CaptionWord,
} from "@/lib/editor/caption-lines";
import { highlightSlices, resolveActiveWord } from "@/lib/editor/active-word";
import { POP, popScaleAt } from "@/lib/editor/caption-animation";
import { buildDefaultEditorState } from "@/lib/editor/types";
import { parseNumericInput } from "@/lib/editor/numeric-field";

/**
 * The corrections to Slice 7, written against the API as it stands so that every failure here is a
 * statement about behaviour rather than about a missing file.
 */

const LEGACY_PRESET_IDS = ["clean", "bold-serif", "karaoke", "quiet"] as const;

function words(spec: Array<[string, number, number]>): CaptionWord[] {
  return spec.map(([word, startMs, endMs], index) => ({ id: `w${index}`, word, startMs, endMs }));
}

const LINE_WORDS = words([
  ["peace", 0, 400],
  ["stays", 400, 800],
  ["with", 800, 1200],
]);

const ONE_LINE = [
  { id: "line-0", startMs: 0, endMs: 1200, text: "peace stays with", words: LINE_WORDS },
];

const dialogues = (ass: string) => ass.split("\n").filter((l) => l.startsWith("Dialogue: 0"));

const defaultStyleField = (ass: string, index: number) =>
  ass.split("\n").find((l) => l.startsWith("Style: Default"))!.split(",")[index];

// ── 1. Legacy presets keep the behaviour origin/main gave them ────────────────────────────────

describe("legacy presets are preserved", () => {
  it("renders every legacy preset with ASS Bold=0, as origin/main did", () => {
    for (const id of LEGACY_PRESET_IDS) {
      const ass = generateAssSubtitles(ONE_LINE, getCaptionPreset(id).style, 1080, 1920);
      expect(defaultStyleField(ass, 7), `${id} must not become bold`).toBe("0");
    }
  });

  it("leaves the browser weight unset for every legacy preset", () => {
    for (const id of LEGACY_PRESET_IDS) {
      expect(getCaptionPreset(id).style.weight, `${id} must carry no weight`).toBeUndefined();
    }
  });

  it("still honours an explicit weight override on a legacy preset", () => {
    const style = { ...getCaptionPreset("clean").style, weight: 800 };
    expect(defaultStyleField(generateAssSubtitles(ONE_LINE, style, 1080, 1920), 7)).toBe("-1");
  });

  it("gives Highlighter its own heavy default", () => {
    expect(getCaptionPreset("highlighter").style.weight).toBe(800);
    const ass = generateAssSubtitles(ONE_LINE, getCaptionPreset("highlighter").style, 1080, 1920);
    expect(defaultStyleField(ass, 7)).toBe("-1");
  });

  it("does not colour an active word for any legacy preset", () => {
    for (const id of LEGACY_PRESET_IDS) {
      const ass = generateAssSubtitles(ONE_LINE, getCaptionPreset(id).style, 1080, 1920);
      expect(ass, `${id} must not highlight a word`).not.toContain("\\c&H");
      expect(dialogues(ass), `${id} must render the line whole`).toHaveLength(1);
    }
  });

  it("colours an active word for Highlighter", () => {
    const ass = generateAssSubtitles(ONE_LINE, getCaptionPreset("highlighter").style, 1080, 1920);
    expect(dialogues(ass).length).toBeGreaterThan(1);
    expect(ass).toContain("\\c&H");
  });
});

// ── 2. The Highlighter pop, at rest spacing ───────────────────────────────────────────────────

describe("the Highlighter pop", () => {
  // The curve's shape and its parity with the burn-in are covered in
  // tests/caption-pop-nested-parity.test.ts, which reads the emitted tags back.
  it("rises monotonically to the peak", () => {
    const duration = 800;
    let previous = popScaleAt(0, duration);
    for (let ms = 1; ms <= POP.riseMs; ms += 1) {
      const value = popScaleAt(ms, duration);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
    expect(previous).toBeCloseTo(POP.peakScale, 5);
  });

  it("scales the active Highlighter word in the burn-in", () => {
    const ass = generateAssSubtitles(ONE_LINE, getCaptionPreset("highlighter").style, 1080, 1920);
    expect(ass).toContain("\\fscx");
    expect(ass).toContain("\\t(");
  });

  it("never scales a word for a legacy preset", () => {
    for (const id of LEGACY_PRESET_IDS) {
      const ass = generateAssSubtitles(ONE_LINE, getCaptionPreset(id).style, 1080, 1920);
      for (const tag of ["\\fscx", "\\fscy", "\\t(", "\\move("]) {
        expect(ass, `${id} must not carry ${tag}`).not.toContain(tag);
      }
    }
  });

  it("reserves no permanent spacing and moves no neighbour", () => {
    const ass = generateAssSubtitles(ONE_LINE, getCaptionPreset("highlighter").style, 1080, 1920);
    expect(ass).not.toContain("\\fsp");
    expect(ass).not.toContain("\\move(");
  });

  it("puts the pop on the active word only, never on its neighbours", () => {
    const ass = generateAssSubtitles(ONE_LINE, getCaptionPreset("highlighter").style, 1080, 1920);
    for (const event of dialogues(ass)) {
      // One transform per event at most: a phase that needs its own gets its own event. A hold
      // phase carries a static scale and no transform at all, which is why this is a ceiling
      // rather than an equality.
      const pops = event.split("\\t(0,").length - 1;
      expect(pops, "a word popped without being the active word").toBeLessThanOrEqual(1);
    }
  });
});

// ── 3. One active word across caption-line boundaries ─────────────────────────────────────────

describe("active words across line boundaries", () => {
  // Six words, so the split at five puts the overlap across the boundary. Word five runs long and
  // word six starts before it ends — which is what forced alignment actually emits.
  const OVERLAP = words([
    ["one", 0, 400],
    ["two", 400, 800],
    ["three", 800, 1200],
    ["four", 1200, 1600],
    ["five", 1600, 2600],
    ["six", 2400, 3000],
  ]);

  it("splits into two lines that do not overlap in time", () => {
    const lines = exclusiveLineSpans(buildCaptionLines(OVERLAP));
    expect(lines).toHaveLength(2);
    expect(lines[0].endMs).toBeLessThanOrEqual(lines[1].startMs);
  });

  it("shows exactly one caption line at the overlapping instant", () => {
    const onScreen = exclusiveLineSpans(buildCaptionLines(OVERLAP)).filter(
      (l) => 2500 >= l.startMs && 2500 < l.endMs,
    );
    expect(onScreen).toHaveLength(1);
  });

  it("resolves the same single active word in the preview and in the export", () => {
    const lines = exclusiveLineSpans(buildCaptionLines(OVERLAP));
    // The export's answer: the slice covering the instant, from every line's slices.
    const exportAnswer = (ms: number) => {
      for (const line of lines) {
        if (ms < line.startMs || ms >= line.endMs) continue;
        const slice = highlightSlices(line).find((s) => ms >= s.startMs && ms < s.endMs);
        return slice?.activeWordId ?? null;
      }
      return null;
    };
    // The preview's answer: the line on screen, resolved by the shared resolver.
    const previewAnswer = (ms: number) => {
      const line = lines.find((l) => ms >= l.startMs && ms < l.endMs);
      return line ? (resolveActiveWord(line.words, ms)?.id ?? null) : null;
    };

    for (let ms = 2200; ms <= 2800; ms += 25) {
      expect(previewAnswer(ms), `preview and export disagree at ${ms}ms`).toBe(exportAnswer(ms));
    }
    // And the boundary itself is word six, not word five running on from the previous line.
    expect(previewAnswer(2500)).toBe("w5");
  });

  it("never emits two caption events covering the same instant", () => {
    const ass = generateAssSubtitles(
      buildCaptionLines(OVERLAP),
      getCaptionPreset("highlighter").style,
      1080,
      1920,
    );
    const spans = dialogues(ass).map((event) => {
      const parts = event.split(",");
      return { start: parts[1], end: parts[2] };
    });
    for (let i = 1; i < spans.length; i += 1) {
      expect(spans[i].start >= spans[i - 1].end, `event ${i} overlaps event ${i - 1}`).toBe(true);
    }
  });
});

// ── 4. Off-step numeric input ─────────────────────────────────────────────────────────────────

describe("numeric input honours the step", () => {
  const WEIGHT = { min: 100, max: 900, step: 100 };

  it("snaps a typed off-step weight to the step the slider uses", () => {
    expect(parseNumericInput("350", WEIGHT, undefined)).toBe(400);
    expect(parseNumericInput("349", WEIGHT, undefined)).toBe(300);
    expect(parseNumericInput("351", WEIGHT, undefined)).toBe(400);
  });

  it("still clamps out-of-range values to the range", () => {
    expect(parseNumericInput("5000", WEIGHT, undefined)).toBe(900);
    expect(parseNumericInput("-20", WEIGHT, undefined)).toBe(100);
  });

  it("leaves a range without a step alone", () => {
    expect(parseNumericInput("37", { min: 0, max: 100 }, undefined)).toBe(37);
  });

  it("keeps an empty field meaning no override", () => {
    expect(parseNumericInput("", WEIGHT, 700)).toBeUndefined();
  });
});

// ── 5. Font choices that the render host actually has ─────────────────────────────────────────

describe("font choices are proven on the render host", () => {
  const dockerfile = () =>
    readFileSync(path.join(process.cwd(), "Dockerfile.worker"), "utf8");

  it("installs fonts in the worker image", () => {
    // The faces are copied in from the repository; tests/caption-fonts.test.ts covers which.
    expect(dockerfile()).toMatch(/COPY .*fonts/);
  });

  it("gates the build on the fonts actually resolving", () => {
    expect(dockerfile()).toMatch(/fc-match|fc-list/);
  });
});

// ── 6. Existing version-0 clips keep rendering what they rendered ─────────────────────────────

describe("existing version-0 clips are unchanged", () => {
  const defaults = () =>
    buildDefaultEditorState({ sourceVideoId: "v1", startMs: 0, endMs: 4000 });

  it("builds a default document with no case override", () => {
    expect(defaults().captions.overrides.textCase).toBeUndefined();
  });

  it("renders a version-0 Clean clip in its preset's case, not uppercase", () => {
    expect(defaults().captions.presetId).toBe("clean");
    const ass = generateAssSubtitles(ONE_LINE, getCaptionPreset("clean").style, 1080, 1920);
    expect(ass).toContain("peace stays with");
    expect(ass).not.toContain("PEACE STAYS WITH");
  });
});
