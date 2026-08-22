import { describe, expect, it } from "vitest";
import { activeWordIndex, highlightSlices, resolveActiveWord } from "@/lib/editor/active-word";
import { buildCaptionLines, type CaptionLine, type CaptionWord } from "@/lib/editor/caption-lines";

const CLEAN: CaptionWord[] = [
  { id: "w0", word: "Peace", startMs: 0, endMs: 400 },
  { id: "w1", word: "stays", startMs: 400, endMs: 900 },
  { id: "w2", word: "with", startMs: 900, endMs: 1200 },
  { id: "w3", word: "us", startMs: 1200, endMs: 1600 },
];

/**
 * The shape real transcripts produce: word spans that run into each other. A naive `find` would
 * report whichever happens to come first in the array.
 */
const OVERLAPPING: CaptionWord[] = [
  { id: "a", word: "Grace", startMs: 0, endMs: 700 },
  { id: "b", word: "abounds", startMs: 500, endMs: 1200 },
  { id: "c", word: "toward", startMs: 1000, endMs: 1400 },
  { id: "d", word: "us", startMs: 1100, endMs: 1800 },
];

function lineOf(words: CaptionWord[]): CaptionLine {
  return {
    id: "line-0",
    startMs: Math.min(...words.map((w) => w.startMs)),
    endMs: Math.max(...words.map((w) => w.endMs)),
    words,
    text: words.map((w) => w.word).join(" "),
  };
}

/** Every whole millisecond across a line, so nothing hides between the cases picked by hand. */
function sweep(words: CaptionWord[], stepMs = 1): number[] {
  const start = Math.min(...words.map((w) => w.startMs));
  const end = Math.max(...words.map((w) => w.endMs));
  const stamps: number[] = [];
  for (let ms = start; ms < end; ms += stepMs) stamps.push(ms);
  return stamps;
}

describe("resolveActiveWord", () => {
  it("finds the word being spoken", () => {
    expect(resolveActiveWord(CLEAN, 500)?.id).toBe("w1");
  });

  it("includes a word's own start instant", () => {
    expect(resolveActiveWord(CLEAN, 400)?.id).toBe("w1");
  });

  it("excludes a word's end instant, so a boundary belongs to exactly one word", () => {
    expect(resolveActiveWord(CLEAN, 900)?.id).toBe("w2");
  });

  it("returns nothing before the first word", () => {
    expect(resolveActiveWord(CLEAN, -1)).toBeNull();
  });

  it("returns nothing after the last word", () => {
    expect(resolveActiveWord(CLEAN, 1600)).toBeNull();
  });

  it("returns nothing for an empty line", () => {
    expect(resolveActiveWord([], 100)).toBeNull();
  });

  it("returns nothing in a silent gap between words", () => {
    const gapped: CaptionWord[] = [
      { id: "x", word: "one", startMs: 0, endMs: 200 },
      { id: "y", word: "two", startMs: 900, endMs: 1100 },
    ];
    expect(resolveActiveWord(gapped, 500)).toBeNull();
  });
});

