import { describe, expect, it } from "vitest";
import { CLIP_TITLE_WORD_TARGET, countTitleWords, isTitleOverTarget } from "@/lib/editor/clip-title";

describe("countTitleWords", () => {
  it("counts words, however they are spaced", () => {
    expect(countTitleWords("Closeness Is a Choice")).toBe(4);
    expect(countTitleWords("  Grace   upon  grace ")).toBe(3);
    expect(countTitleWords("Grace\nupon\tgrace")).toBe(3);
  });

  it("is zero for nothing at all", () => {
    expect(countTitleWords("")).toBe(0);
    expect(countTitleWords("   ")).toBe(0);
  });

  it("counts a hyphenated phrase as the one word it is written as", () => {
    expect(countTitleWords("God-given rest")).toBe(2);
  });
});

describe("isTitleOverTarget", () => {
  it("is content with the target and anything under it", () => {
    expect(isTitleOverTarget("One two three four five")).toBe(false);
    expect(isTitleOverTarget("Peace stays with us")).toBe(false);
    expect(CLIP_TITLE_WORD_TARGET).toBe(5);
  });

  it("flags a longer one without refusing it", () => {
    // Every clip generated before this rule has a longer title, and a church may want one.
    expect(isTitleOverTarget("Closeness to God Is a Choice, Not a Birthright")).toBe(true);
  });
});
