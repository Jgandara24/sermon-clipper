import { describe, expect, it } from "vitest";
import { detectScriptureReferences } from "@/lib/analysis/scripture";

describe("detectScriptureReferences", () => {
  it("normalizes explicit verse references", () => {
    const refs = detectScriptureReferences("Jesus says this in John 3:16 and Paul returns to it in Romans 8:28.");

    expect(refs.map((ref) => ref.normalized)).toEqual(["John 3:16", "Romans 8:28"]);
    expect(refs[0]).toMatchObject({
      book: "John",
      chapterStart: 3,
      verseStart: 16,
      confidence: 0.92,
    });
  });

  it("normalizes spoken book-and-chapter references", () => {
    const refs = detectScriptureReferences("Turn with me to the book of John, chapter fourteen.");

    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      detectedText: "book of John, chapter fourteen",
      normalized: "John 14",
      book: "John",
      chapterStart: 14,
      verseStart: null,
    });
  });

  it("deduplicates the same normalized reference", () => {
    const refs = detectScriptureReferences("John 3:16 reminds us. Later, John 3:16 comes back.");

    expect(refs.map((ref) => ref.normalized)).toEqual(["John 3:16"]);
  });
});