describe("overlapping source intervals", () => {
  it("picks the word that started most recently", () => {
    // 600ms falls inside both "Grace" (0-700) and "abounds" (500-1200).
    expect(resolveActiveWord(OVERLAPPING, 600)?.id).toBe("b");
  });

  it("picks the most recent of three overlapping words", () => {
    // 1150ms falls inside "abounds", "toward" and "us" at once.
    expect(resolveActiveWord(OVERLAPPING, 1150)?.id).toBe("d");
  });

  it("never returns two words for one timestamp", () => {
    for (const ms of sweep(OVERLAPPING)) {
      const active = resolveActiveWord(OVERLAPPING, ms);
      const containing = OVERLAPPING.filter((w) => ms >= w.startMs && ms < w.endMs);
      if (containing.length === 0) {
        expect(active).toBeNull();
      } else {
        expect(active).not.toBeNull();
        // Whatever it chose, it chose one — and one that genuinely covers the instant.
        expect(containing.map((w) => w.id)).toContain(active!.id);
      }
    }
  });

  it("is stable: the same timestamp always resolves to the same word", () => {
    for (const ms of sweep(OVERLAPPING, 17)) {
      const first = resolveActiveWord(OVERLAPPING, ms)?.id ?? null;
      const shuffled = [...OVERLAPPING].reverse();
      expect(resolveActiveWord(shuffled, ms)?.id ?? null).toBe(first);
    }
  });

  it("breaks a same-start tie on the shorter word, not on array order", () => {
    const tied: CaptionWord[] = [
      { id: "long", word: "aaa", startMs: 0, endMs: 900 },
      { id: "short", word: "bbb", startMs: 0, endMs: 300 },
    ];
    expect(resolveActiveWord(tied, 100)?.id).toBe("short");
    expect(resolveActiveWord([...tied].reverse(), 100)?.id).toBe("short");
  });

  it("covers every instant a word covers, leaving no unhighlighted hole inside speech", () => {
    for (const ms of sweep(OVERLAPPING)) {
      expect(resolveActiveWord(OVERLAPPING, ms)).not.toBeNull();
    }
  });
});

describe("activeWordIndex", () => {
  it("gives the active word's position in the line", () => {
    expect(activeWordIndex(CLEAN, 1000)).toBe(2);
  });

  it("gives -1 when no word is active", () => {
    expect(activeWordIndex(CLEAN, 5000)).toBe(-1);
  });
});

describe("highlightSlices", () => {
  it("cuts a clean line at each word boundary", () => {
    const slices = highlightSlices(lineOf(CLEAN));
    expect(slices.map((s) => s.activeWordId)).toEqual(["w0", "w1", "w2", "w3"]);
  });

  it("covers the line end to end with no gap and no overlap", () => {
    const line = lineOf(OVERLAPPING);
    const slices = highlightSlices(line);
    expect(slices[0].startMs).toBe(line.startMs);
    expect(slices[slices.length - 1].endMs).toBe(line.endMs);
    for (let i = 1; i < slices.length; i += 1) {
      expect(slices[i].startMs).toBe(slices[i - 1].endMs);
    }
  });

  it("merges neighbouring stretches that highlight the same word", () => {
    const slices = highlightSlices(lineOf(OVERLAPPING));
    const ids = slices.map((s) => s.activeWordId);
    for (let i = 1; i < ids.length; i += 1) {
      expect(ids[i]).not.toBe(ids[i - 1]);
    }
  });

  it("keeps a stretch with nothing highlighted when the line has a silent gap", () => {
    const gapped = lineOf([
      { id: "x", word: "one", startMs: 0, endMs: 200 },
      { id: "y", word: "two", startMs: 900, endMs: 1100 },
    ]);
    expect(highlightSlices(gapped).map((s) => s.activeWordId)).toEqual(["x", null, "y"]);
  });

  it("emits nothing for a line with no words", () => {
    expect(
      highlightSlices({ id: "line-0", startMs: 0, endMs: 0, words: [], text: "" }),
    ).toEqual([]);
  });
});

describe("the preview and the burn-in cannot disagree", () => {
  it("every slice reports the word the preview would highlight at that instant", () => {
    const line = lineOf(OVERLAPPING);
    for (const slice of highlightSlices(line)) {
      // Sample inside the slice, including right at its start.
      for (const ms of [slice.startMs, (slice.startMs + slice.endMs) / 2, slice.endMs - 1]) {
        const previewChoice = resolveActiveWord(line.words, ms)?.id ?? null;
        expect(previewChoice).toBe(slice.activeWordId);
      }
    }
  });

  it("agrees at every millisecond of a line built the way the editor builds them", () => {
    const line = buildCaptionLines(OVERLAPPING, { maxWordsPerLine: 10 })[0];
    const slices = highlightSlices(line);
    for (const ms of sweep(line.words)) {
      const previewChoice = resolveActiveWord(line.words, ms)?.id ?? null;
      const slice = slices.find((s) => ms >= s.startMs && ms < s.endMs);
      expect(slice?.activeWordId ?? null).toBe(previewChoice);
    }
  });
});
