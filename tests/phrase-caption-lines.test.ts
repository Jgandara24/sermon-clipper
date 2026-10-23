import { describe, expect, it } from "vitest";
import { captionLineId, type CaptionWord } from "@/lib/editor/caption-lines";
import { buildPhraseCaptionLines, PHRASE_MAX_WORDS } from "@/lib/editor/phrase-caption-lines";
import first from "./fixtures/p4-approved-caption-input.json";
import second from "./fixtures/p4-second-approved-caption-input.json";

/**
 * Jake's caption rule (Codex session, 2026-10-06): "Do you notice how i want the caption lines
 * segments to be well represented of an actually thought / phrase and not split in half? Correct
 * Example: "not to guess about him" Incorrect Example: 1st segment > "not to guess about" 2nd
 * segment > "him, but to know him"."
 *
 * The answer key is the 16 lines he approved line by line with Codex on 2026-09-29 and 2026-10-05
 * (branch codex/p4-sermon-understanding, tests/fixtures/p4-*approved-caption-state.ts). The words
 * are the Scribe words Codex saved with them.
 */
type Recording = typeof first;
function words(recording: Recording, fixes: Record<string, string> = {}): CaptionWord[] {
  return recording.segments.flatMap((segment, s) =>
    segment.words.map((word, w) => ({
      id: `${s}:${w}`,
      word: fixes[`${s}:${w}`] ?? word.word,
      startMs: word.startMs - recording.sourceRangeMs[0],
      endMs: word.endMs - recording.sourceRangeMs[0],
    })),
  );
}

// Two capital letters in the approved lines were typed by hand in the Codex session ("And" after
// a line that did not end a sentence, "His" for God). The transcript has them in lower case, and
// the lab keeps the transcript's own case, so these two lines compare in that case.
const HAND_CAPITALS: Record<string, string> = {
  "And he'll draw near to you": "and he'll draw near to you",
  "through faith in His Son": "through faith in his Son",
};
const asTranscribed = (line: string) => HAND_CAPITALS[line] ?? line;

// Recording 1 (source 2453240-2469240). Jake's word fix: Scribe heard "They're"; he says "You're".
const APPROVED_FIRST = [
  "You're the one that determines",
  "the level of your relationship with God",
  "not God",
  "Therefore, draw near to God",
  "And he'll draw near to you",
  "Did you get it?",
  "Did you get it?",
];

// Recording 2 (source 3845282-3863282), with Jake's approved times on the clip's clock.
const APPROVED_SECOND: [number, number, string][] = [
  [70, 1770, "This is the triune God"],
  [1800, 4600, "that invites you into his family"],
  [4700, 7200, "not to guess about him"],
  [7200, 8400, "but to know him"],
  [8700, 10300, "to know him personally"],
  [10310, 11900, "to not earn his love"],
  [12100, 13900, "but to receive it freely"],
  [14100, 16000, "and to receive it freely"],
  [16100, 17830, "through faith in His Son"],
];

describe("buildPhraseCaptionLines matches Jake's 16 approved caption lines", () => {
  it("groups recording 1 into his 7 lines", () => {
    const lines = buildPhraseCaptionLines(words(first, { "0:0": "You're" }));
    expect(lines.map((line) => line.text)).toEqual(APPROVED_FIRST.map(asTranscribed));
  });

  it("groups recording 2 into his 9 lines", () => {
    // The last line holds "his Son." too: Codex's cut ended mid-sentence, before those two words.
    // A lab clip now always ends on a whole sentence.
    const lines = buildPhraseCaptionLines(words(second));
    expect(lines.map((line) => line.text)).toEqual(APPROVED_SECOND.map(([, , text]) => asTranscribed(text)));
  });

  it("shows each line within half a second of the time he approved", () => {
    // Recording 2 only. In recording 1, Codex moved the first three lines 0.7 s earlier by ear,
    // because Scribe's times were late there; no rule on word times can reproduce that.
    const lines = buildPhraseCaptionLines(words(second));
    lines.forEach((line, index) => {
      expect(Math.abs(line.startMs - APPROVED_SECOND[index][0])).toBeLessThanOrEqual(500);
    });
  });
});

