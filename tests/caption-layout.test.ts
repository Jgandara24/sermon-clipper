import { describe, expect, it } from "vitest";
import { layOutCaptionLine, type CaptionLayoutWord } from "@/lib/editor/caption-layout";

/** A measurer with no font behind it: every character is ten pixels wide. */
const tenPerChar = (text: string) => text.length * 10;

const SPACE_WIDTH = 10;

function line(...texts: string[]): CaptionLayoutWord[] {
  return texts.map((text, index) => ({ id: `w${index}`, text }));
}

function layout(words: CaptionLayoutWord[], activeWordId: string | null, peakScale = 1.2) {
  return layOutCaptionLine({
    words,
    measure: tenPerChar,
    spaceWidth: SPACE_WIDTH,
    activeWordId,
    peakScale,
  });
}

/** Left and right edge of a word as drawn, at a given scale. */
function extent(center: number, width: number, scale: number) {
  return { left: center - (width * scale) / 2, right: center + (width * scale) / 2 };
}

describe("layOutCaptionLine at rest", () => {
  it("lays a line out centred on zero, with one space between words", () => {
    const result = layout(line("ab", "cde"), null);

    // widths 20 and 30, one 10px space: 60 wide, so the line runs -30..+30.
    expect(result.restWidth).toBe(60);
    expect(result.words[0].width).toBe(20);
    expect(result.words[1].width).toBe(30);
    expect(result.words[0].restX).toBe(-20);
    expect(result.words[1].restX).toBe(15);
  });

  it("leaves exactly the space width between neighbouring words", () => {
    const result = layout(line("ab", "cde", "f"), null);

    for (let index = 0; index < result.words.length - 1; index += 1) {
      const left = result.words[index];
      const right = result.words[index + 1];
      const gap =
        right.restX - right.width / 2 - (left.restX + left.width / 2);
      expect(gap).toBeCloseTo(SPACE_WIDTH, 10);
    }
  });

  it("centres a single word on zero", () => {
    const result = layout(line("only"), null);

    expect(result.restX(result.words[0].id)).toBe(0);
    expect(result.restWidth).toBe(40);
  });

  it("returns an empty layout for a line with no words", () => {
    const result = layout([], null);

    expect(result.words).toEqual([]);
    expect(result.restWidth).toBe(0);
  });

  it("lays the line out the same way whichever word is active", () => {
    // The guarantee Slice 7 established and Slice 8 must not spend: rest spacing is never
    // widened to reserve room for a pop.
    const none = layout(line("ab", "cde", "f"), null);
    const middle = layout(line("ab", "cde", "f"), "w1");

    expect(middle.words.map((word) => word.restX)).toEqual(none.words.map((word) => word.restX));
    expect(middle.restWidth).toBe(none.restWidth);
  });
});

describe("layOutCaptionLine while a word is popped", () => {
  it("does not move anything when no word is active", () => {
    const result = layout(line("ab", "cde", "f"), null);

    for (const word of result.words) {
      expect(word.shiftedX).toBe(word.restX);
    }
  });

  it("does not move anything when the pop has no scale to it", () => {
    const result = layout(line("ab", "cde", "f"), "w1", 1);

    for (const word of result.words) {
      expect(word.shiftedX).toBe(word.restX);
    }
  });

  it("leaves the active word where it is, so it scales about its own centre", () => {
    const result = layout(line("ab", "cde", "f"), "w1");
    const active = result.words[1];

    expect(active.shiftedX).toBe(active.restX);
  });

  it("moves everything left of the active word left, and everything right of it right", () => {
    const result = layout(line("ab", "cde", "f"), "w1");
    // The active word is 30 wide and grows by 20%, so it needs 3px of clearance a side.
    const clearance = (1.2 - 1) * 30 / 2;

    expect(result.words[0].shiftedX).toBeCloseTo(result.words[0].restX - clearance, 10);
    expect(result.words[2].shiftedX).toBeCloseTo(result.words[2].restX + clearance, 10);
  });

  it("moves a whole side together, so a neighbour never lands on the word beyond it", () => {
    // Shifting only the immediate neighbours would close the gap between them and the next word
    // out. Every word on a side moves by the same amount, so every gap on that side is preserved.
    const result = layout(line("aa", "bb", "cc", "dd", "ee"), "w2");
    const clearance = (1.2 - 1) * 20 / 2;

    expect(result.words[0].shiftedX).toBeCloseTo(result.words[0].restX - clearance, 10);
    expect(result.words[1].shiftedX).toBeCloseTo(result.words[1].restX - clearance, 10);
    expect(result.words[3].shiftedX).toBeCloseTo(result.words[3].restX + clearance, 10);
    expect(result.words[4].shiftedX).toBeCloseTo(result.words[4].restX + clearance, 10);
  });

  it("keeps every word clear of its neighbours at the peak of the pop", () => {
    for (const activeIndex of [0, 1, 2, 3, 4]) {
      const result = layout(line("aa", "bbbb", "cc", "d", "eeeee"), `w${activeIndex}`, 1.35);

      for (let index = 0; index < result.words.length - 1; index += 1) {
        const left = result.words[index];
        const right = result.words[index + 1];
        const leftExtent = extent(left.shiftedX, left.width, left.id === `w${activeIndex}` ? 1.35 : 1);
        const rightExtent = extent(right.shiftedX, right.width, right.id === `w${activeIndex}` ? 1.35 : 1);
        expect(rightExtent.left).toBeGreaterThanOrEqual(leftExtent.right);
      }
    }
  });

  it("does not move a line of one word, which has no neighbour to clear", () => {
    const result = layout(line("only"), "w0", 1.4);

    expect(result.words[0].shiftedX).toBe(result.words[0].restX);
  });

  it("ignores an active word id that is not on this line", () => {
    const result = layout(line("ab", "cde"), "not-here");

    for (const word of result.words) {
      expect(word.shiftedX).toBe(word.restX);
    }
  });
});

describe("layOutCaptionLine measures the text it is given", () => {
  it("asks the measurer for each word exactly once", () => {
    const seen: string[] = [];
    layOutCaptionLine({
      words: line("ab", "cde"),
      measure: (text) => {
        seen.push(text);
        return tenPerChar(text);
      },
      spaceWidth: SPACE_WIDTH,
      activeWordId: null,
      peakScale: 1.2,
    });

    expect(seen).toEqual(["ab", "cde"]);
  });

  it("carries the text it measured, so the caller draws the string that was measured", () => {
    const result = layout(line("PEACE", "IS"), null);

    expect(result.words.map((word) => word.text)).toEqual(["PEACE", "IS"]);
  });
});
