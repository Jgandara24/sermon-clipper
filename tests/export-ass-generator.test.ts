import { describe, expect, it } from "vitest";
import { generateAssSubtitles } from "@/lib/export/ass-generator";
import { getCaptionPreset } from "@/lib/editor/caption-presets";
import { resolveActiveWord } from "@/lib/editor/active-word";
import type { CaptionWord } from "@/lib/editor/caption-lines";

/** The colour override tag libass expects: &H00BBGGRR, byte-reversed from the stored hex. */
function assColourTag(hex: string): string {
  const clean = hex.replace("#", "");
  const [r, g, b] = [clean.slice(0, 2), clean.slice(2, 4), clean.slice(4, 6)];
  return `{\\c&H00${`${b}${g}${r}`.toUpperCase()}`;
}

const LINES = [
  { startMs: 0, endMs: 1200, text: "peace is not the absence" },
  { startMs: 1200, endMs: 2400, text: "of trouble." },
];

describe("generateAssSubtitles", () => {
  it("emits script info sized to the output frame", () => {
    const ass = generateAssSubtitles(LINES, getCaptionPreset("clean").style, 1080, 1920);
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("PlayResY: 1920");
  });

  it("emits one Dialogue line per caption line with correct timestamps", () => {
    const ass = generateAssSubtitles(LINES, getCaptionPreset("clean").style, 1080, 1920);
    const dialogueLines = ass.split("\n").filter((line) => line.startsWith("Dialogue:"));
    expect(dialogueLines).toHaveLength(2);
    expect(dialogueLines[0]).toContain("0:00:00.00,0:00:01.20");
    expect(dialogueLines[1]).toContain("0:00:01.20,0:00:02.40");
  });

  it("uppercases text for a preset whose case is Uppercase", () => {
    const ass = generateAssSubtitles(LINES, getCaptionPreset("karaoke").style, 1080, 1920);
    expect(ass).toContain("PEACE IS NOT THE ABSENCE");
    expect(ass).not.toContain("peace is not the absence");
  });

  it("uses bottom-center alignment (2) for bottom/center presets", () => {
    const ass = generateAssSubtitles(LINES, getCaptionPreset("clean").style, 1080, 1920);
    const styleLine = ass.split("\n").find((line) => line.startsWith("Style: Default"));
    expect(styleLine).toBeDefined();
    const fields = styleLine!.split(",");
    // Alignment is field index 18 in the Format list (0-indexed after "Style: Default").
    expect(fields[18]).toBe("2");
  });

  it("uses middle-center alignment (5) for the karaoke preset's middle position", () => {
    const ass = generateAssSubtitles(LINES, getCaptionPreset("karaoke").style, 1080, 1920);
    const styleLine = ass.split("\n").find((line) => line.startsWith("Style: Default"));
    const fields = styleLine!.split(",");
    expect(fields[18]).toBe("5");
  });

  it("converts hex colors into ASS &H00BBGGRR order", () => {
    const ass = generateAssSubtitles(LINES, getCaptionPreset("clean").style, 1080, 1920);
    // clean preset textColor is #FFFFFF -> &H00FFFFFF
    expect(ass).toContain("&H00FFFFFF");
  });

  it("escapes ASS override-block braces in caption text", () => {
    const ass = generateAssSubtitles(
      [{ startMs: 0, endMs: 1000, text: "he said {this}" }],
      getCaptionPreset("clean").style,
      1080,
      1920,
    );
    expect(ass).not.toContain("{this}");
    expect(ass).toContain("(this)");
  });

  it("emits a lower-third dialogue event when brand data is provided", () => {
    const ass = generateAssSubtitles(LINES, getCaptionPreset("clean").style, 1080, 1920, {
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
  describe("a caption the member dragged", () => {
    const dragged = { ...getCaptionPreset("clean").style, box: { xPct: 0.25, yPct: 0.4 } };

    it("burns in at the exact point it was dropped", () => {
      const ass = generateAssSubtitles(LINES, dragged, 1080, 1920);
      // 0.25 * 1080 = 270, 0.4 * 1920 = 768.
      expect(ass).toContain("\\pos(270,768)");
    });

    it("centres the text on that point, so the preview and the render agree", () => {
      const ass = generateAssSubtitles(LINES, dragged, 1080, 1920);
      expect(ass).toContain("{\\an5\\pos(270,768)}");
    });

    it("positions every caption line, not just the first", () => {
      const ass = generateAssSubtitles(LINES, dragged, 1080, 1920);
      const positioned = ass
        .split("\n")
        .filter((line) => line.startsWith("Dialogue: 0") && line.includes("\\pos("));
      expect(positioned).toHaveLength(2);
    });

    it("still renders the words themselves", () => {
      const ass = generateAssSubtitles(LINES, dragged, 1080, 1920);
      expect(ass).toContain("peace is not the absence");
    });

    it("emits no position tag at all when nothing was dragged", () => {
      const ass = generateAssSubtitles(LINES, getCaptionPreset("clean").style, 1080, 1920);
      // Every clip made before direct manipulation must render exactly as it always did.
      expect(ass).not.toContain("\\pos(");
      expect(ass).not.toContain("\\an5");
    });

    it("treats an explicitly absent box the same as no box", () => {
      const ass = generateAssSubtitles(
        LINES,
        { ...getCaptionPreset("clean").style, box: null },
        1080,
        1920,
      );
      expect(ass).not.toContain("\\pos(");
    });
  });

  describe("editing guides never reach a render", () => {
    it("carries no safe-zone, centre-guide, or selection markup", () => {
      const ass = generateAssSubtitles(
        LINES,
        { ...getCaptionPreset("clean").style, box: { xPct: 0.5, yPct: 0.8 } },
        1080,
        1920,
      );
      // The guides and handles are DOM in the editor and have no representation here at all.
      for (const marker of ["safe-zone", "safe zone", "centre-guide", "canvas-handle", "ALL CAPTIONS"]) {
        expect(ass).not.toContain(marker);
      }
    });

    it("emits only caption dialogue events", () => {
      const ass = generateAssSubtitles(
        LINES,
        { ...getCaptionPreset("clean").style, box: { xPct: 0.5, yPct: 0.8 } },
        1080,
        1920,
      );
      const events = ass.split("\n").filter((line) => line.startsWith("Dialogue:"));
      expect(events).toHaveLength(LINES.length);
    });
  });
});

describe("per-word highlighting", () => {
  const WORDS: CaptionWord[] = [
    { id: "w0", word: "peace", startMs: 0, endMs: 400 },
    { id: "w1", word: "stays", startMs: 400, endMs: 900 },
    { id: "w2", word: "here", startMs: 900, endMs: 1200 },
  ];
  const LINE = { id: "line-0", startMs: 0, endMs: 1200, text: "peace stays here", words: WORDS };
  const style = getCaptionPreset("highlighter").style;
  // ASS colours are &H00BBGGRR — the reverse of the hex the editor stores. Derived rather than
  // written out, so this states "the highlight colour" and not one particular spelling of it.
  const HIGHLIGHT_TAG = assColourTag(style.highlightColor);
  const TEXT_TAG = assColourTag(style.textColor);

  function dialogue(ass: string) {
    return ass.split("\n").filter((line) => line.startsWith("Dialogue: 0"));
  }

  it("emits events per highlight stretch, not one per line", () => {
    // Each stretch is drawn as a run of events, one per phase of the pop, because libass gives no
    // agreed meaning to two transforms over one property. Three words, so three stretches.
    const events = dialogue(generateAssSubtitles([LINE], style, 1080, 1920));
    const highlighted = new Set(
      events.map((event) => new RegExp(`${HIGHLIGHT_TAG}}([A-Z]+)`).exec(event)?.[1]),
    );
    expect(highlighted).toEqual(new Set(["PEACE", "STAYS", "HERE"]));
    expect(events.length).toBeGreaterThanOrEqual(3);
  });

  it("colours exactly one word in each event", () => {
    for (const event of dialogue(generateAssSubtitles([LINE], style, 1080, 1920))) {
      // One switch to the highlight colour per event means one highlighted word.
      const highlights = event.split(HIGHLIGHT_TAG).length - 1;
      expect(highlights).toBe(1);
    }
  });

  it("carries every word of the line in every event", () => {
    for (const event of dialogue(generateAssSubtitles([LINE], style, 1080, 1920))) {
      for (const word of ["PEACE", "STAYS", "HERE"]) {
        expect(event).toContain(word);
      }
    }
  });

  it("highlights the word the preview would highlight at the same instant", () => {
    const events = dialogue(generateAssSubtitles([LINE], style, 1080, 1920));
    const assMs = (stamp: string) => {
      const [h, m, rest] = stamp.split(":");
      const [sec, cs] = rest.split(".");
      return ((Number(h) * 60 + Number(m)) * 60 + Number(sec)) * 1000 + Number(cs) * 10;
    };
    for (const ms of [0, 200, 500, 700, 1000, 1150]) {
      const event = events.find((e) => {
        const parts = e.split(",");
        return ms >= assMs(parts[1]) && ms < assMs(parts[2]);
      })!;
      // The highlighted word is the one immediately after the colour switch.
      const highlighted = new RegExp(`${HIGHLIGHT_TAG}}([A-Z]+)`).exec(event)![1];
      expect(highlighted, `at ${ms}ms`).toBe(resolveActiveWord(WORDS, ms)!.word.toUpperCase());
    }
  });

  it("restores the text colour after the highlighted word", () => {
    const event = dialogue(generateAssSubtitles([LINE], style, 1080, 1920))[0];
    expect(event).toContain(TEXT_TAG);
  });

  it("applies the caption's case to each word, not just to the line", () => {
    const ass = generateAssSubtitles([LINE], style, 1080, 1920);
    expect(ass).toContain("PEACE");
    expect(ass).not.toContain("peace");
  });

  it("renders a line with no words as one plain event", () => {
    const plain = { startMs: 0, endMs: 1200, text: "peace stays here" };
    const events = dialogue(generateAssSubtitles([plain], style, 1080, 1920));
    expect(events).toHaveLength(1);
    expect(events[0]).not.toContain(HIGHLIGHT_TAG);
  });

  it("times a retyped line by its own tokens, rather than going dead", () => {
    // Its words no longer spell the text, so there is nothing to match a highlight to. The line's
    // span is divided among the tokens as typed instead — one lit token throughout, not none.
    const retyped = { ...LINE, text: "something else entirely" };
    const events = dialogue(generateAssSubtitles([retyped], style, 1080, 1920));
    const highlighted = new Set(
      events.map((event) => new RegExp(`${HIGHLIGHT_TAG}}([A-Z]+)`).exec(event)?.[1]),
    );
    expect(highlighted).toEqual(new Set(["SOMETHING", "ELSE", "ENTIRELY"]));
    for (const event of events) {
      // Every token is on screen in every event; the tags in between are what lights one of them.
      for (const token of ["SOMETHING", "ELSE", "ENTIRELY"]) {
        expect(event).toContain(token);
      }
      expect(event.split("\\c&H").length - 1, "an event lights no token").toBeGreaterThan(0);
    }
  });

  it("covers the line end to end", () => {
    const events = dialogue(generateAssSubtitles([LINE], style, 1080, 1920));
    expect(events[0]).toContain("0:00:00.00");
    expect(events[events.length - 1]).toContain("0:00:01.20");
  });
});

describe("rest spacing", () => {
  it("reserves no permanent room and moves no neighbour, while the active word pops", () => {
    const WORDS: CaptionWord[] = [
      { id: "w0", word: "peace", startMs: 0, endMs: 400 },
      { id: "w1", word: "stays", startMs: 400, endMs: 900 },
    ];
    const ass = generateAssSubtitles(
      [{ id: "l", startMs: 0, endMs: 900, text: "peace stays", words: WORDS }],
      getCaptionPreset("highlighter").style,
      1080,
      1920,
    );
    // Slice 8 owns the neighbour micro-shift: `\fsp` would widen the line permanently and
    // `\move` would slide a word. Slice 7 owns the pop itself, so the scale tags belong here.
    for (const tag of ["\\fsp", "\\move("]) {
      expect(ass, `${tag} is Slice 8's, not Slice 7's`).not.toContain(tag);
    }
    expect(ass).toContain("\\fscx");
    expect(ass).toContain("\\t(");

    // Exactly one word pops per event, and only the one that is active.
    for (const event of ass.split("\n").filter((l) => l.startsWith("Dialogue: 0"))) {
      expect(event.split("\\t(0,").length - 1).toBeLessThanOrEqual(1);
    }
  });

  it("lays out a line with no active word exactly like one with an active word", () => {
    const WORDS: CaptionWord[] = [
      { id: "w0", word: "peace", startMs: 0, endMs: 200 },
      { id: "w1", word: "stays", startMs: 900, endMs: 1100 },
    ];
    const events = generateAssSubtitles(
      [{ id: "l", startMs: 0, endMs: 1100, text: "peace stays", words: WORDS }],
      getCaptionPreset("highlighter").style,
      1080,
      1920,
    )
      .split("\n")
      .filter((line) => line.startsWith("Dialogue: 0"));

    // The middle stretch has nothing active; the words it draws are the same words, unspaced.
    const highlightTag = assColourTag(getCaptionPreset("highlighter").style.highlightColor);
    const withoutHighlight = events.find((event) => !event.includes(highlightTag))!;
    expect(withoutHighlight).toContain("PEACE STAYS");
  });
});

describe("weight", () => {
  it("renders a heavy caption bold", () => {
    const ass = generateAssSubtitles(LINES, { ...getCaptionPreset("clean").style, weight: 800 }, 1080, 1920);
    const styleLine = ass.split("\n").find((line) => line.startsWith("Style: Default"))!;
    expect(styleLine.split(",")[7]).toBe("-1");
  });

  it("renders a light caption unbold", () => {
    const ass = generateAssSubtitles(LINES, { ...getCaptionPreset("clean").style, weight: 300 }, 1080, 1920);
    const styleLine = ass.split("\n").find((line) => line.startsWith("Style: Default"))!;
    expect(styleLine.split(",")[7]).toBe("0");
  });
});