describe("buildPhraseCaptionLines rules", () => {
  const at = (text: string, gapsMs: number[] = []): CaptionWord[] => {
    let t = 0;
    return text.split(" ").map((word, index) => {
      t += gapsMs[index] ?? 0;
      const w = { id: `w${index}`, word, startMs: t, endMs: t + 250 };
      t += 250;
      return w;
    });
  };
  const texts = (input: CaptionWord[]) => buildPhraseCaptionLines(input).map((line) => line.text);

  it("never ends a line on a word that leads into the rest of its phrase", () => {
    const lines = texts(at("He wants to wash your feet and he wants to restore you because he loves you."));
    expect(lines).toEqual(["He wants to wash your feet", "and he wants to restore you", "because he loves you"]);
  });

  it("keeps at most seven words on a line, and splits a long sentence where the phrases allow", () => {
    // Lab sermon 1d clip 1, Scribe's words.
    const lines = texts(at("Now, folks, Jesus makes it very clear here that he's doing this as a symbolic act because that bath referred to salvation."));
    expect(lines).toEqual([
      "Now, folks",
      "Jesus makes it very clear here",
      "that he's doing this",
      "as a symbolic act",
      "because that bath referred to salvation",
    ]);
    for (const line of lines) expect(line.split(" ").length).toBeLessThanOrEqual(PHRASE_MAX_WORDS);
  });

  it("does not leave one word on its own after a comma, and lets a one-word sentence stand", () => {
    expect(texts(at("Yes, sir. Amen. Hallelujah."))).toEqual(["Yes, sir", "Amen", "Hallelujah"]);
  });

  it("drops a comma or period that ends a line, keeps a question mark, and keeps a closing quote mark", () => {
    expect(texts(at('Would you be willing? He said, "Go, and sin no more."'))).toEqual([
      "Would you be willing?",
      "He said",
      '"Go, and sin no more"',
    ]);
  });

  it("starts a new line at a pause of 0.7 s or more inside a sentence", () => {
    expect(texts(at("God's grace can make you firm today", [0, 0, 900]))).toEqual(["God's grace", "can make you firm today"]);
  });

  it("does not start a line at a pause that would end the line on a joining word", () => {
    expect(texts(at("He wants to wash your feet", [0, 0, 0, 900]))).toEqual(["He wants to wash your feet"]);
  });

  it("starts a line when he starts the phrase and holds it until the next line starts", () => {
    const input = at("He wants to wash your feet. He wants to restore you.", [0, 0, 0, 0, 0, 0, 400]);
    const lines = buildPhraseCaptionLines(input);
    expect(lines[0]).toMatchObject({ startMs: 0, endMs: input[6].startMs });
    expect(lines[1].startMs).toBe(input[6].startMs);
  });

  it("ends a line 0.3 s after its last word when a pause of 1 s or more follows", () => {
    const input = at("He wants to wash your feet. He wants to restore you.", [0, 0, 0, 0, 0, 0, 1_500]);
    const lines = buildPhraseCaptionLines(input);
    expect(lines[0].endMs).toBe(input[5].endMs + 300);
  });

  it("never runs the last line past the end of the clip, and never overlaps two lines", () => {
    const input = at("He wants to wash your feet. Amen.");
    const lines = buildPhraseCaptionLines(input, { endLimitMs: input[6].endMs + 100 });
    expect(lines.at(-1)!.endMs).toBe(input[6].endMs + 100);
    const overlapping = [{ id: "a", word: "Amen.", startMs: 0, endMs: 900 }, { id: "b", word: "Hallelujah.", startMs: 600, endMs: 1_200 }];
    const [one, two] = buildPhraseCaptionLines(overlapping);
    expect(one.endMs).toBeLessThanOrEqual(two.startMs);
  });

  it("names each line by its words, so a text fix still finds its line", () => {
    const input = at("Yes, sir. Amen.");
    const lines = buildPhraseCaptionLines(input);
    expect(lines[0].id).toBe(captionLineId(input.slice(0, 2)));
    expect(lines[0].words.map((w) => w.id)).toEqual(["w0", "w1"]);
  });
});

describe("buildPhraseCaptionLines with a stammer", () => {
  it("reads a comma after a joining word as a stammer, not the end of a phrase", () => {
    // Lab sermon 3b clip 4, Scribe's words: "...get the raise at, at your job if you don't take that drink,"
    let t = 0;
    const input = "Are you afraid you won't get the raise at, at your job if you don't take that drink, if you don't go to that party?"
      .split(" ")
      .map((word, index) => ({ id: `w${index}`, word, startMs: (t += 300) - 300, endMs: t - 50 }));
    const lines = buildPhraseCaptionLines(input).map((line) => line.text);
    expect(lines).not.toContain("the raise at");
    for (const line of lines) expect(line).not.toMatch(/\bat$/);
  });
});
